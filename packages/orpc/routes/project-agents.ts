import { ORPCError } from '@orpc/server'
import {
  ACTIVE_RUN_STATUSES,
  createRootRun,
  finishRun,
  listProjectAgents,
  reactivateProject,
  startProjectAgent,
  stopProjectAgent,
  TEAM_LEAD_AGENT_TYPE,
  type TaskSpec,
} from '@repo/agent/orchestration'
import {
  and,
  db,
  eq,
  inArray,
  isNull,
  project,
  run,
  task,
  taskMessage,
} from '@repo/database'
import {
  dispatchOrchestratorRun,
  enableProjectHeartbeatSchedule,
} from '@repo/queue'
import * as z from 'zod'

import { authorized } from '../context'

/**
 * Project agent routes: start/stop the persona orchestrators on a project
 * and talk to the project's Team Lead. Live status reaches the UI via
 * Electric SQL (`project_agent` shape), so there is no status polling route —
 * these are command endpoints only (plus a snapshot list for SSR/fallback).
 */

/**
 * Read access: projects are platform-visible, so any authenticated user may
 * view a project's roster and Team Lead thread. Only existence is checked.
 */
async function getVisibleProject(projectId: string) {
  const row = await db.query.project.findFirst({
    where: eq(project.id, projectId),
  })
  if (!row) {
    throw new ORPCError('NOT_FOUND', { message: 'Project not found' })
  }
  return row
}

/**
 * Command access (start/stop agents, message the Team Lead) stays restricted
 * to the project owner.
 */
async function getOwnedProject(projectId: string, userId: string) {
  const row = await db.query.project.findFirst({
    where: and(eq(project.id, projectId), eq(project.ownerId, userId)),
  })
  if (!row) {
    // Same response whether the project is missing or someone else's.
    throw new ORPCError('NOT_FOUND', { message: 'Project not found' })
  }
  return row
}

export const listAgents = authorized
  .route({
    method: 'GET',
    path: '/projects/{projectId}/agents',
    tags: ['Projects'],
    description:
      "Snapshot of the project's agents with live state and last results. The UI keeps this fresh via Electric sync; this route serves the initial load.",
  })
  .input(z.object({ projectId: z.string().uuid() }))
  .handler(async ({ input }) => {
    await getVisibleProject(input.projectId)
    const agents = await listProjectAgents(input.projectId)
    return { agents }
  })

