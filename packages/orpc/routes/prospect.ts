import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import {
  BedrockAgentCoreControlClient,
  GetHarnessCommand,
} from '@aws-sdk/client-bedrock-agentcore-control'
import { ORPCError } from '@orpc/server'
import { TaskStreamWriter } from '@repo/agent'
import {
  and,
  asc,
  db,
  eq,
  isNull,
  projectMessage,
  projectSession,
} from '@repo/database'
import { type Message, eventTypes } from '@repo/streams-protocol'
import * as z from 'zod'

import { authorized } from '../context'

const HARNESS_ARN = process.env.PROJECT_PROSPECT_HARNESS_ARN ?? ''
const STREAMS_URL = process.env.STREAMS_URL ?? 'http://localhost:4437'

// AgentCore Gateway attached per invocation as a remote_mcp tool so each call
// can carry the project-scoped x-project-id header. Auth is a Cognito
// client-credentials (M2M) token — no user identity involved.
const GATEWAY_URL = process.env.AGENTCORE_GATEWAY_URL ?? ''
const GATEWAY_M2M_CLIENT_ID = process.env.GATEWAY_M2M_CLIENT_ID ?? ''
const GATEWAY_M2M_CLIENT_SECRET = process.env.GATEWAY_M2M_CLIENT_SECRET ?? ''
const GATEWAY_OAUTH_SCOPE = process.env.GATEWAY_OAUTH_SCOPE ?? ''
const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN ?? ''

let cachedClient: BedrockAgentCoreClient | null = null

function getClient(): BedrockAgentCoreClient {
  cachedClient ??= new BedrockAgentCoreClient({
    customUserAgent: process.env.USER_AGENT_STRING,
  })
  return cachedClient
}

let cachedGatewayToken: { token: string; expiresAt: number } | null = null

/**
 * Mint (and cache until ~expiry) a client-credentials access token for the
 * gateway. The token represents the platform, not a user — project scoping
 * travels separately in the x-project-id header.
 */
