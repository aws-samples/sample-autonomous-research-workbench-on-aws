import {
  BedrockAgentCoreClient,
  type CodeInterpreterResult,
  InvokeCodeInterpreterCommand,
  type ProgrammingLanguage,
  StartCodeInterpreterSessionCommand,
  StopCodeInterpreterSessionCommand,
  type ToolArguments,
  type ToolName,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  and,
  codeInterpreterSession,
  db,
  desc,
  eq,
} from "@repo/database";

/**
 * AWS Bedrock AgentCore Code Interpreter sandbox client.
 *
 * Provides a per-task code-execution sandbox the agent can use to generate and
 * run code or produce reports / PowerPoint / Word documents. Sessions are
 * tracked in the `CodeInterpreterSession` table so a task has at most one active
 * session at a time, and each session is requested with a 60-minute timeout
 * (mirrored by the row's `expiresAt`).
 *
 * Credentials are resolved via the standard AWS provider chain (env vars, shared
 * config, ECS task role), matching the Bedrock provider in `core/agent.ts`. The
 * region comes from the ambient AWS env (the worker task's own region).
 */

/**
 * The Code Interpreter resource to use. Defaults to the AWS-managed public
 * interpreter; set SANDBOX_CODE_INTERPRETER_ID to our custom VPC-enabled
 * interpreter (which can mount the S3 Files file system).
 */
const CODE_INTERPRETER_IDENTIFIER =
  process.env.SANDBOX_CODE_INTERPRETER_ID ?? "aws.codeinterpreter.v1";

/** Session lifetime in seconds (60 minutes). */
export const SESSION_TIMEOUT_SECONDS = 60 * 60;

let cachedClient: BedrockAgentCoreClient | null = null;

function getClient(): BedrockAgentCoreClient {
  cachedClient ??= new BedrockAgentCoreClient({
    customUserAgent: process.env.USER_AGENT_STRING,
  });
  return cachedClient;
}

export type ActiveSession = {
  id: string;
  sessionId: string;
  expiresAt: Date;
};

/**
 * Return the task's current active session, or null if none. Sessions whose
 * `expiresAt` has passed are lazily marked `expired` and treated as absent.
 */
export async function getActiveSession(
  taskId: string,
): Promise<ActiveSession | null> {
  const row = await db.query.codeInterpreterSession.findFirst({
    where: and(
      eq(codeInterpreterSession.taskId, taskId),
      eq(codeInterpreterSession.status, "active"),
    ),
    orderBy: [desc(codeInterpreterSession.createdAt)],
  });

  if (!row) {
    return null;
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    await db
      .update(codeInterpreterSession)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(codeInterpreterSession.id, row.id));
    return null;
  }

  return { id: row.id, sessionId: row.sessionId, expiresAt: row.expiresAt };
}

export type StartSessionResult = {
  sessionId: string;
  expiresAt: Date;
  /** True when an existing active session was reused instead of created. */
  reused: boolean;
};

/**
 * Start a sandbox session for the task, reusing the existing active session if
 * one is still valid. Only one active session exists per task at a time.
 */
export async function startSession(
  taskId: string,
): Promise<StartSessionResult> {
  const existing = await getActiveSession(taskId);
  if (existing) {
    return {
      sessionId: existing.sessionId,
      expiresAt: existing.expiresAt,
      reused: true,
    };
  }

  const response = await getClient().send(
    new StartCodeInterpreterSessionCommand({
      codeInterpreterIdentifier: CODE_INTERPRETER_IDENTIFIER,
      name: `task-${taskId}`,
      sessionTimeoutSeconds: SESSION_TIMEOUT_SECONDS,
    }),
  );

  const sessionId = response.sessionId;
  if (!sessionId) {
    throw new Error("StartCodeInterpreterSession returned no sessionId");
  }

  const expiresAt = new Date(Date.now() + SESSION_TIMEOUT_SECONDS * 1000);

  await db.insert(codeInterpreterSession).values({
    taskId,
    sessionId,
    status: "active",
    expiresAt,
  });

  return { sessionId, expiresAt, reused: false };
}

/**
 * Stop the task's active sandbox session (if any) and mark the row `stopped`.
 * Returns the stopped sessionId, or null when there was nothing to stop.
 */
export async function stopSession(taskId: string): Promise<string | null> {
  const active = await getActiveSession(taskId);
  if (!active) {
    return null;
  }

  await getClient().send(
    new StopCodeInterpreterSessionCommand({
      codeInterpreterIdentifier: CODE_INTERPRETER_IDENTIFIER,
      sessionId: active.sessionId,
    }),
  );

  await db
    .update(codeInterpreterSession)
    .set({ status: "stopped", updatedAt: new Date() })
    .where(eq(codeInterpreterSession.id, active.id));

  return active.sessionId;
}

export type InvokeResult = {
  /** Concatenated text output from the result content blocks. */
  text: string;
  /** Whether the result was flagged as an error by the sandbox. */
  isError: boolean;
  /** Process exit code, when the operation reports one. */
  exitCode?: number;
  /** Captured standard error, when present. */
  stderr?: string;
};

/**
 * Invoke a Code Interpreter tool against the task's active session, draining the
 * response stream into a single text result. Throws if the task has no active
 * session (the caller should start one first).
 */
export async function invoke(
  taskId: string,
  name: ToolName,
  args: ToolArguments,
): Promise<InvokeResult> {
  const active = await getActiveSession(taskId);
  if (!active) {
    throw new Error("No active sandbox session for this task");
  }

  const response = await getClient().send(
    new InvokeCodeInterpreterCommand({
      codeInterpreterIdentifier: CODE_INTERPRETER_IDENTIFIER,
      sessionId: active.sessionId,
      name,
      arguments: args,
    }),
  );

  const chunks: string[] = [];
  let isError = false;
  let exitCode: number | undefined;
  let stderr: string | undefined;

  if (response.stream) {
    for await (const event of response.stream) {
      const result: CodeInterpreterResult | undefined = event.result;
      if (!result) {
        continue;
      }

      if (result.isError) {
        isError = true;
      }

      for (const block of result.content ?? []) {
        if (typeof block.text === "string" && block.text.length > 0) {
          chunks.push(block.text);
        }
      }

      if (result.structuredContent) {
        const { exitCode: code, stderr: err } = result.structuredContent;
        if (typeof code === "number") {
          exitCode = code;
        }
        if (typeof err === "string" && err.length > 0) {
          stderr = err;
        }
      }
    }
  }

  return { text: chunks.join("\n"), isError, exitCode, stderr };
}

export type { ProgrammingLanguage };
