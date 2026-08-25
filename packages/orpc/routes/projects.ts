import { ORPCError } from '@orpc/server'
import * as z from 'zod'

import {
  agent,
  and,
  db,
  eq,
  gte,
  lt,
  project,
  projectAgent,
  run,
  sql,
} from '@repo/database'

import {
  deleteProjectEpistemicGraph,
  seedProjectEpistemicHypothesis,
} from '@repo/graph'

import {
  createProjectHeartbeatSchedule,
  deleteProjectHeartbeatSchedule,
  getProjectHeartbeat as readHeartbeatSchedule,
  updateProjectHeartbeat as writeHeartbeatSchedule,
} from '@repo/queue'

import { authorized } from '../context'
import {
  createProjectRuntime,
  deleteProjectRuntime,
} from './agentcore-runtime-shared'
import {
  createProjectAccessPoint,
  deleteProjectAccessPoint,
} from './s3files-shared'

function deriveName(question: string): string {
  const trimmed = question.trim().replace(/\s+/g, ' ')
  if (!trimmed) return 'Untitled project'
  return trimmed.length <= 60 ? trimmed : `${trimmed.slice(0, 57)}…`
}

type ProjectWithAgents = typeof project.$inferSelect & {
  projectAgents: Array<{ agent: typeof agent.$inferSelect }>
}