async function getGatewayToken(): Promise<string> {
  const now = Date.now()
  // 60s clock-skew margin so we never hand the harness a token that expires
  // mid-conversation turn.
  if (cachedGatewayToken && cachedGatewayToken.expiresAt - 60_000 > now) {
    return cachedGatewayToken.token
  }

  const response = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(
        `${GATEWAY_M2M_CLIENT_ID}:${GATEWAY_M2M_CLIENT_SECRET}`,
      ).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: GATEWAY_OAUTH_SCOPE,
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Gateway token request failed (${response.status}): ${detail}`)
  }

  const data = (await response.json()) as { access_token: string; expires_in: number }
  cachedGatewayToken = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  }
  return data.access_token
}

/**
 * Build the per-invocation tool list: the harness's built-in browser plus the
 * gateway as a remote_mcp tool carrying the project id. remote_mcp is the only
 * harness tool type that supports custom headers, which is how the gateway
 * propagates x-project-id to its Lambda targets (allowlisted in the gateway
 * stack). Returns undefined when the gateway isn't configured (e.g. local dev
 * without infra), which leaves the harness's default tools untouched.
 */
async function buildHarnessTools(projectId: string) {
  if (!GATEWAY_URL || !GATEWAY_M2M_CLIENT_ID || !COGNITO_DOMAIN) return undefined

  const token = await getGatewayToken()
  return [
    { type: 'agentcore_browser' as const, name: 'browser' },
    {
      type: 'remote_mcp' as const,
      name: 'gateway',
      config: {
        remoteMcp: {
          url: GATEWAY_URL,
          headers: {
            Authorization: `Bearer ${token}`,
            'x-project-id': projectId,
          },
        },
      },
    },
  ]
}

async function getOrCreateSession(projectId: string): Promise<string> {
  const existing = await db.query.projectSession.findFirst({
    where: eq(projectSession.projectId, projectId),
  })
  if (existing) return existing.id

  const [created] = await db
    .insert(projectSession)
    .values({ projectId })
    .returning({ id: projectSession.id })
  return created!.id
}

function toHarnessMessages(messages: { role: string; content: string }[]) {
  return messages.map((msg) => ({
    role: msg.role as 'user' | 'assistant',
    content: [{ text: msg.content }],
  }))
}

export const prospectHistory = authorized
  .route({
    method: 'GET',
    path: '/projects/{id}/prospect/history',
    tags: ['Prospect'],
    description: 'Fetch the prospect conversation history for a project.',
  })
  .input(z.object({ id: z.string().min(1) }))
  .handler(async ({ input }) => {
    const session = await db.query.projectSession.findFirst({
      where: eq(projectSession.projectId, input.id),
      with: {
        messages: {
          orderBy: (m, { asc }) => [asc(m.createdAt)],
        },
      },
    })

    if (!session) {
      return { messages: [], activeRunId: null }
    }

    return {
      messages: session.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
      activeRunId: session.activeRunId,
    }
  })

let cachedControlClient: BedrockAgentCoreControlClient | null = null
function getControlClient(): BedrockAgentCoreControlClient {
  cachedControlClient ??= new BedrockAgentCoreControlClient({
    customUserAgent: process.env.USER_AGENT_STRING,
  })
  return cachedControlClient
}

const HarnessTool = z.object({
  type: z.string(),
  name: z.string().nullable(),
})

const HarnessInfo = z.object({
  harnessName: z.string(),
  consoleUrl: z.string().nullable(),
  status: z.string(),
  harnessVersion: z.string().nullable(),
  modelId: z.string().nullable(),
  tools: z.array(HarnessTool),
  maxIterations: z.number().nullable(),
  maxTokens: z.number().nullable(),
  timeoutSeconds: z.number().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
})

const ProspectHarness = z.object({
  configured: z.boolean(),
  harness: HarnessInfo.nullable(),
})

// Harness config is effectively static between deploys; cache the control
// plane response briefly so opening the popover doesn't hammer GetHarness.
let cachedHarnessInfo: {
  value: z.infer<typeof ProspectHarness>
  expiresAt: number
} | null = null

export const prospectHarness = authorized
  .route({
    method: 'GET',
    path: '/prospect/harness',
    tags: ['Prospect'],
    description:
      'Describe the AgentCore harness backing the Project Prospect agent (via the bedrock-agentcore-control GetHarness API).',
  })
  .input(z.object({}))
  .output(ProspectHarness)
  .handler(async () => {
    // Local dev without deployed infra: nothing to describe.
    if (!HARNESS_ARN) return { configured: false, harness: null }

    const now = Date.now()
    if (cachedHarnessInfo && cachedHarnessInfo.expiresAt > now) {
      return cachedHarnessInfo.value
    }

    // Harness ARN: arn:aws:bedrock-agentcore:<region>:<account>:harness/<harnessId>
    const harnessId = HARNESS_ARN.split('/').pop()
    if (!harnessId) return { configured: false, harness: null }
    const region = HARNESS_ARN.split(':')[3] || null

    const { harness } = await getControlClient().send(
      new GetHarnessCommand({ harnessId }),
    )
    if (!harness) return { configured: true, harness: null }

    // The model config is a union keyed by provider; surface whichever
    // provider's modelId is present.
    const model = harness.model
    const modelId =
      model?.bedrockModelConfig?.modelId ??
      model?.openAiModelConfig?.modelId ??
      model?.geminiModelConfig?.modelId ??
      model?.liteLlmModelConfig?.modelId ??
      null

    const value: z.infer<typeof ProspectHarness> = {
      configured: true,
      harness: {
        harnessName: harness.harnessName ?? '',
        consoleUrl: region
          ? `https://${region}.console.aws.amazon.com/bedrock-agentcore/harnesses/${harness.harnessId ?? harnessId}`
          : null,
        status: harness.status ?? 'UNKNOWN',
        harnessVersion: harness.harnessVersion ?? null,
        modelId,
        tools: (harness.tools ?? []).map((tool) => ({
          type: tool.type ?? 'unknown',
          name: tool.name ?? null,
        })),
        maxIterations: harness.maxIterations ?? null,
        maxTokens: harness.maxTokens ?? null,
        timeoutSeconds: harness.timeoutSeconds ?? null,
        createdAt: harness.createdAt?.toISOString() ?? null,
        updatedAt: harness.updatedAt?.toISOString() ?? null,
      },
    }

    cachedHarnessInfo = { value, expiresAt: now + 5 * 60_000 }
    return value
  })

