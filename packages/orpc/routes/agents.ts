import { ORPCError } from '@orpc/server'
import * as z from 'zod'

import { DEFAULT_TOOL_IDS, toolCatalog } from '@repo/agent/tools/catalog'
import {
  agent,
  agentSkill,
  agentSkillFile,
  and,
  count,
  db,
  desc,
  eq,
} from '@repo/database'

import { authorized } from '../context'

type AgentRow = typeof agent.$inferSelect

/** Map an agent row to the shape the UI consumes. */
function toAgentDto(row: AgentRow) {
  return {
    id: row.id,
    name: row.displayName,
    description: row.description ?? '',
    systemPrompt: row.systemPrompt,
    preferredModel: row.preferredModel,
    tools: row.tools,
    maxTokens: row.maxTokens,
    reasoningEnabled: row.reasoningEnabled,
    reasoningBudgetTokens: row.reasoningBudgetTokens,
    reasoningEffort: row.reasoningEffort,
    historyStrategy: row.historyStrategy,
    historyWindowSize: row.historyWindowSize,
    historyPerTurn: row.historyPerTurn,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export type AgentDto = ReturnType<typeof toAgentDto>

/**
 * Look up an agent by id. Agents are a single shared catalog, so any
 * authorized user can read, edit, or delete any agent.
 */
async function findAgent(id: string) {
  const row = await db.query.agent.findFirst({
    where: eq(agent.id, id),
  })
  if (!row) {
    throw new ORPCError('NOT_FOUND', { message: 'Agent not found' })
  }
  return row
}

export const listAgents = authorized
  .input(
    z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .default({ page: 1, pageSize: 20 }),
  )
  .handler(async ({ input }) => {
    const { page, pageSize } = input

    const [rows, [total]] = await Promise.all([
      db.query.agent.findMany({
        orderBy: [desc(agent.updatedAt)],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      db.select({ count: count() }).from(agent),
    ])

    const totalCount = total?.count ?? 0

    return {
      agents: rows.map(toAgentDto),
      pagination: {
        page,
        pageSize,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
      },
    }
  })

export const getAgent = authorized
  .input(z.object({ id: z.string().min(1) }))
  .handler(async ({ input }) => {
    const row = await findAgent(input.id)
    return { agent: toAgentDto(row) }
  })

export const createAgent = authorized
  .input(
    z.object({
      name: z.string().min(1).max(64),
      description: z.string().min(1).max(500),
    }),
  )
  .handler(async ({ input, context }) => {
    const [created] = await db
      .insert(agent)
      .values({
        displayName: input.name,
        description: input.description,
        tools: DEFAULT_TOOL_IDS,
        userId: context.user.id,
      })
      .returning({ id: agent.id })

    return { agentId: created!.id }
  })

export const updateAgent = authorized
  .input(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1).max(64).optional(),
      description: z.string().min(1).max(500).optional(),
      systemPrompt: z.string().max(10000).nullable().optional(),
      preferredModel: z.string().nullable().optional(),
      tools: z.array(z.string()).optional(),
      maxTokens: z.number().nullable().optional(),
      reasoningEnabled: z.boolean().nullable().optional(),
      reasoningBudgetTokens: z.number().nullable().optional(),
      reasoningEffort: z
        .enum(['max', 'high', 'medium', 'low'])
        .nullable()
        .optional(),
      historyStrategy: z.enum(['none', 'sliding-window']).optional(),
      historyWindowSize: z.number().min(1).max(200).optional(),
      historyPerTurn: z.boolean().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  )
  .handler(async ({ input }) => {
    const existing = await findAgent(input.id)

    const { id, name, metadata, ...fields } = input
    const [updated] = await db
      .update(agent)
      .set({
        ...fields,
        ...(name !== undefined && { displayName: name }),
        // Merge metadata rather than replacing so partial updates (e.g. orb
        // colors) don't clobber other keys.
        ...(metadata !== undefined && {
          metadata: {
            ...((existing.metadata ?? {}) as Record<string, unknown>),
            ...metadata,
          },
        }),
      })
      .where(eq(agent.id, id))
      .returning()

    return { agent: toAgentDto(updated!) }
  })

export const deleteAgent = authorized
  .input(z.object({ id: z.string().min(1) }))
  .handler(async ({ input }) => {
    await findAgent(input.id)
    await db.delete(agent).where(eq(agent.id, input.id))
    return { success: true }
  })

export const duplicateAgent = authorized
  .input(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1).max(64).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const source = await findAgent(input.id)

    const [created] = await db
      .insert(agent)
      .values({
        displayName: input.name ?? `${source.displayName} (Copy)`,
        description: source.description,
        systemPrompt: source.systemPrompt,
        preferredModel: source.preferredModel,
        tools: source.tools,
        maxTokens: source.maxTokens,
        reasoningEnabled: source.reasoningEnabled,
        reasoningBudgetTokens: source.reasoningBudgetTokens,
        reasoningEffort: source.reasoningEffort,
        historyStrategy: source.historyStrategy,
        historyWindowSize: source.historyWindowSize,
        historyPerTurn: source.historyPerTurn,
        metadata: source.metadata,
        userId: context.user.id,
      })
      .returning({ id: agent.id })

    return { agentId: created!.id }
  })

/** Static catalog of tool groups agents can enable (from @repo/agent). */
export const getToolCatalog = authorized.input(z.object({})).handler(() => {
  return { tools: toolCatalog, defaultToolIds: DEFAULT_TOOL_IDS }
})

// ── Skills ──

const MAX_SKILL_FILES = 100
const MAX_SKILL_FILE_SIZE = 512 * 1024 // 512 KB per file
const MAX_SKILL_TOTAL_SIZE = 2 * 1024 * 1024 // 2 MB per skill

const SkillFileInput = z.object({
  // Relative path inside the skill folder, e.g. "SKILL.md", "scripts/run.py".
  path: z
    .string()
    .min(1)
    .max(512)
    .refine(
      (p) =>
        !p.startsWith('/') &&
        !p.split('/').some((seg) => seg === '..' || seg === ''),
      { message: 'Invalid file path' },
    ),
  content: z.string().max(MAX_SKILL_FILE_SIZE),
})

/**
 * Parse the frontmatter-style `description:` line out of SKILL.md, falling
 * back to the first non-heading text line.
 */
function extractSkillDescription(skillMd: string | undefined): string | null {
  if (!skillMd) return null
  const descLine = skillMd.match(/^description:\s*(.+)$/m)
  if (descLine?.[1]) return descLine[1].trim().slice(0, 500)
  const firstText = skillMd
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('---'))
  return firstText ? firstText.slice(0, 500) : null
}

