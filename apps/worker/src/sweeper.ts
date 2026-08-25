// Narrow subpath imports (not the @repo/agent barrel): this module is the
// sweep Lambda's bundle entry point (via sweep-lambda.ts) and must not pull
// in native dependencies like @lancedb/lancedb.
import { appendRunFailureEvents } from "@repo/agent/lib/streams";
import {
  appendRunEvent,
  markRunResumable,
} from "@repo/agent/orchestration/store";
import { and, db, eq, inArray, lt, run as runTable, sql } from "@repo/database";
import { dispatchOrchestratorRun, dispatchSubagentRun } from "@repo/queue";
import { LEASE_RENEW_INTERVAL_MS } from "./run-lease";
import { onChildTerminal } from "./run-terminal";

/**
 * A `running`/`planning` run renews its lease every
 * {@link LEASE_RENEW_INTERVAL_MS} while it executes (see run-lease.ts), so
 * three consecutive misses mean the executor is gone — not merely that the
 * segment is taking a while. Tolerating two misses keeps a transient database
 * blip from failing healthy work, and detection is still far faster than the
 * old "no row write in 10 minutes" heuristic, which false-positived on any
 * segment longer than its window.
 */
const EXECUTION_STALL_THRESHOLD_MS = 3 * LEASE_RENEW_INTERVAL_MS;

/**
 * `pending` and `waiting_on_children` rows are held by nobody, so they have no
 * lease to renew and staleness cannot mean death — it means a dispatch was
 * lost or a completion hook never fired. Keep the patient window for those.
 */
const IDLE_STALL_THRESHOLD_MS = 10 * 60_000;

/**
 * Stalled-run sweeper.
 *
 * The guarded claim transition cannot recover a run whose executor died while
 * holding it in `running` — nothing will ever move it again. Detect runs whose
 * lease has expired (updatedAt older than the renewal window), consume one
 * failed execution attempt, reset recoverable runs to `pending`, and
 * re-dispatch. Normal yield/resume segments only advance `run.attempt`; they
 * never consume `failedAttempts`. Runs out of failed attempts are terminal.
 *
 * Runs inside the scheduled sweep Lambda (sweep-lambda.ts) — deliberately
 * OFF the AgentCore substrate it recovers, so a broken runtime (bad image,
 * hung DB pool) cannot take its own crash recovery down with it. It recovers
 * the yield/resume baton when a session dies between Postgres writes.
 */
