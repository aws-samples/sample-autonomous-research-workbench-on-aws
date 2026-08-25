import {
  and,
  db,
  eq,
  inArray,
  planTask,
  run,
  runEvent,
  runMessage,
  sql,
} from "@repo/database";
import type { ModelMessage } from "ai";
import type { AgentResult, TaskSpec } from "./types";

/**
 * Persistence layer for the orchestration tables.
 *
 * Every mutable transition on `run.status` is guarded: the UPDATE carries a
 * WHERE clause on the expected current status(es) and callers must treat a
 * zero-row result as "someone else owns this / it's terminal" and drop their
 * work. This is what makes at-least-once queue delivery safe.
 */

export type RunRow = typeof run.$inferSelect;
export type PlanTaskRow = typeof planTask.$inferSelect;
export type RunStatus = RunRow["status"];

export const ACTIVE_RUN_STATUSES: RunStatus[] = [
  "pending",
  "planning",
  "running",
  "waiting_on_children",
];

export const TERMINAL_RUN_STATUSES: RunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];
/**
 * Statuses in which a worker is executing the run right now, and is therefore
 * expected to be renewing its lease (see {@link renewRunLease}). `pending` and
 * `waiting_on_children` are active but nobody is holding them, so they have no
 * lease to renew.
 */
export const EXECUTING_RUN_STATUSES: RunStatus[] = ["planning", "running"];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** Create the root orchestrator run (rootRunId = its own id). */
export async function createRootRun(args: {
  agentType: string;
  input: TaskSpec;
  taskId?: string;
  projectId?: string;
  maxAttempts?: number;
  deadlineAt?: Date;
}): Promise<RunRow> {
  // rootRunId must equal id; generate the id application-side so both
  // columns can be set in one insert.
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(run)
    .values({
      id,
      rootRunId: id,
      agentType: args.agentType,
      input: args.input,
      taskId: args.taskId,
      projectId: args.projectId,
      maxAttempts: args.maxAttempts ?? 3,
      deadlineAt: args.deadlineAt,
    })
    .returning();
  if (!row) throw new Error("Failed to create root run");
  return row;
}

/** Create a child run under a parent. */
export async function createChildRun(args: {
  parentRunId: string;
  rootRunId: string;
  agentType: string;
  input: TaskSpec;
  /** Propagated from the parent so the whole tree is project-scoped. */
  projectId?: string | null;
  maxAttempts?: number;
  deadlineAt?: Date;
}): Promise<RunRow> {
  const [row] = await db
    .insert(run)
    .values({
      parentRunId: args.parentRunId,
      rootRunId: args.rootRunId,
      agentType: args.agentType,
      input: args.input,
      projectId: args.projectId ?? undefined,
      maxAttempts: args.maxAttempts ?? 3,
      deadlineAt: args.deadlineAt,
    })
    .returning();
  if (!row) throw new Error("Failed to create child run");
  return row;
}

/**
 * Claim a run for execution. Returns the claimed row, or null when another
 * worker owns it (or it's terminal) — in which case the caller must drop the
 * job silently.
 */
