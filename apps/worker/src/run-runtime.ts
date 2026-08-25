import {
  TaskStreamWriter,
  appendRunEvent,
  recordRunUsage,
  saveRunMessages,
  type AgentEvent,
  type AgentMessage,
  type AgentRuntime,
  type RunMetrics,
} from "@repo/agent";
import type { Message } from "@repo/streams-protocol";
import type { ModelMessage } from "ai";

/**
 * RunRuntime backs an agent execution with the durable orchestration tables:
 * - transcript -> `run_message` (full ModelMessage history, replaced per segment)
 * - lifecycle events -> `run_event` (append-only, per-run seq)
 * - live deltas -> a per-run durable stream (same wire protocol as
 *   StreamRuntime, so the web UI can tail sub-agent runs too)
 *
 * Status transitions on the `run` row are NOT handled here — the worker owns
 * those via guarded transitions, because only it knows whether the run
 * yielded, finished, or should retry.
 */
export class RunRuntime implements AgentRuntime {
  private writer: TaskStreamWriter;
  private initialHistory: ModelMessage[];

  constructor(
    private readonly ids: { runId: string; rootRunId: string },
    initialHistory: ModelMessage[],
    streamsUrl: string = process.env.STREAMS_URL ?? "http://localhost:4437",
  ) {
    this.initialHistory = initialHistory;
    this.writer = new TaskStreamWriter(streamsUrl, ids.runId);
  }

  async loadMessages(): Promise<ModelMessage[]> {
    return this.initialHistory;
  }

  async saveMessages(
    agentHistory: ModelMessage[],
    _messages: AgentMessage[],
  ): Promise<void> {
    await saveRunMessages(this.ids.runId, agentHistory);
  }

  async emit(event: AgentEvent): Promise<void> {
    const msg = this.mapEventToMessage(event);
    if (msg) {
      await this.writer.append(msg);
    }
  }

  async onRunStart(_segmentId: string): Promise<void> {
    await appendRunEvent({
      runId: this.ids.runId,
      rootRunId: this.ids.rootRunId,
      type: "segment.started",
    });
    await this.writer.append({
      event_type: "start",
      taskId: this.ids.rootRunId,
      runId: this.ids.runId,
      data: { runId: this.ids.runId, userMessage: "" },
    });
  }

  async onRunComplete(_segmentId: string, metrics: RunMetrics): Promise<void> {
    await recordRunUsage(this.ids.runId, metrics);
    await appendRunEvent({
      runId: this.ids.runId,
      rootRunId: this.ids.rootRunId,
      type: "segment.finished",
      payload: {
        costUSD: metrics.costUSD,
        durationMs: metrics.durationMs,
        inputTokens: metrics.usage.inputTokens,
        outputTokens: metrics.usage.outputTokens,
      },
    });
    await this.writer.append({
      event_type: "finish",
      taskId: this.ids.rootRunId,
      runId: this.ids.runId,
      data: { runId: this.ids.runId, reason: "complete" },
    });
  }

  async onRunError(_segmentId: string, error: Error): Promise<void> {
    await appendRunEvent({
      runId: this.ids.runId,
      rootRunId: this.ids.rootRunId,
      type: "segment.failed",
      payload: { message: error.message },
    });
    await this.writer.append({
      event_type: "error",
      taskId: this.ids.rootRunId,
      runId: this.ids.runId,
      data: { message: error.message },
    });
    await this.writer.append({
      event_type: "finish",
      taskId: this.ids.rootRunId,
      runId: this.ids.runId,
      data: { runId: this.ids.runId, reason: "error" },
    });
  }

  log(
    level: "debug" | "info" | "error",
    message: string,
    data?: unknown,
  ): void {
    const prefix = `[run ${this.ids.runId.slice(0, 8)}]`;
    const fn = level === "error" ? console.error : console.log;
    if (data !== undefined) {
      fn(`${prefix} ${message}`, data);
    } else {
      fn(`${prefix} ${message}`);
    }
  }

  async cleanup(): Promise<void> {
    // Drain window for the client's append batches. Do NOT close the stream
    // here: cleanup runs at the end of every segment, but close is terminal
    // for a durable stream and a yielded orchestrator appends to this same
    // stream again after resume. The processors close the stream exactly
    // once, when the run reaches terminal status (closeRunStream).
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  private mapEventToMessage(event: AgentEvent): Message | null {
    const base = { taskId: this.ids.rootRunId, runId: this.ids.runId };

    switch (event.type) {
      case "reasoning-start":
        return { ...base, event_type: "reasoning-start", id: event.id };
      case "reasoning-delta":
        return {
          ...base,
          event_type: "reasoning-delta",
          id: event.id,
          delta: event.text,
        };
      case "reasoning-end":
        return { ...base, event_type: "reasoning-end", id: event.id };
      case "text-start":
        return { ...base, event_type: "text-start", id: event.id };
      case "text-delta":
        return {
          ...base,
          event_type: "text-delta",
          id: event.id,
          delta: event.text,
        };
      case "text-end":
        return { ...base, event_type: "text-end", id: event.id };
      case "tool-input-start":
        return {
          ...base,
          event_type: "tool-input-start",
          toolCallId: event.id,
          toolName: event.toolName,
        };
      case "tool-input-delta":
        return {
          ...base,
          event_type: "tool-input-delta",
          toolCallId: event.id,
          inputTextDelta: event.delta,
        };
      case "tool-result":
        return {
          ...base,
          event_type: "tool-result",
          toolCallId: event.toolCallId,
          output: event.output,
        };
      default:
        return null;
    }
  }
}