export async function sweepStalledRuns(): Promise<void> {
  const now = Date.now();
  const leaseCutoff = new Date(now - EXECUTION_STALL_THRESHOLD_MS);
  const idleCutoff = new Date(now - IDLE_STALL_THRESHOLD_MS);

  const stalled = await db
    .update(runTable)
    .set({
      status: "pending",
      error: "Stalled: executor lease expired; retrying.",
      failedAttempts: sql`${runTable.failedAttempts} + 1`,
    })
    .where(
      and(
        inArray(runTable.status, ["running", "planning"]),
        lt(runTable.updatedAt, leaseCutoff),
        sql`${runTable.failedAttempts} + 1 < ${runTable.maxAttempts}`,
      ),
    )
    .returning({
      id: runTable.id,
      agentType: runTable.agentType,
      parentRunId: runTable.parentRunId,
      failedAttempts: runTable.failedAttempts,
      maxAttempts: runTable.maxAttempts,
    });

  for (const row of stalled) {
    console.warn(
      `[sweeper] re-dispatching stalled run ${row.id} ` +
        `(failure ${row.failedAttempts}/${row.maxAttempts})`,
    );
    // Roots (incl. persona/lead roots whose agentType is a persona key) run
    // on the orchestrator path; spawned children on the subagent path.
    if (row.parentRunId === null) {
      await dispatchOrchestratorRun({ runId: row.id, reason: "retry" });
    } else {
      await dispatchSubagentRun({ runId: row.id, reason: "retry" });
    }
  }

  // Terminally fail lease-expired runs whose final failed execution was just
  // consumed, then propagate to plan_task rows and wake waiting parents.
  const dead = await db
    .update(runTable)
    .set({
      status: "failed",
      error: "Stalled: executor died and no failed attempts remain.",
      failedAttempts: sql`${runTable.failedAttempts} + 1`,
      finishedAt: new Date(),
      result: {
        status: "failed",
        summary:
          "Run stalled (executor crash) with no failed attempts remaining.",
      },
    })
    .where(
      and(
        inArray(runTable.status, ["running", "planning"]),
        lt(runTable.updatedAt, leaseCutoff),
        sql`${runTable.failedAttempts} + 1 >= ${runTable.maxAttempts}`,
      ),
    )
    .returning();

  for (const row of dead) {
    // Unlike the recoverable branch above, this verdict is final — say so, or
    // a run that dies here looks like an unexplained crash in the logs.
    console.error(
      `[sweeper] failing run ${row.id} terminally: lease expired ` +
        `(last renewal ${row.updatedAt.toISOString()}, ` +
        `failure ${row.failedAttempts}/${row.maxAttempts}, ` +
        `segments ${row.attempt})`,
    );
    // The dead executor never emitted its terminal stream events, so tailing
    // UIs still show a live run with a spinning tool chip. Append error +
    // finish on its behalf before onChildTerminal EOFs the stream.
    await appendRunFailureEvents({
      runId: row.id,
      rootRunId: row.rootRunId,
      message:
        "Run stalled: the executor died and no failed attempts remain.",
    });
    await onChildTerminal(row);
  }

  await resumeOrphanedParents(idleCutoff);
  await redispatchStalePending(idleCutoff);
}

/**
 * Dropped-baton recovery: a child that dies after writing its own terminal
 * status but before `onChildTerminal` fires leaves its parent parked in
 * `waiting_on_children` forever (no queue redelivery re-runs the hook —
 * especially on AgentCore, where the session is simply gone). Find stale
 * waiting parents whose children are all terminal and resume them through
 * the normal guarded transition.
 */
async function resumeOrphanedParents(cutoff: Date): Promise<void> {
  const waiting = await db.query.run.findMany({
    where: and(
      eq(runTable.status, "waiting_on_children"),
      lt(runTable.updatedAt, cutoff),
    ),
    columns: { id: true, rootRunId: true },
  });

  for (const parent of waiting) {
    const activeChildren = await db.query.run.findMany({
      where: and(
        eq(runTable.parentRunId, parent.id),
        inArray(runTable.status, [
          "pending",
          "planning",
          "running",
          "waiting_on_children",
        ]),
      ),
      columns: { id: true },
    });
    if (activeChildren.length > 0) continue; // Legitimately waiting.

    const resumable = await markRunResumable(parent.id);
    if (resumable) {
      console.warn(`[sweeper] resuming orphaned parent ${parent.id}`);
      await appendRunEvent({
        runId: parent.id,
        rootRunId: parent.rootRunId,
        type: "run.resumed",
        payload: { triggeredBy: "sweeper" },
      });
      await dispatchOrchestratorRun({ runId: parent.id, reason: "resume" });
    }
  }
}

/**
 * A run left in `pending` for a long time means its dispatch call failed (or
 * the dispatched executor never claimed it). Re-dispatching is always safe:
 * the guarded claim drops duplicate deliveries.
 */
async function redispatchStalePending(cutoff: Date): Promise<void> {
  const stalePending = await db.query.run.findMany({
    where: and(
      eq(runTable.status, "pending"),
      lt(runTable.updatedAt, cutoff),
    ),
    columns: { id: true, parentRunId: true },
  });

  for (const row of stalePending) {
    console.warn(`[sweeper] re-dispatching stale pending run ${row.id}`);
    if (row.parentRunId === null) {
      await dispatchOrchestratorRun({ runId: row.id, reason: "retry" });
    } else {
      await dispatchSubagentRun({ runId: row.id, reason: "retry" });
    }
  }
}
