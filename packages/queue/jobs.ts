/**
 * Typed dispatch payloads.
 *
 * Dispatches carry only a run ID pointer. Executors must load the `run` row
 * and claim it with a guarded status transition — delivery is treated as
 * at-least-once, so an invocation whose run row is already owned or terminal
 * is silently dropped.
 */

/** Pointer into the `run` table, plus why it was dispatched. */
export type RunJobData = {
  runId: string;
  /**
   * Why this run was dispatched. `resume` dispatches are produced when a
   * child run reaches a terminal state while the parent is
   * `waiting_on_children`; `retry` comes from crash recovery or the sweeper.
   */
  reason: "start" | "resume" | "retry";
};

/**
 * JSON payload of an InvokeAgentRuntime call (or a local HTTP invocation in
 * dev). The `kind` routes to the orchestrator or subagent processor;
 * `heartbeat` is sent by a project's EventBridge Scheduler schedule (via the
 * heartbeat Lambda) and starts a Team Lead pulse-check turn. (The stalled-run
 * sweep is NOT an invocation: it runs inside its scheduled Lambda, directly
 * against Postgres.)
 */
export type AgentCoreInvocationPayload =
  | ({ kind: "orchestrator" | "subagent" } & RunJobData)
  | { kind: "heartbeat"; projectId: string };