export const startAgent = authorized
  .route({
    method: 'POST',
    path: '/projects/{projectId}/agents/{agentId}/start',
    tags: ['Projects'],
    description:
      "Start a project agent: auto-briefs it from the project's seed hypothesis + persona prompt, creates its root orchestrator run, and enqueues it.",
  })
  .input(
    z.object({
      projectId: z.string().uuid(),
      agentId: z.string().uuid(),
      extraInstructions: z.string().max(10_000).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    await getOwnedProject(input.projectId, context.user.id)

    const result = await startProjectAgent({
      projectId: input.projectId,
      agentId: input.agentId,
      extraInstructions: input.extraInstructions,
      enqueue: async (runId) => {
        await dispatchOrchestratorRun({ runId, reason: 'start' })
      },
    })

    if (!result.ok) {
      throw new ORPCError('CONFLICT', { message: result.reason })
    }

    // Starting an agent resumes paused or completed research. Paused
    // projects keep their heartbeat configuration; completed projects also
    // re-enable the schedule that conclusion disabled. No-op when active.
    await reactivateProject({
      projectId: input.projectId,
      enableSchedule: enableProjectHeartbeatSchedule,
    })

    return { runId: result.runId }
  })

export const stopAgent = authorized
  .route({
    method: 'POST',
    path: '/projects/{projectId}/agents/{agentId}/stop',
    tags: ['Projects'],
    description:
      'Stop a working project agent: cancels its root run and all in-flight descendants, and returns the roster flag to idle.',
  })
  .input(
    z.object({
      projectId: z.string().uuid(),
      agentId: z.string().uuid(),
    }),
  )
  .handler(async ({ input, context }) => {
    await getOwnedProject(input.projectId, context.user.id)

    const result = await stopProjectAgent({
      projectId: input.projectId,
      agentId: input.agentId,
    })

    if (!result.ok) {
      throw new ORPCError('NOT_FOUND', { message: result.reason })
    }
    return { cancelledRuns: result.cancelledRuns }
  })

export const sendLeadMessage = authorized
  .route({
    method: 'POST',
    path: '/projects/{projectId}/lead/send',
    tags: ['Projects'],
    description:
      "Send a message to the project's Team Lead: lazily creates the lead chat thread, persists the user message, and enqueues a team-lead run. The reply arrives via the Electric-synced task messages.",
  })
  .input(
    z.object({
      projectId: z.string().uuid(),
      message: z.string().min(1).max(50_000),
    }),
  )
  .handler(async ({ input, context }) => {
    const projectRow = await getOwnedProject(input.projectId, context.user.id)

    // Lazily create the persistent lead thread on first message. The
    // project update is guarded on `leadTaskId IS NULL` so two concurrent
    // first messages converge on one thread instead of orphaning a run.
    let leadTaskId = projectRow.leadTaskId
    if (leadTaskId) {
      const existing = await db.query.task.findFirst({
        where: eq(task.id, leadTaskId),
      })
      if (!existing || existing.deletedAt) leadTaskId = null
    }
    if (!leadTaskId) {
      const [thread] = await db
        .insert(task)
        .values({
          title: `Team Lead — ${projectRow.name}`,
          agent: TEAM_LEAD_AGENT_TYPE,
          userId: context.user.id,
        })
        .returning()
      if (!thread) {
        throw new ORPCError('INTERNAL_SERVER_ERROR', {
          message: 'Failed to create lead thread',
        })
      }
      const [claimed] = await db
        .update(project)
        .set({ leadTaskId: thread.id })
        .where(
          and(eq(project.id, input.projectId), isNull(project.leadTaskId)),
        )
        .returning({ leadTaskId: project.leadTaskId })
      if (claimed) {
        leadTaskId = thread.id
      } else {
        // Lost the creation race — use the winner's thread, drop ours.
        await db.delete(task).where(eq(task.id, thread.id))
        const current = await db.query.project.findFirst({
          where: eq(project.id, input.projectId),
          columns: { leadTaskId: true },
        })
        leadTaskId = current?.leadTaskId ?? null
        if (!leadTaskId) {
          throw new ORPCError('INTERNAL_SERVER_ERROR', {
            message: 'Failed to resolve lead thread',
          })
        }
      }
    }

    // One turn at a time: concurrent lead runs on the same thread would both
    // load the same task.agentHistory and the second save would erase the
    // first turn from the lead's memory (StreamRuntime does a blind write).
    const activeTurn = await db.query.run.findFirst({
      where: and(
        eq(run.taskId, leadTaskId),
        eq(run.agentType, TEAM_LEAD_AGENT_TYPE),
        inArray(run.status, ACTIVE_RUN_STATUSES),
      ),
      columns: { id: true },
    })
    if (activeTurn) {
      throw new ORPCError('CONFLICT', {
        message: 'The Team Lead is still working on the previous message.',
      })
    }

    const spec: TaskSpec = {
      title: 'Team lead turn',
      instructions: input.message,
    }

    const root = await createRootRun({
      agentType: TEAM_LEAD_AGENT_TYPE,
      input: spec,
      taskId: leadTaskId,
      projectId: input.projectId,
    })

    // Persist the user message immediately so it renders before the worker
    // picks the run up (the agent loop intentionally skips re-persisting it).
    // metadata.runId lets the UI tail this run's durable stream — including
    // recovering the live stream after a reload mid-run.
    await db.insert(taskMessage).values({
      role: 'user',
      content: { type: 'text', text: input.message },
      metadata: { runId: root.id },
      taskId: leadTaskId,
    })

    await db
      .update(task)
      .set({ status: 'running' })
      .where(eq(task.id, leadTaskId))

    try {
      await dispatchOrchestratorRun({ runId: root.id, reason: 'start' })
    } catch (error) {
      // Compensate: nothing will ever pick this run up (the sweeper only
      // rescues claimed runs), so fail it and unstick the chat spinner.
      await finishRun(root.id, {
        status: 'failed',
        summary: 'Failed to enqueue the team-lead run.',
      })
      await db
        .update(task)
        .set({ status: 'failed' })
        .where(eq(task.id, leadTaskId))
      throw error
    }

    return { runId: root.id, taskId: leadTaskId }
  })

export const getLeadThread = authorized
  .route({
    method: 'GET',
    path: '/projects/{projectId}/lead',
    tags: ['Projects'],
    description:
      "The project's Team Lead thread id (null until the first message) plus its persisted messages for initial render.",
  })
  .input(z.object({ projectId: z.string().uuid() }))
  .handler(async ({ input }) => {
    const projectRow = await getVisibleProject(input.projectId)
    if (!projectRow.leadTaskId) {
      return { taskId: null, messages: [] }
    }

    const messages = await db.query.taskMessage.findMany({
      where: eq(taskMessage.taskId, projectRow.leadTaskId),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    })

    return {
      taskId: projectRow.leadTaskId,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        metadata: m.metadata,
        createdAt: m.createdAt,
      })),
    }
  })
