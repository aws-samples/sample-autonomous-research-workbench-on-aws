/**
 * Terminal-run propagation, shared by the run processors (worker runtime)
 * and the scheduled sweep Lambda.
 *
 * IMPORTANT: this module (and everything it imports) must stay free of the
 * heavy @repo/agent barrel — the sweep Lambda bundles it with esbuild, and
 * the barrel pulls in native dependencies (@lancedb/lancedb) that cannot
 * ship in a Lambda bundle. Import from the narrow @repo/agent subpaths only.
 */
import { closeRunStream } from "@repo/agent/lib/streams";
import { maybeKnowledgePulse } from "@repo/agent/orchestration/knowledge";
import { TEAM_LEAD_AGENT_TYPE } from "@repo/agent/orchestration/project-agents";
import {
  appendRunEvent,
  getRun,
  isTerminalRunStatus,
  markRunResumable,
  type RunRow,
} from "@repo/agent/orchestration/store";
import { agent as agentTable, db, eq, planTask, projectAgent } from "@repo/database";
import { dispatchOrchestratorRun } from "@repo/queue";
import { enforceProjectBudget } from "./budget";

/** A run on the orchestrator queue routes to the lead processor when true. */
export function isTeamLeadRun(row: RunRow): boolean {
  return row.agentType === TEAM_LEAD_AGENT_TYPE;
}

/**
 * Resolve the persona that owns a run tree, for graph-write attribution:
 * a project persona tree's ROOT run has the persona agent's id (uuid) as
 * its agentType. Falls back to the raw agentType string as the author name
 * for built-in types ("researcher") and unknown ids. Best-effort — a lookup
 * failure must never block the run segment.
 */
export async function resolveRunAuthor(
  row: RunRow,
): Promise<{ authorAgentId: string | null; authorName: string | null }> {
  try {
    const root = row.rootRunId === row.id ? row : await getRun(row.rootRunId);
    const agentType = root?.agentType ?? row.agentType;
    const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    if (UUID_RE.test(agentType)) {
      const persona = await db.query.agent.findFirst({
        where: eq(agentTable.id, agentType),
        columns: { id: true, displayName: true },
      });
      if (persona) {
        return { authorAgentId: persona.id, authorName: persona.displayName };
      }
    }
    return { authorAgentId: null, authorName: agentType };
  } catch {
    return { authorAgentId: null, authorName: null };
  }
}

/**
 * Child-completion hook: copy the result onto the plan_task row, then wake
 * the parent orchestrator. `markRunResumable` is a guarded transition, so
 * when N children finish simultaneously exactly one enqueues the resume job.
 *
 * Also flips the project roster flag: when a project persona's ROOT run
 * reaches terminal, the owning `project_agent` row (matched via activeRunId,
 * so lead runs and stale rows are untouched) goes back to `idle` — or
 * `blocked` on failure — and the result is copied into `lastResult`.
 */
export async function onChildTerminal(child: RunRow): Promise<void> {
  if (!isTerminalRunStatus(child.status)) return;

  // The run is terminal: EOF its durable stream so tailing consumers stop.
  // (Segment cleanup deliberately leaves the stream open — a yielded run
  // resumes onto the same stream.) Idempotent and best-effort.
  await closeRunStream(child.id);

  if (!child.parentRunId && child.projectId) {
    await db
      .update(projectAgent)
      .set({
        state: child.status === "failed" ? "blocked" : "idle",
        activeRunId: null,
        lastResult: child.result,
        stateUpdatedAt: new Date(),
      })
      .where(eq(projectAgent.activeRunId, child.id));

    // Research loop: a persona just wrapped up — evaluate whether the Team
    // Lead should be pulsed (knowledge accumulated past the watermark, or
    // the roster just went fully quiet). Best-effort: a pulse failure must
    // never break the terminal path, and a missed pulse is retried by the
    // next persona terminal or the daily heartbeat. Cancelled runs don't
    // pulse (user/lead/budget intervened — not a natural finish), and lead
    // runs never pulse themselves (the sweeper can route dead lead runs
    // through here).
    if (child.status !== "cancelled" && !isTeamLeadRun(child)) {
      try {
        const author = await resolveRunAuthor(child);
        const pulse = await maybeKnowledgePulse({
          projectId: child.projectId,
          enqueue: (leadRunId) =>
            dispatchOrchestratorRun({ runId: leadRunId, reason: "start" }),
          trigger: { agentName: author.authorName, runStatus: child.status },
        });
        console.log(
          `[knowledge-pulse] project=${child.projectId} ` +
            (pulse.started
              ? `started lead run=${pulse.runId}`
              : `skipped: ${pulse.reason}`),
        );
      } catch (error) {
        console.error(
          `[knowledge-pulse] project=${child.projectId} check failed:`,
          error,
        );
      }
    }
  }

  const planStatus =
    child.status === "succeeded"
      ? ("succeeded" as const)
      : child.status === "cancelled"
        ? ("cancelled" as const)
        : ("failed" as const);

  await db
    .update(planTask)
    .set({ status: planStatus, result: child.result })
    .where(eq(planTask.childRunId, child.id));

  if (!child.parentRunId) return;

  // Budget gate at the loop's natural continue point: if the project just
  // crossed its cap, enforcement cancels the parent tree — don't resume it.
  if (await enforceProjectBudget(child.projectId)) return;

  const resumable = await markRunResumable(child.parentRunId);
  if (resumable) {
    await appendRunEvent({
      runId: child.parentRunId,
      rootRunId: child.rootRunId,
      type: "run.resumed",
      payload: { triggeredBy: child.id },
    });
    await dispatchOrchestratorRun({
      runId: child.parentRunId,
      reason: "resume",
    });
  }
}
