import { and, db, eq, isNull, project, run, sql } from "@repo/database";

import type { RunMetrics } from "../runtime";

/**
 * Durable per-run usage accounting. Each completed segment increments the
 * run row's cost/token counters (a run can span several segments when the
 * orchestrator yields), so a project's total spend is a cheap SUM over its
 * run rows — no jsonb digging.
 */

/** Increment the run's durable usage counters with one segment's metrics. */
export async function recordRunUsage(
  runId: string,
  metrics: RunMetrics,
): Promise<void> {
  await db
    .update(run)
    .set({
      costUsd: sql`${run.costUsd} + ${metrics.costUSD}`,
      inputTokens: sql`${run.inputTokens} + ${metrics.usage.inputTokens}`,
      outputTokens: sql`${run.outputTokens} + ${metrics.usage.outputTokens}`,
      cacheReadTokens: sql`${run.cacheReadTokens} + ${metrics.usage.cacheReadTokens}`,
      cacheWriteTokens: sql`${run.cacheWriteTokens} + ${metrics.usage.cacheWriteTokens}`,
    })
    .where(eq(run.id, runId));
}

/** Total recorded spend (USD) across all of a project's runs. */
export async function getProjectSpend(projectId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${run.costUsd}), 0)::float8` })
    .from(run)
    .where(eq(run.projectId, projectId));
  return row?.total ?? 0;
}

export type ProjectBudgetStatus = {
  over: boolean;
  spendUsd: number;
  capUsd: number | null;
};

/**
 * Live budget check: recorded spend vs. the project's cap. Stamps
 * `budgetExceededAt` (once, guarded — it drives the UI alert) when the cap
 * is newly crossed. Used to refuse agent starts and to pause automated lead
 * pulses; the worker's segment-checkpoint enforcement additionally cancels
 * already-running trees. Raising or removing the cap in settings clears the
 * stamp and, because this checks live spend rather than the stamp, unblocks
 * immediately.
 */
export async function checkProjectBudget(
  projectId: string,
): Promise<ProjectBudgetStatus> {
  const projectRow = await db.query.project.findFirst({
    where: eq(project.id, projectId),
    columns: { maxBudgetUsd: true, budgetExceededAt: true },
  });
  const capUsd = projectRow?.maxBudgetUsd ?? null;
  if (capUsd === null) return { over: false, spendUsd: 0, capUsd: null };

  const spendUsd = await getProjectSpend(projectId);
  const over = spendUsd >= capUsd;
  if (over && !projectRow?.budgetExceededAt) {
    const [stamped] = await db
      .update(project)
      .set({ budgetExceededAt: new Date() })
      .where(and(eq(project.id, projectId), isNull(project.budgetExceededAt)))
      .returning({ id: project.id });
    if (stamped) {
      console.log(
        `[budget] project ${projectId.slice(0, 8)} exceeded ` +
          `$${capUsd} (spend $${spendUsd.toFixed(2)})`,
      );
    }
  }
  return { over, spendUsd, capUsd };
}
