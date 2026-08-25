import type { Tool } from "ai";

/**
 * Core types for the orchestration layer.
 *
 * Postgres (`run`, `plan_task`, `run_event`, `run_message`) is the source of
 * truth; the queue only carries `{ runId }` pointers. These types describe the
 * jsonb payloads stored on those rows.
 */

/** The brief handed to a run as `run.input`. */
export type TaskSpec = {
  /** What the agent should accomplish, self-contained. */
  instructions: string;
  /** Optional extra context (results of upstream tasks, constraints, etc.). */
  context?: string;
  /** Optional title for display. */
  title?: string;
};

/** Structured result written to `run.result` on terminal status. */
export type AgentResult = {
  status: "succeeded" | "failed" | "cancelled";
  /** Compact summary of the outcome — the only thing parents consume. */
  summary: string;
  /** Free-form structured payload (per agentType). */
  data?: unknown;
  /** Rolled-up metrics for this run. */
  metrics?: {
    costUSD: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
  };
};

/** A unit of work to add to the plan. */
export type PlanTaskInput = {
  title: string;
  /** Agent registry key ("subagent" persona, agent id, etc.). */
  agentType: string;
  /** Self-contained brief for the sub-agent. */
  instructions: string;
  context?: string;
  /** Titles/ids of plan tasks this one depends on (optional). */
  dependsOn?: string[];
};

export type SpawnedChild = {
  planTaskId: string;
  childRunId: string;
  title: string;
};

export type ChildStatus = {
  planTaskId: string;
  childRunId: string | null;
  title: string;
  status: string;
  result: AgentResult | null;
};

/**
 * Dispatch abstraction between orchestration tools and the execution
 * substrate: Bedrock AgentCore (InvokeAgentRuntime), or a local agentcore
 * server in dev. Tools never touch the substrate directly.
 */
export interface TaskDispatcher {
  /** Enqueue a child run for execution. */
  dispatch(childRunId: string): Promise<void>;
  /**
   * Wait until the given child runs are terminal or the timeout elapses.
   * Returns immediately-known statuses either way (never throws on timeout).
   */
  waitForRuns(childRunIds: string[], timeoutMs: number): Promise<void>;
}

/** Context threaded to orchestration tools via experimental_context. */
export type OrchestrationToolContext = {
  runId: string;
  rootRunId: string;
  depth: number;
  /** Project owning this run tree, propagated to spawned children. */
  projectId?: string | null;
};

/** Guardrails applied by the orchestration tools. */
export type OrchestrationLimits = {
  /** Max plan tasks per orchestrator run. */
  maxPlanTasks: number;
  /** Max concurrently-active children spawned at once. */
  maxSpawnBatch: number;
  /** Max orchestrator nesting depth (root = 0). */
  maxDepth: number;
  /** Max ms `await_subagents` may block a worker slot. */
  maxAwaitMs: number;
};

export const DEFAULT_LIMITS: OrchestrationLimits = {
  maxPlanTasks: 20,
  maxSpawnBatch: 5,
  maxDepth: 1,
  maxAwaitMs: 120_000,
};

export type OrchestrationToolSet = Record<string, Tool>;