/** Map a project row (with joined agents) to the shape the UI consumes. */
function toProjectDto(row: ProjectWithAgents) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    seedHypothesis: row.seedHypothesis,
    objective: row.objective,
    checkInCadence: row.checkInCadence,
    leadModel: row.leadModel,
    leadSystemPrompt: row.leadSystemPrompt,
    maxBudgetUsd: row.maxBudgetUsd,
    budgetExceededAt: row.budgetExceededAt?.toISOString() ?? null,
    leadTaskId: row.leadTaskId,
    flags: row.flags,
    contextNotes: row.contextNotes,
    createdAt: row.createdAt.toISOString(),
    agents: row.projectAgents
      .map(({ agent: a }) => ({
        id: a.id,
        displayName: a.displayName,
        description: a.description ?? '',
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  }
}

/**
 * Create a draft project from the user's opening question. The question seeds
 * the hypothesis; budget and cadence are refined on the /projects/create
 * intake screen before the project is activated.
 */
export const createProject = authorized
  .route({
    method: 'POST',
    path: '/projects',
    tags: ['Projects'],
    description:
      "Create a draft project from the user's opening question. Requires authentication.",
  })
  .input(z.object({ question: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const [created] = await db
      .insert(project)
      .values({
        name: deriveName(input.question),
        seedHypothesis: input.question,
        status: 'draft',
        ownerId: context.user.id,
      })
      .returning({ id: project.id })

    return { id: created!.id }
  })

/** Count of projects currently in the "active" state (platform-wide). */
export const activeProjectCount = authorized
  .route({
    method: 'GET',
    path: '/projects/active-count',
    tags: ['Projects'],
    description:
      'Count of projects currently in the "active" state (platform-wide). Requires authentication.',
  })
  .input(z.object({}))
  .handler(async () => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(project)
      .where(eq(project.status, 'active'))
    return { count: row?.count ?? 0 }
  })

export const listProjects = authorized
  .route({
    method: 'GET',
    path: '/projects',
    tags: ['Projects'],
    description: 'List all projects with their assigned agents. Requires authentication.',
  })
  .input(z.object({}))
  .handler(async () => {
    const rows = await db.query.project.findMany({
      orderBy: (p, { desc }) => [desc(p.createdAt)],
      with: { projectAgents: { with: { agent: true } } },
    })

    return rows.map(toProjectDto)
  })

/**
 * Cursor-paginated list of projects, most-recent first, for the sidebar. Unlike
 * `listProjects` this returns a lightweight shape (no agent joins) plus a
 * `nextCursor` the client passes back to load the next page.
 */
export const listRecentProjects = authorized
  .route({
    method: 'GET',
    path: '/projects/recent',
    tags: ['Projects'],
    description:
      'Cursor-paginated list of projects, most recent first. Requires authentication.',
  })
  .input(
    z.object({
      limit: z.number().int().min(1).max(50).default(15),
      // Opaque cursor: the ISO createdAt of the last item from the prior page.
      cursor: z.string().nullish(),
    }),
  )
  .handler(async ({ input }) => {
    const cursorDate = input.cursor ? new Date(input.cursor) : null

    const rows = await db.query.project.findMany({
      // Fetch one extra row to detect whether another page exists.
      limit: input.limit + 1,
      where: cursorDate ? lt(project.createdAt, cursorDate) : undefined,
      orderBy: (p, { desc }) => [desc(p.createdAt)],
      columns: { id: true, name: true, status: true, createdAt: true },
    })

    const hasMore = rows.length > input.limit
    const page = hasMore ? rows.slice(0, input.limit) : rows
    const last = page.at(-1)

    return {
      items: page.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
    }
  })

/** Fetch a project (with its assigned agents) mapped to the shape the UI consumes. */
export const getProject = authorized
  .route({
    method: 'GET',
    path: '/projects/{id}',
    tags: ['Projects'],
    description:
      'Fetch a project (with its assigned agents). Requires authentication.',
  })
  .input(z.object({ id: z.string().min(1) }))
  .handler(async ({ input }) => {
    const row = await db.query.project.findFirst({
      where: eq(project.id, input.id),
      with: { projectAgents: { with: { agent: true } } },
    })

    if (!row) {
      throw new ORPCError('NOT_FOUND', { message: 'Project not found' })
    }

    return toProjectDto(row)
  })

/**
 * Persist intake details (name, budget, cadence), settings (lead model /
 * system prompt, budget cap), and the assigned agents for a project. Links
 * existing agents by ID; the project's assignment is replaced with the
 * provided set.
 */
export const updateProject = authorized
  .route({
    method: 'PATCH',
    path: '/projects/{id}',
    tags: ['Projects'],
    description:
      'Update project details (name, description, cadence, lead model, budget cap) and assigned agents. Requires authentication.',
  })
  .input(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1).optional(),
      seedHypothesis: z.string().min(1).optional(),
      checkInCadence: z.string().optional(),
      leadModel: z.string().optional(),
      leadSystemPrompt: z.string().max(10000).nullable().optional(),
      // The budget cap can be adjusted but never removed (no null).
      maxBudgetUsd: z.number().positive().optional(),
      agentIds: z.array(z.string().uuid()).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const { id, agentIds, ...fields } = input

    // Only the owner may update; same NOT_FOUND either way to avoid leaking
    // other users' project ids.
    const owned = await db.query.project.findFirst({
      where: and(eq(project.id, id), eq(project.ownerId, context.user.id)),
      columns: { id: true, maxBudgetUsd: true },
    })
    if (!owned) {
      throw new ORPCError('NOT_FOUND', { message: 'Project not found' })
    }

    await db.transaction(async (tx) => {
      if (Object.keys(fields).length > 0) {
        // Raising or removing the cap clears the exceeded flag so agents can
        // be restarted (the worker re-stamps it if spend still exceeds).
        const budgetChanged =
          'maxBudgetUsd' in fields &&
          fields.maxBudgetUsd !== owned.maxBudgetUsd
        await tx
          .update(project)
          .set(budgetChanged ? { ...fields, budgetExceededAt: null } : fields)
          .where(eq(project.id, id))
      }

      if (agentIds !== undefined) {
        // Replace the project's agent assignments with the provided set.
        await tx.delete(projectAgent).where(eq(projectAgent.projectId, id))
        if (agentIds.length > 0) {
          await tx
            .insert(projectAgent)
            .values(agentIds.map((agentId) => ({ projectId: id, agentId })))
        }
      }
    })

    return { id }
  })

/**
 * Aggregated spend + usage metrics for a project, powering the Metrics tab.
 * All numbers come from the durable run counters (incremented per segment),
 * so they reflect real cost even for multi-segment orchestrator runs.
 */
