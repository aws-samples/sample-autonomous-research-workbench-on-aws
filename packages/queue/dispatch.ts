/**
 * Run dispatch.
 *
 * Callers (API routes, run processors, orchestration dispatcher, sweeper)
 * hand off a `{ runId }` pointer here; execution happens on Bedrock AgentCore
 * (an InvokeAgentRuntime call spins up an isolated session running the
 * worker's agentcore entrypoint). Locally, AGENTCORE_LOCAL_URL points the
 * same dispatch at a locally running agentcore server over plain HTTP.
 *
 * Delivery is at-least-once either way; the guarded status transitions on
 * the `run` row (claimRun etc.) make duplicates harmless.
 */
import { invokeAgentCoreRuntime } from "./agentcore";
import type { RunJobData } from "./jobs";

/** Dispatch an orchestrator run (initial start, resume, or retry). */
export async function dispatchOrchestratorRun(data: RunJobData): Promise<void> {
  await invokeAgentCoreRuntime({ kind: "orchestrator", ...data });
}

/** Dispatch a sub-agent run. */
export async function dispatchSubagentRun(data: RunJobData): Promise<void> {
  await invokeAgentCoreRuntime({ kind: "subagent", ...data });
}
