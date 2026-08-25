import type { ModelMessage } from "ai";
import type { TokenUsage } from "./cost-calculation";
import type { AgentMessage } from "./types";

/**
 * Events emitted during agent execution.
 * These events represent the streaming chunks from the LLM.
 */
export type AgentEvent =
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "reasoning-end"; id: string }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; text: string }
  | { type: "text-end"; id: string }
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-result"; toolCallId: string; output: unknown }
  | { type: "finish" };

/**
 * Metrics collected during a run.
 */
export type RunMetrics = {
  usage: TokenUsage;
  costUSD: number;
  durationMs: number;
  tokenCount: number;
  modelId: string;
};

/**
 * The AgentRuntime protocol defines how the Agent interacts with external systems.
 * Different implementations allow the same Agent to run in different environments:
 * - ConsoleRuntime: Local testing with console output
 * - StreamRuntime: Production with DB persistence and Electric Streams streaming
 */
export interface AgentRuntime {
  /**
   * Load message history for the conversation.
   * Called at the start of a run to retrieve previous messages.
   */
  loadMessages(): Promise<ModelMessage[]>;

  /**
   * Save messages after a run completes.
   * @param agentHistory - Complete ModelMessage history for cache continuity
   * @param messages - AgentMessage array for the messages table
   */
  saveMessages(
    agentHistory: ModelMessage[],
    messages: AgentMessage[]
  ): Promise<void>;

  /**
   * Emit a streaming event during agent execution.
   * Called for each chunk from the LLM stream.
   */
  emit(event: AgentEvent): Promise<void>;

  /**
   * Called when a run starts.
   * @param runId - Unique identifier for this run
   */
  onRunStart(runId: string): Promise<void>;

  /**
   * Called when a run completes successfully.
   * @param runId - Unique identifier for this run
   * @param metrics - Performance and usage metrics
   */
  onRunComplete(runId: string, metrics: RunMetrics): Promise<void>;

  /**
   * Called after a successful run with generated follow-up query suggestions.
   * Optional: runtimes that don't surface suggestions can omit this. Invoked
   * before the terminal `finish` event so consumers receive it while tailing.
   * @param runId - Unique identifier for this run
   * @param suggestions - 2-4 suggested follow-up queries (may be empty)
   */
  onRunSuggestions?(runId: string, suggestions: string[]): Promise<void>;

  /**
   * Called when a run fails with an error.
   * @param runId - Unique identifier for this run
   * @param error - The error that occurred
   */
  onRunError(runId: string, error: Error): Promise<void>;

  /**
   * Log a message at the specified level.
   * @param level - Log severity level
   * @param message - Log message
   * @param data - Optional additional data
   */
  log(level: "debug" | "info" | "error", message: string, data?: unknown): void;

  /**
   * Cleanup resources after a run.
   * Called at the end of a run regardless of success/failure.
   */
  cleanup(): Promise<void>;
}