export const projectMetrics = authorized
  .route({
    method: 'GET',
    path: '/projects/{id}/metrics',
    tags: ['Projects'],
    description:
      'Aggregated spend and token usage metrics for a project. Requires authentication.',
  })
  .input(z.object({ id: z.string().min(1) }))
  .handler(async ({ input }) => {
    // Projects are platform-visible: any authenticated user may read metrics.
    const row = await db.query.project.findFirst({
      where: eq(project.id, input.id),
      columns: { id: true, maxBudgetUsd: true, budgetExceededAt: true },
    })
    if (!row) {
      throw new ORPCError('NOT_FOUND', { message: 'Project not found' })
    }

    const [totalsRow] = await db
      .select({
        spendUsd: sql<number>`coalesce(sum(${run.costUsd}), 0)::float8`,
        inputTokens: sql<number>`coalesce(sum(${run.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${run.outputTokens}), 0)::int`,
        cacheReadTokens: sql<number>`coalesce(sum(${run.cacheReadTokens}), 0)::int`,
        cacheWriteTokens: sql<number>`coalesce(sum(${run.cacheWriteTokens}), 0)::int`,
        totalRuns: sql<number>`count(*)::int`,
        succeededRuns: sql<number>`count(*) filter (where ${run.status} = 'succeeded')::int`,
        failedRuns: sql<number>`count(*) filter (where ${run.status} = 'failed')::int`,
        cancelledRuns: sql<number>`count(*) filter (where ${run.status} = 'cancelled')::int`,
        activeRuns: sql<number>`count(*) filter (where ${run.status} in ('pending', 'planning', 'running', 'waiting_on_children'))::int`,
      })
      .from(run)
      .where(eq(run.projectId, input.id))

    // Bucket by the day the spend landed (finishedAt for terminal runs,
    // createdAt otherwise), last 30 days.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    since.setHours(0, 0, 0, 0)
    const dayExpr = sql<string>`to_char(date_trunc('day', coalesce(${run.finishedAt}, ${run.createdAt})), 'YYYY-MM-DD')`
    const daily = await db
      .select({
        date: dayExpr,
        costUsd: sql<number>`coalesce(sum(${run.costUsd}), 0)::float8`,
        inputTokens: sql<number>`coalesce(sum(${run.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${run.outputTokens}), 0)::int`,
        cacheReadTokens: sql<number>`coalesce(sum(${run.cacheReadTokens}), 0)::int`,
      })
      .from(run)
      .where(
        and(
          eq(run.projectId, input.id),
          gte(sql`coalesce(${run.finishedAt}, ${run.createdAt})`, since),
        ),
      )
      .groupBy(dayExpr)
      .orderBy(dayExpr)

    // Spend per agentType, with a display name from the catalog when the
    // type matches an agent id (orchestrator/lead rows keep the raw type).
    const byAgent = await db
      .select({
        agentType: run.agentType,
        displayName: sql<string | null>`max(${agent.displayName})`,
        costUsd: sql<number>`coalesce(sum(${run.costUsd}), 0)::float8`,
        runs: sql<number>`count(*)::int`,
      })
      .from(run)
      .leftJoin(agent, eq(sql`${agent.id}::text`, run.agentType))
      .where(eq(run.projectId, input.id))
      .groupBy(run.agentType)
      .orderBy(sql`sum(${run.costUsd}) desc`)

    return {
      maxBudgetUsd: row.maxBudgetUsd,
      budgetExceededAt: row.budgetExceededAt?.toISOString() ?? null,
      totals: totalsRow ?? {
        spendUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalRuns: 0,
        succeededRuns: 0,
        failedRuns: 0,
        cancelledRuns: 0,
        activeRuns: 0,
      },
      daily,
      byAgent,
    }
  })

