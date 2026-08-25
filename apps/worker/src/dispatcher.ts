import { getRuns, isTerminalRunStatus, type TaskDispatcher } from "@repo/agent";
import { dispatchSubagentRun } from "@repo/queue";

const POLL_INTERVAL_MS = 2_000;

/**
 * TaskDispatcher over the AgentCore dispatch layer.
 *
 * `dispatch` hands the `{ runId }` pointer to @repo/queue, which invokes the
 * AgentCore run runtime (or a local agentcore server in dev). `waitForRuns`
 * polls Postgres (the source of truth) until every listed run is terminal or
 * the timeout elapses — used only by the short-wait `awaitSubagents` tool;
 * long waits go through yield/resume instead.
 */
export class RunDispatcher implements TaskDispatcher {
  async dispatch(childRunId: string): Promise<void> {
    await dispatchSubagentRun({ runId: childRunId, reason: "start" });
  }

  async waitForRuns(childRunIds: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const runs = await getRuns(childRunIds);
      const allTerminal =
        runs.length === childRunIds.length &&
        runs.every((r) => isTerminalRunStatus(r.status));
      if (allTerminal) {
        return;
      }
      const remaining = deadline - Date.now();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(POLL_INTERVAL_MS, Math.max(remaining, 0))),
      );
    }
  }
}
