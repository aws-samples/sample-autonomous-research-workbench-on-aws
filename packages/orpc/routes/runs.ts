import { ORPCError } from '@orpc/server'
import {
  createRootRun,
  getPlanTasks,
  getRun,
  type TaskSpec,
} from '@repo/agent/orchestration'
import {
  and,
  asc,
  db,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  run,
  runEvent,
  task,
  taskMessage,
} from '@repo/database'
import { dispatchOrchestratorRun } from '@repo/queue'
import * as z from 'zod'

import { authorized } from '../context'

/**
 * Runs API — entrypoint into the multi-agent orchestration system.
 *
 * `start` creates the user-facing conversation thread (`task`), persists the
 * user message, creates the root orchestrator `run` row, and enqueues a
 * `{ runId }` pointer job. The worker does everything else; these routes only
 * read/write Postgres, so the API never blocks on agent work.
 */

/**
 * Verify the run exists, is a root run, and is viewable by the caller.
 * Project runs (persona agents, Team Lead turns) are platform-visible — any
 * authenticated user may inspect them. Personal task-thread runs remain
 * private to the thread's creator.
 */
async function getViewableRootRun(runId: string, userId: string) {
  const row = await getRun(runId)
  if (!row || row.parentRunId !== null) {
    throw new ORPCError('NOT_FOUND', { message: 'Run not found' })
  }
  // Runs attached to a project are visible to every signed-in user.
  if (row.projectId) {
    return row
  }
  if (row.taskId) {
    const thread = await db.query.task.findFirst({
      where: and(eq(task.id, row.taskId), isNull(task.deletedAt)),
    })
    if (!thread || (thread.userId && thread.userId !== userId)) {
      throw new ORPCError('NOT_FOUND', { message: 'Run not found' })
    }
  }
  return row
}

export const startRun = authorized
  .route({
    method: 'POST',
    path: '/runs',
    tags: ['Runs'],
    description:
      'Start an orchestrated multi-agent run: creates the conversation thread and root run, then enqueues it for the worker.',
  })
  .input(
    z.object({
      message: z.string().min(1).max(50_000),
      title: z.string().min(1).max(200).optional(),
      context: z.string().max(50_000).optional(),
      deadlineMinutes: z.number().int().min(1).max(240).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const title = input.title ?? input.message.slice(0, 80)

    const [thread] = await db
      .insert(task)
      .values({
        title,
        agent: 'orchestrator',
        userId: context.user.id,
      })
      .returning()
    if (!thread) {
      throw new ORPCError('INTERNAL_SERVER_ERROR', {
        message: 'Failed to create task thread',
      })
    }

    await db.insert(taskMessage).values({
      role: 'user',
      content: { type: 'text', text: input.message },
      taskId: thread.id,
    })

    const spec: TaskSpec = {
      title,
      instructions: input.message,
      context: input.context,
    }

    const root = await createRootRun({
      agentType: 'orchestrator',
      input: spec,
      taskId: thread.id,
      deadlineAt: input.deadlineMinutes
        ? new Date(Date.now() + input.deadlineMinutes * 60_000)
        : undefined,
    })

    await dispatchOrchestratorRun({ runId: root.id, reason: 'start' })

    return { runId: root.id, taskId: thread.id }
  })

export const getRunStatus = authorized
  .route({
    method: 'GET',
    path: '/runs/{runId}',
    tags: ['Runs'],
    description:
      'Get a root run with its plan tasks and the status of every child run.',
  })
  .input(z.object({ runId: z.string().uuid() }))
  .handler(async ({ input, context }) => {
    const root = await getViewableRootRun(input.runId, context.user.id)

    const plan = await getPlanTasks(root.id)
    const childIds = plan
      .map((t) => t.childRunId)
      .filter((id): id is string => id !== null)
    const children =
      childIds.length > 0
        ? await db.query.run.findMany({ where: inArray(run.id, childIds) })
        : []
    const childById = new Map(children.map((c) => [c.id, c]))

    return {
      run: {
        id: root.id,
        status: root.status,
        agentType: root.agentType,
        input: root.input,
        result: root.result,
        error: root.error,
        taskId: root.taskId,
        createdAt: root.createdAt,
        startedAt: root.startedAt,
        finishedAt: root.finishedAt,
      },
      plan: plan.map((t) => {
        const child = t.childRunId ? childById.get(t.childRunId) : undefined
        return {
          id: t.id,
          seq: t.seq,
          title: t.title,
          agentType: t.agentType,
          status: t.status,
          childRunId: t.childRunId,
          childStatus: child?.status ?? null,
          result: t.result,
          dependsOn: t.dependsOn,
        }
      }),
    }
  })

export const listRunEvents = authorized
  .route({
    method: 'GET',
    path: '/runs/{runId}/events',
    tags: ['Runs'],
    description:
      'List the append-only event log for a run tree (root + all descendants). Poll with afterId for incremental updates.',
  })
  .input(
    z.object({
      runId: z.string().uuid(),
      afterId: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(200),
    }),
  )
  .handler(async ({ input, context }) => {
    const root = await getViewableRootRun(input.runId, context.user.id)

    const events = await db.query.runEvent.findMany({
      where: and(
        eq(runEvent.rootRunId, root.id),
        gt(runEvent.id, input.afterId),
      ),
      orderBy: [asc(runEvent.id)],
      limit: input.limit,
    })

    return {
      events: events.map((e) => ({
        id: e.id,
        runId: e.runId,
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        createdAt: e.createdAt,
      })),
      lastId: events.length > 0 ? events[events.length - 1]!.id : input.afterId,
    }
  })

export const listRuns = authorized
  .route({
    method: 'GET',
    path: '/runs',
    tags: ['Runs'],
    description: 'List the caller’s root orchestrator runs, newest first.',
  })
  .input(
    z.object({
      limit: z.number().int().min(1).max(100).default(25),
    }),
  )
  .handler(async ({ input, context }) => {
    const rows = await db
      .select({
        id: run.id,
        status: run.status,
        input: run.input,
        result: run.result,
        taskId: run.taskId,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        title: task.title,
      })
      .from(run)
      .innerJoin(task, eq(run.taskId, task.id))
      .where(
        and(
          isNull(run.parentRunId),
          eq(task.userId, context.user.id),
          isNull(task.deletedAt),
        ),
      )
      .orderBy(desc(run.createdAt))
      .limit(input.limit)

    return { runs: rows }
  })