/** Flip a draft project to active — "Activate research". */
export const activateProject = authorized
  .route({
    method: 'POST',
    path: '/projects/{id}/activate',
    tags: ['Projects'],
    description: 'Flip a draft project to active — "Activate research". Requires authentication.',
  })
  .input(
    z.object({
      id: z.string().min(1),
      // IANA timezone the default 9am heartbeat is scheduled in (usually the
      // activating user's browser timezone). Adjustable later in settings.
      timezone: z.string().max(64).optional(),
    }),
  )
  .handler(async ({ input }) => {
    const row = await db.query.project.findFirst({
      where: eq(project.id, input.id),
      columns: {
        id: true,
        name: true,
        seedHypothesis: true,
        s3AccessPointArn: true,
        agentRuntimeArn: true,
        heartbeatScheduleArn: true,
      },
    })
    if (!row) {
      throw new ORPCError('NOT_FOUND', { message: 'Project not found' })
    }

    // Provision the project's S3 Files access point (its private view of
    // projects/{id}/ in the artifacts bucket). Idempotent, so re-activation
    // after a failure retries cleanly. Null when the environment has no
    // file system configured.
    let s3AccessPointArn = row.s3AccessPointArn
    if (!s3AccessPointArn) {
      try {
        s3AccessPointArn = await createProjectAccessPoint(input.id)
      } catch (error) {
        console.error(
          `[projects] access point creation failed for ${input.id}:`,
          error,
        )
        throw new ORPCError('INTERNAL_SERVER_ERROR', {
          message: 'Failed to provision project file storage',
        })
      }
    }

    // Provision the project's AgentCore runtime: the worker image with the
    // access point mounted at /mnt/files, so every agent in this project
    // shares the project-scoped file system. Also idempotent (client token
    // + name-conflict recovery). Null when the environment has no runtime
    // provisioning configured — dispatch falls back to the shared runtime.
    let agentRuntimeArn = row.agentRuntimeArn
    if (!agentRuntimeArn) {
      try {
        agentRuntimeArn = await createProjectRuntime(
          input.id,
          s3AccessPointArn,
        )
      } catch (error) {
        console.error(
          `[projects] runtime creation failed for ${input.id}:`,
          error,
        )
        throw new ORPCError('INTERNAL_SERVER_ERROR', {
          message: 'Failed to provision project agent runtime',
        })
      }
    }

    // Provision the project's heartbeat: an EventBridge Scheduler schedule
    // (default 9am daily in the activator's timezone) that pulses the Team
    // Lead to check on its agents. The schedule itself holds the heartbeat
    // config — the project only keeps the ARN. Idempotent (name embeds the
    // project id) and best-effort: a heartbeat failure shouldn't block
    // activation, and settings can recreate it later. Null when the
    // environment has no scheduler provisioning configured.
    let heartbeatScheduleArn = row.heartbeatScheduleArn
    if (!heartbeatScheduleArn) {
      try {
        heartbeatScheduleArn = await createProjectHeartbeatSchedule(input.id, {
          timezone: input.timezone,
        })
      } catch (error) {
        console.error(
          `[projects] heartbeat schedule creation failed for ${input.id}:`,
          error,
        )
      }
    }

    // Seed the hypothesis into the EPISTEMIC graph as the root :Hypothesis
    // node so it exists before any agent runs: agents' observations attach to
    // it via linkEvidence and the research loop turns on it. Written directly
    // here (freeform seed text = the claim) rather than via a Team Lead turn —
    // the lead can't be dispatched at activation (the project runtime is still
    // CREATING). Idempotent and best-effort: the graph may be unconfigured,
    // and a seeding failure shouldn't block activation.
    try {
      const seeded = await seedProjectEpistemicHypothesis({
        projectId: input.id,
        claim: row.seedHypothesis,
      })
      if (!seeded.seeded) {
        console.warn(
          `[projects] hypothesis seeding skipped for ${input.id}: ${seeded.reason}`,
        )
      }
    } catch (error) {
      console.error(
        `[projects] hypothesis seeding failed for ${input.id}:`,
        error,
      )
    }

    await db
      .update(project)
      .set({
        status: 'active',
        s3AccessPointArn,
        agentRuntimeArn,
        heartbeatScheduleArn,
      })
      .where(eq(project.id, input.id))

    return { id: input.id }
  })

/**
 * The project's heartbeat config, read live from its EventBridge Scheduler
 * schedule (the source of truth). Null when the project has no schedule
 * (draft, unprovisioned environment, or stopped by the Team Lead).
 */
export const getProjectHeartbeat = authorized
  .route({
    method: 'GET',
    path: '/projects/{id}/heartbeat',
    tags: ['Projects'],
    description:
      "The project's heartbeat schedule (daily Team Lead pulse check), read from EventBridge Scheduler. Requires authentication.",
  })
  .input(z.object({ id: z.string().min(1) }))
  .handler(async ({ input }) => {
    // Projects are platform-visible: any authenticated user may read the
    // heartbeat schedule. Changing it (PATCH below) stays owner-only.
    const row = await db.query.project.findFirst({
      where: eq(project.id, input.id),
      columns: { id: true, heartbeatScheduleArn: true },
    })
    if (!row) {
      throw new ORPCError('NOT_FOUND', { message: 'Project not found' })
    }
    if (!row.heartbeatScheduleArn) return { heartbeat: null }

    const heartbeat = await readHeartbeatSchedule(row.heartbeatScheduleArn)
    if (!heartbeat) {
      // The schedule is gone (deleted out of band) — drop the stale ARN so
      // the UI offers to re-enable instead of erroring.
      await db
        .update(project)
        .set({ heartbeatScheduleArn: null })
        .where(eq(project.id, input.id))
      return { heartbeat: null }
    }
    return { heartbeat }
  })

const HEARTBEAT_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Change the project's heartbeat (time of day, timezone, enabled state) by
 * updating its schedule in place — or recreate the schedule when the project
 * no longer has one (e.g. the Team Lead stopped it and the user wants the
 * pulses back).
 */