export const prospectChat = authorized
  .route({
    method: 'POST',
    path: '/projects/{id}/prospect/chat',
    tags: ['Prospect'],
    description:
      'Send a message to the project prospect agent. Returns a runId for streaming.',
  })
  .input(
    z.object({
      id: z.string().min(1),
      message: z.string().min(1),
    }),
  )
  .handler(async ({ input }) => {
    const sessionId = await getOrCreateSession(input.id)
    const runId = crypto.randomUUID()

    // Claim the session and load the exact history for this turn in one
    // transaction. Only one prospect invocation may use a harness session at
    // a time; otherwise runs can overwrite the replay pointer and reorder the
    // shared conversation history.
    const history = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(projectSession)
        .set({ activeRunId: runId })
        .where(
          and(
            eq(projectSession.id, sessionId),
            isNull(projectSession.activeRunId),
          ),
        )
        .returning({ id: projectSession.id })

      if (!claimed) {
        throw new ORPCError('CONFLICT', {
          message: 'The prospect agent is still working on the previous message.',
        })
      }

      await tx.insert(projectMessage).values({
        sessionId,
        role: 'user',
        content: input.message,
      })

      return tx
        .select({
          role: projectMessage.role,
          content: projectMessage.content,
        })
        .from(projectMessage)
        .where(eq(projectMessage.sessionId, sessionId))
        .orderBy(asc(projectMessage.createdAt))
    })

    invokeAndStream(sessionId, runId, input.id, history).catch((err) => {
      console.error('[prospect] invoke error:', err)
    })

    return { runId }
  })