export async function claimRun(runId: string): Promise<RunRow | null> {
  const [row] = await db
    .update(run)
    .set({
      status: "running",
      startedAt: sql`COALESCE(${run.startedAt}, now())`,
      attempt: sql`${run.attempt} + 1`,
    })
    .where(
      and(
        eq(run.id, runId),
        inArray(run.status, ["pending", "waiting_on_children"]),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Renew the execution lease on a claimed run by bumping `updatedAt`.
 *
 * Liveness has to be asserted explicitly: a segment in progress writes
 * `run_message`, `run_event` and knowledge-graph rows, none of which touch
 * the `run` row, so without renewal a healthy 30-minute turn is
 * indistinguishable from a dead executor and the stalled-run sweeper fails it
 * as a crash.
 *
 * Guarded on {@link EXECUTING_RUN_STATUSES}: returns false once the run is
 * terminal (cancelled by the user/lead, or already failed) or has yielded to
 * `waiting_on_children`, which tells the renewer there is nothing left to
 * keep alive. Never resurrects a row it does not still own.
 */
export async function renewRunLease(runId: string): Promise<boolean> {
  const [row] = await db
    .update(run)
    .set({ updatedAt: new Date() })
    .where(and(eq(run.id, runId), inArray(run.status, EXECUTING_RUN_STATUSES)))
    .returning({ id: run.id });
  return row !== undefined;
}
/**
 * Yield an orchestrator run: running -> waiting_on_children, persisting the
 * checkpoint. Returns false if the run was not in `running`.
 */
export async function yieldRun(
  runId: string,
  checkpoint: unknown,
): Promise<boolean> {
  const [row] = await db
    .update(run)
    .set({ status: "waiting_on_children", checkpoint })
    .where(and(eq(run.id, runId), eq(run.status, "running")))
    .returning({ id: run.id });
  return row !== undefined;
}

/**
 * Try to move a waiting parent back to pending so a resume job can claim it.
 * Exactly one of N concurrent child-completion handlers wins; the rest see
 * zero rows and skip the enqueue.
 */
export async function markRunResumable(runId: string): Promise<boolean> {
  const [row] = await db
    .update(run)
    .set({ status: "pending" })
    .where(and(eq(run.id, runId), eq(run.status, "waiting_on_children")))
    .returning({ id: run.id });
  return row !== undefined;
}

/** Finish a run with a terminal status + structured result. */
export async function finishRun(
  runId: string,
  result: AgentResult,
  error?: string,
): Promise<boolean> {
  const status: RunStatus =
    result.status === "succeeded"
      ? "succeeded"
      : result.status === "cancelled"
        ? "cancelled"
        : "failed";
  const [row] = await db
    .update(run)
    .set({ status, result, error, finishedAt: new Date() })
    .where(and(eq(run.id, runId), inArray(run.status, ACTIVE_RUN_STATUSES)))
    .returning({ id: run.id });
  return row !== undefined;
}

/** Cancel a run if it is still active. */
export async function cancelRun(runId: string): Promise<boolean> {
  const [row] = await db
    .update(run)
    .set({
      status: "cancelled",
      finishedAt: new Date(),
      result: { status: "cancelled", summary: "Cancelled by parent." },
    })
    .where(and(eq(run.id, runId), inArray(run.status, ACTIVE_RUN_STATUSES)))
    .returning({ id: run.id });
  return row !== undefined;
}

/**
 * Cancel every still-active run in a tree (root + descendants) in one guarded
 * UPDATE. Used to stop a project agent: in-flight workers lose their
 * subsequent guarded transitions and drop the work.
 */
export async function cancelRunTree(rootRunId: string): Promise<number> {
  const rows = await db
    .update(run)
    .set({
      status: "cancelled",
      finishedAt: new Date(),
      result: { status: "cancelled", summary: "Stopped by user/team lead." },
    })
    .where(
      and(
        eq(run.rootRunId, rootRunId),
        inArray(run.status, ACTIVE_RUN_STATUSES),
      ),
    )
    .returning({ id: run.id });
  return rows.length;
}

export async function getRun(runId: string): Promise<RunRow | null> {
  const row = await db.query.run.findFirst({ where: eq(run.id, runId) });
  return row ?? null;
}

export async function getRuns(runIds: string[]): Promise<RunRow[]> {
  if (runIds.length === 0) return [];
  return db.query.run.findMany({ where: inArray(run.id, runIds) });
}

export async function getPlanTasks(
  orchestratorRunId: string,
): Promise<PlanTaskRow[]> {
  return db.query.planTask.findMany({
    where: eq(planTask.runId, orchestratorRunId),
    orderBy: (t, { asc }) => [asc(t.seq)],
  });
}

/**
 * Append an event with a per-run monotonic sequence.
 *
 * The seq is computed with a MAX(seq)+1 subquery, which is atomic within one
 * statement but can race between concurrent writers on the same runId. The
 * (runId, seq) unique index turns that race into a 23505 unique violation, so
 * we retry a few times — the loser simply recomputes against the new MAX.
 * In steady state each run has a single processor and this never loops.
 */
export async function appendRunEvent(args: {
  runId: string;
  rootRunId: string;
  type: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      await db.insert(runEvent).values({
        runId: args.runId,
        rootRunId: args.rootRunId,
        type: args.type,
        payload: args.payload ?? {},
        seq: sql`COALESCE((SELECT MAX(${runEvent.seq}) FROM ${runEvent} WHERE ${runEvent.runId} = ${args.runId}), 0) + 1`,
      });
      return;
    } catch (error) {
      if (isUniqueViolation(error) && attempt < MAX_ATTEMPTS) {
        // Tiny jittered backoff so N colliding writers don't re-collide.
        await new Promise((resolve) =>
          setTimeout(resolve, attempt * 5 + Math.random() * 10),
        );
        continue;
      }
      throw error;
    }
  }
}

/** Postgres unique_violation (23505), possibly wrapped by the driver/ORM. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (
      typeof current === "object" &&
      (current as { code?: string }).code === "23505"
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Load the persisted ModelMessage transcript for a run, in order. */
export async function loadRunMessages(runId: string): Promise<ModelMessage[]> {
  const rows = await db.query.runMessage.findMany({
    where: eq(runMessage.runId, runId),
    orderBy: (t, { asc }) => [asc(t.seq)],
  });
  return rows.map((r) => r.content as ModelMessage);
}

/**
 * Replace the persisted transcript for a run with the given history.
 * The agent loop saves the full (already trimmed) history at the end of each
 * run segment, so a replace keeps seq contiguous and idempotent.
 */
export async function saveRunMessages(
  runId: string,
  messages: ModelMessage[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(runMessage).where(eq(runMessage.runId, runId));
    if (messages.length === 0) return;
    await tx.insert(runMessage).values(
      messages.map((m, i) => ({
        runId,
        seq: i + 1,
        role: m.role,
        content: m as unknown as Record<string, unknown>,
      })),
    );
  });
}