export const listSkills = authorized
  .input(z.object({ agentId: z.string().min(1) }))
  .handler(async ({ input }) => {
    await findAgent(input.agentId)

    const rows = await db.query.agentSkill.findMany({
      where: eq(agentSkill.agentId, input.agentId),
      orderBy: (s, { asc }) => [asc(s.name)],
      with: {
        files: {
          columns: { id: true, path: true, size: true },
          orderBy: (f, { asc }) => [asc(f.path)],
        },
      },
    })

    return {
      skills: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        files: row.files,
        totalSize: row.files.reduce((sum, f) => sum + f.size, 0),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    }
  })

export const getSkillFile = authorized
  .input(z.object({ agentId: z.string().min(1), fileId: z.string().min(1) }))
  .handler(async ({ input }) => {
    await findAgent(input.agentId)

    const file = await db.query.agentSkillFile.findFirst({
      where: eq(agentSkillFile.id, input.fileId),
      with: { skill: true },
    })
    if (!file || file.skill.agentId !== input.agentId) {
      throw new ORPCError('NOT_FOUND', { message: 'File not found' })
    }

    return {
      file: {
        id: file.id,
        path: file.path,
        content: file.content,
        size: file.size,
      },
    }
  })

/**
 * Upload a skill as a set of text files (a folder with a SKILL.md at its
 * root). Replaces any existing skill with the same name on this agent.
 */
export const uploadSkill = authorized
  .input(
    z.object({
      agentId: z.string().min(1),
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/, {
          message: 'Skill name contains invalid characters',
        }),
      files: z.array(SkillFileInput).min(1).max(MAX_SKILL_FILES),
    }),
  )
  .handler(async ({ input }) => {
    await findAgent(input.agentId)

    const encoder = new TextEncoder()
    const sized = input.files.map((f) => ({
      ...f,
      size: encoder.encode(f.content).length,
    }))

    const totalSize = sized.reduce((sum, f) => sum + f.size, 0)
    if (totalSize > MAX_SKILL_TOTAL_SIZE) {
      throw new ORPCError('BAD_REQUEST', {
        message: 'Skill exceeds the 2 MB size limit',
      })
    }

    const paths = new Set(sized.map((f) => f.path))
    if (paths.size !== sized.length) {
      throw new ORPCError('BAD_REQUEST', { message: 'Duplicate file paths' })
    }

    const skillMd = sized.find((f) => f.path === 'SKILL.md')
    const description = extractSkillDescription(skillMd?.content)

    const skillId = await db.transaction(async (tx) => {
      // Replace an existing skill with the same name.
      await tx
        .delete(agentSkill)
        .where(
          and(
            eq(agentSkill.agentId, input.agentId),
            eq(agentSkill.name, input.name),
          ),
        )

      const [created] = await tx
        .insert(agentSkill)
        .values({ agentId: input.agentId, name: input.name, description })
        .returning({ id: agentSkill.id })

      await tx.insert(agentSkillFile).values(
        sized.map((f) => ({
          skillId: created!.id,
          path: f.path,
          content: f.content,
          size: f.size,
        })),
      )

      return created!.id
    })

    return { skillId }
  })

export const deleteSkill = authorized
  .input(z.object({ agentId: z.string().min(1), skillId: z.string().min(1) }))
  .handler(async ({ input }) => {
    await findAgent(input.agentId)

    const deleted = await db
      .delete(agentSkill)
      .where(
        and(
          eq(agentSkill.id, input.skillId),
          eq(agentSkill.agentId, input.agentId),
        ),
      )
      .returning({ id: agentSkill.id })

    if (deleted.length === 0) {
      throw new ORPCError('NOT_FOUND', { message: 'Skill not found' })
    }
    return { success: true }
  })