async function invokeAndStream(
  sessionId: string,
  runId: string,
  projectId: string,
  history: { role: string; content: string }[],
) {
  const writer = new TaskStreamWriter(STREAMS_URL, runId)

  const base: Pick<Message, 'taskId' | 'runId'> = {
    taskId: projectId,
    runId,
  }

  // Declared outside the try so the error path can still persist whatever the
  // agent managed to say before failing. The durable stream is not a fallback:
  // it is unreadable after this turn ends because the only pointer to it
  // (`projectSession.activeRunId`) is cleared here, so this accumulator is the
  // sole copy of the reply.
  let fullText = ''

  await writer.append({
    ...base,
    event_type: eventTypes.START,
    data: {
      runId,
      userMessage: history[history.length - 1]?.content ?? '',
    },
  })

  try {
    const command = new InvokeHarnessCommand({
      harnessArn: HARNESS_ARN,
      runtimeSessionId: sessionId,
      messages: toHarnessMessages(history),
      tools: await buildHarnessTools(projectId),
    })

    const response = await getClient().send(command)

    // Per-content-block bookkeeping, keyed by contentBlockIndex. In the
    // harness stream contract, `contentBlockStart` is exclusively a
    // toolUse/toolResult announcement (HarnessContentBlockStart is a
    // two-member union) — text blocks never get a start event, so text is
    // opened lazily on its first delta.
    type BlockInfo =
      | { kind: 'text'; started: boolean; streamId: string }
      | { kind: 'toolUse'; toolUseId: string }
      | { kind: 'toolResult'; toolUseId: string }
    const blocks = new Map<number, BlockInfo>()
    // contentBlockIndex restarts at 0 for EVERY message in the agent's loop
    // (text → tool → text again), so it cannot be the text part id — the
    // consumer would merge later text into the first block and every tool
    // chip would sink below the text. Mint a unique id per text block
    // instance instead.
    let textBlockSeq = 0

    if (response.stream) {
      for await (const event of response.stream) {
        if ('messageStart' in event) {
          // Agent message starting
        } else if ('contentBlockStart' in event) {
          const idx = event.contentBlockStart?.contentBlockIndex ?? 0
          const start = event.contentBlockStart?.start
          if (start && 'toolUse' in start && start.toolUse) {
            // The harness is calling a tool (gateway MCP tool or the managed
            // browser). Surface it so the UI can show a tool chip.
            const toolCallId = start.toolUse.toolUseId ?? `block-${idx}`
            blocks.set(idx, { kind: 'toolUse', toolUseId: toolCallId })
            await writer.append({
              ...base,
              event_type: eventTypes.TOOL_INPUT_START,
              toolCallId,
              toolName: start.toolUse.name ?? 'tool',
            })
          } else if (start && 'toolResult' in start && start.toolResult) {
            // Tool finished; flip the chip to completed. Result payloads are
            // not rendered, so the status is all the UI needs.
            const toolCallId = start.toolResult.toolUseId ?? `block-${idx}`
            blocks.set(idx, { kind: 'toolResult', toolUseId: toolCallId })
            await writer.append({
              ...base,
              event_type: eventTypes.TOOL_RESULT,
              toolCallId,
              output: { status: start.toolResult.status ?? 'success' },
            })
          }
        } else if ('contentBlockDelta' in event) {
          const idx = event.contentBlockDelta?.contentBlockIndex ?? 0
          const delta = event.contentBlockDelta?.delta
          if (delta && 'text' in delta && delta.text) {
            let info = blocks.get(idx)
            if (!info) {
              info = { kind: 'text', started: false, streamId: `text-${textBlockSeq++}` }
              blocks.set(idx, info)
            }
            if (info.kind !== 'text') continue
            if (!info.started) {
              info.started = true
              await writer.append({
                ...base,
                event_type: eventTypes.TEXT_START,
                id: info.streamId,
              })
            }
            fullText += delta.text
            await writer.append({
              ...base,
              event_type: eventTypes.TEXT_DELTA,
              id: info.streamId,
              delta: delta.text,
            })
          } else if (delta && 'toolUse' in delta && delta.toolUse?.input) {
            const info = blocks.get(idx)
            if (info?.kind === 'toolUse') {
              await writer.append({
                ...base,
                event_type: eventTypes.TOOL_INPUT_DELTA,
                toolCallId: info.toolUseId,
                inputTextDelta: delta.toolUse.input,
              })
            }
          }
          // toolResult deltas / metadata: not rendered; the TOOL_RESULT
          // status event was already emitted at the block start.
        } else if ('contentBlockStop' in event) {
          const idx = event.contentBlockStop?.contentBlockIndex ?? 0
          const info = blocks.get(idx)
          if (info?.kind === 'text' && info.started) {
            await writer.append({
              ...base,
              event_type: eventTypes.TEXT_END,
              id: info.streamId,
            })
          }
          // Indexes restart per message, so clear finished blocks.
          blocks.delete(idx)
        } else if ('messageStop' in event) {
          // Message complete
        } else if ('metadata' in event) {
          const usage = event.metadata?.usage
          if (usage) {
            await writer.append({
              ...base,
              event_type: eventTypes.METRICS,
              data: {
                runCost: '0',
                runDurationMs: event.metadata?.metrics?.latencyMs ?? 0,
                inputTokens: usage.inputTokens ?? 0,
                outputTokens: usage.outputTokens ?? 0,
                cacheReadTokens: usage.cacheReadInputTokens ?? 0,
                cacheWriteTokens: usage.cacheWriteInputTokens ?? 0,
              },
            })
          }
        }
      }
    }

    // Persist the final transcript and retire its replay pointer atomically
    // before publishing successful completion. A reload therefore sees either
    // the active durable stream or the persisted assistant message, and the
    // stream cannot claim success if the database commit failed.
    await db.transaction(async (tx) => {
      if (fullText) {
        await tx.insert(projectMessage).values({
          sessionId,
          role: 'assistant',
          content: fullText,
        })
      }
      await tx
        .update(projectSession)
        .set({ activeRunId: null })
        .where(
          and(
            eq(projectSession.id, sessionId),
            eq(projectSession.activeRunId, runId),
          ),
        )
    })

    await writer.append({
      ...base,
      event_type: eventTypes.FINISH,
      data: { runId, reason: 'complete' },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'

    // A failed turn used to discard `fullText` entirely, so a mid-stream
    // failure (e.g. Bedrock InternalServerException after retries) erased
    // every token the user had already watched arrive: no assistant row was
    // written, and the `finally` below cleared the replay pointer, leaving
    // the user's message in the history with no answer after a reload.
    // Persist the partial reply on the same terms as the success path —
    // atomically with retiring the pointer, and before publishing the
    // failure, so a reload always sees either the live stream or the row.
    try {
      await db.transaction(async (tx) => {
        if (fullText) {
          await tx.insert(projectMessage).values({
            sessionId,
            role: 'assistant',
            content: fullText,
          })
        }
        await tx
          .update(projectSession)
          .set({ activeRunId: null })
          .where(
            and(
              eq(projectSession.id, sessionId),
              eq(projectSession.activeRunId, runId),
            ),
          )
      })
    } catch (persistErr) {
      // Never let a persistence failure stop the ERROR/FINISH events below —
      // without them the client spins on a stream that will never close.
      console.error(
        `[prospect] run ${runId}: failed to persist partial reply:`,
        persistErr,
      )
    }

    // The catch swallows the failure into the stream, so without this the
    // turn leaves no trace in the service logs at all.
    console.error(
      `[prospect] run ${runId} failed after ${fullText.length} chars:`,
      err,
    )

    await writer.append({
      ...base,
      event_type: eventTypes.ERROR,
      data: { message },
    })
    await writer.append({
      ...base,
      event_type: eventTypes.FINISH,
      data: { runId, reason: 'error' },
    })
  } finally {
    // Clear only our own pointer. If another turn has already started, its
    // run id must remain available for reload recovery.
    try {
      await db
        .update(projectSession)
        .set({ activeRunId: null })
        .where(
          and(
            eq(projectSession.id, sessionId),
            eq(projectSession.activeRunId, runId),
          ),
        )
    } finally {
      await writer.close()
    }
  }
}