export const updateProjectHeartbeat = authorized
  .route({
    method: 'PATCH',
    path: '/projects/{id}/heartbeat',
    tags: ['Projects'],
    description:
      "Update the project's heartbeat schedule (daily Team Lead pulse check) on EventBridge Scheduler. Recreates the schedule if it was stopped. Requires authentication.",
  })
  .input(
    z.object({
      id: z.string().min(1),
      time: z
        .string()
        .regex(HEARTBEAT_TIME_RE, 'Expected a 24h time like "09:00"')
        .optional(),
      timezone: z.string().max(64).optional(),
      enabled: z.boolean().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const owned = await db.query.project.findFirst({
      where: and(eq(project.id, input.id), eq(project.ownerId, context.user.id)),
      columns: { id: true, status: true, heartbeatScheduleArn: true },
    })
    if (!owned) {
      throw new ORPCError('NOT_FOUND', { message: 'Project not found' })
    }

    // In-place update of the existing schedule.
    if (owned.heartbeatScheduleArn) {
      try {
        const heartbeat = await writeHeartbeatSchedule(
          owned.heartbeatScheduleArn,
          input,
        )
        return { heartbeat }
      } catch (error) {
        console.error(
          `[projects] heartbeat schedule update failed for ${input.id}:`,
          error,
        )
        throw new ORPCError('INTERNAL_SERVER_ERROR', {
          message: 'Failed to update the heartbeat schedule',
        })
      }
    }

    // No schedule (Team Lead stopped it, or activation-time creation
    // failed): recreate it for an active project.
    if (owned.status !== 'active') {
      throw new ORPCError('CONFLICT', {
        message: 'The heartbeat can only be configured on an active project',
      })
    }
    const scheduleArn = await createProjectHeartbeatSchedule(input.id, {
      time: input.time,
      timezone: input.timezone,
    })
    if (!scheduleArn) {
      throw new ORPCError('INTERNAL_SERVER_ERROR', {
        message: 'Heartbeat scheduling is not configured in this environment',
      })
    }
    await db
      .update(project)
      .set({ heartbeatScheduleArn: scheduleArn })
      .where(eq(project.id, input.id))
    const heartbeat = await readHeartbeatSchedule(scheduleArn)
    return { heartbeat }
  })

/** Permanently delete a project. Any authenticated user may delete. */
export const deleteProject = authorized
  .route({
    method: 'DELETE',
    path: '/projects/{id}',
    tags: ['Projects'],
    description: 'Permanently delete a project. Requires authentication.',
  })
  .input(z.object({ id: z.string().min(1) }))
  .handler(async ({ input }) => {
    // Look the row up first: the external resource deletes below run while
    // the record still exists, so if one fails the ARNs stay on the row for
    // a retry instead of being orphaned with no record of them.
    const row = await db.query.project.findFirst({
      where: eq(project.id, input.id),
      columns: {
        id: true,
        s3AccessPointArn: true,
        agentRuntimeArn: true,
        heartbeatScheduleArn: true,
      },
    })
    if (!row) {
      throw new ORPCError('NOT_FOUND', { message: 'Project not found' })
    }

    // Best-effort: tear down the project's external resources before the
    // record. Each SDK call is a fast control-plane request that marks the
    // resource for deletion, and every helper is idempotent
    // (already-deleted counts as success). The runtime goes before the
    // access point — it mounts through it. The objects under projects/{id}/
    // stay in the bucket (existing behavior).
    if (row.heartbeatScheduleArn) {
      await deleteProjectHeartbeatSchedule(row.heartbeatScheduleArn)
    }
    if (row.agentRuntimeArn) {
      await deleteProjectRuntime(row.agentRuntimeArn)
    }
    if (row.s3AccessPointArn) {
      await deleteProjectAccessPoint(row.s3AccessPointArn)
    }

    // Join rows in project_agent are removed by the FK cascade.
    await db.delete(project).where(eq(project.id, input.id))

    // Graph teardown is the slow step (four serial DETACH DELETE queries —
    // real deletion work, not a mark-for-deletion call) so it runs detached
    // instead of holding the response past the gateway timeout. It removes
    // the project's :Hypothesis/:Observation/:Decision nodes and :Infon
    // facts, leaving the shared entity/document substrate intact.
    // Best-effort and keyed only by project id, so a lost run can simply be
    // re-issued.
    void (async () => {
      const startedAt = Date.now()
      try {
        await deleteProjectEpistemicGraph({ projectId: input.id })
      } catch (error) {
        console.error(
          `[projects] graph teardown failed for ${input.id}:`,
          error,
        )
      } finally {
        console.info(
          `[projects] graph teardown for ${input.id} took ${Date.now() - startedAt}ms`,
        )
      }
    })()

    return { id: input.id }
  })
