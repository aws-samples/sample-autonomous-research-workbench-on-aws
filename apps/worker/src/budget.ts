// Narrow subpath imports (not the @repo/agent barrel): this module is part
// of the sweep Lambda's bundle, which must not pull in native dependencies.
import { cancelRunTree } from "@repo/agent/orchestration/store";
import { getProjectSpend } from "@repo/agent/orchestration/usage";
import { and, db, eq, isNull, project, projectAgent } from "@repo/database";

/**
 * Project budget enforcement. Called at segment checkpoints in the worker
 * (segment start + child-terminal resume) — never mid-stream, so a segment
 * already streaming finishes before the stop lands (bounded overshoot of
 * roughly one segment's cost).
 */

const BUDGET_STOP_RESULT = {
  status: "cancelled",
  summary: "Stopped: project budget exceeded.",
} as const;

/**
 * Check the project's spend against its cap. When exceeded: stamp
 * `budgetExceededAt` (once — it drives the UI alert), cancel every project
 * agent's active run tree, and reset the roster flags to idle.
 *
 * Returns true when the budget is exceeded (callers should stop the loop).
 */
export async function enforceProjectBudget(
  projectId: string | null,
): Promise<boolean> {
  if (!projectId) return false;

  const projectRow = await db.query.project.findFirst({
    where: eq(project.id, projectId),
    columns: { maxBudgetUsd: true, budgetExceededAt: true },
  });
  if (!projectRow?.maxBudgetUsd) return false;

  const spend = await getProjectSpend(projectId);
  if (spend < projectRow.maxBudgetUsd) return false;

  // Stamp once; concurrent workers race on the IS NULL guard so the alert
  // (and the log line) fires a single time.
  const [stamped] = await db
    .update(project)
    .set({ budgetExceededAt: new Date() })
    .where(and(eq(project.id, projectId), isNull(project.budgetExceededAt)))
    .returning({ id: project.id });
  if (stamped) {
    console.log(
      `[budget] project ${projectId.slice(0, 8)} exceeded ` +
        `$${projectRow.maxBudgetUsd} (spend $${spend.toFixed(2)}), stopping agents`,
    );
  }

  // Stop every working agent on the project (mirrors stopProjectAgent, but
  // across the whole roster with a budget-specific lastResult).
  const roster = await db.query.projectAgent.findMany({
    where: eq(projectAgent.projectId, projectId),
  });
  for (const pa of roster) {
    if (!pa.activeRunId) continue;
    await cancelRunTree(pa.activeRunId);
    await db
      .update(projectAgent)
      .set({
        state: "idle",
        activeRunId: null,
        lastResult: BUDGET_STOP_RESULT,
        stateUpdatedAt: new Date(),
      })
      .where(
        and(
          eq(projectAgent.id, pa.id),
          eq(projectAgent.activeRunId, pa.activeRunId),
        ),
      );
  }

  return true;
}
