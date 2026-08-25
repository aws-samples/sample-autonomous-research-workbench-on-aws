import { db, eq, task, taskMessage } from "@repo/database";
import type { Message } from "@repo/streams-protocol";
import type { ModelMessage } from "ai";
import { TaskStreamWriter } from "../lib/streams";
import { recordRunUsage } from "../orchestration/usage";
import type { AgentEvent, AgentRuntime, RunMetrics } from "../runtime";
import type { AgentMessage } from "../types";

/**
 * StreamRuntime is the production runtime.
 * - Persists messages to PostgreSQL via Drizzle (`TaskMessage` + `Task.agentHistory`)
 * - Streams typed events to the frontend over a durable (Electric) stream
 * - Manages task status
 */
export class StreamRuntime implements AgentRuntime {
  private writer: TaskStreamWriter;

  constructor(
    private taskId: string,
    private runId: string,
    streamsUrl: string = process.env.STREAMS_URL ?? "http://localhost:4437",
  ) {
    this.writer = new TaskStreamWriter(streamsUrl, runId);
  }

  async loadMessages(): Promise<ModelMessage[]> {
    const result = await db.query.task.findFirst({
      where: eq(task.id, this.taskId),
    });
    return ((result?.agentHistory as ModelMessage[]) ?? []) as ModelMessage[];
  }

  async saveMessages(
    agentHistory: ModelMessage[],
    messages: AgentMessage[],
  ): Promise<void> {
    const now = Date.now();

    if (messages.length > 0) {
      const dbMessages = messages.map((msg, index) => ({
        role: msg.role,
        taskId: this.taskId,
        content: msg.content as Record<string, unknown>,
        metadata: msg.metadata as Record<string, unknown> | undefined,
        createdAt: new Date(now + index),
      }));

      await db.insert(taskMessage).values(dbMessages);
    }

    await db
      .update(task)
      .set({ agentHistory: agentHistory as unknown as object[] })
      .where(eq(task.id, this.taskId));
  }

  async emit(event: AgentEvent): Promise<void> {
    const msg = this.mapEventToMessage(event);
    if (msg) {
      await this.writer.append(msg);
    }
  }

  async onRunStart(_runId: string): Promise<void> {
    await this.writer.append({
      event_type: "start",
      taskId: this.taskId,
      runId: this.runId,
      data: { runId: this.runId, userMessage: "" },
    });
  }

  async onRunComplete(runId: string, metrics: RunMetrics): Promise<void> {
    await recordRunUsage(runId, metrics);

    await db.insert(taskMessage).values({
      role: "platform",
      content: {
        type: "metrics",
        runCost: metrics.costUSD.toFixed(3),
        runDurationMs: metrics.durationMs,
        inputTokens: metrics.usage.inputTokens,
        outputTokens: metrics.usage.outputTokens,
        cacheReadTokens: metrics.usage.cacheReadTokens,
        cacheWriteTokens: metrics.usage.cacheWriteTokens,
      },
      taskId: this.taskId,
    });

    await this.writer.append({
      event_type: "metrics",
      taskId: this.taskId,
      runId: this.runId,
      data: {
        runCost: metrics.costUSD.toFixed(3),
        runDurationMs: metrics.durationMs,
        inputTokens: metrics.usage.inputTokens,
        outputTokens: metrics.usage.outputTokens,
        cacheReadTokens: metrics.usage.cacheReadTokens,
        cacheWriteTokens: metrics.usage.cacheWriteTokens,
      },
    });

    await db
      .update(task)
      .set({ status: "completed" })
      .where(eq(task.id, this.taskId));

    await this.writer.append({
      event_type: "finish",
      taskId: this.taskId,
      runId: this.runId,
      data: { runId: this.runId, reason: "complete" },
    });
  }

  async onRunSuggestions(
    _runId: string,
    suggestions: string[],
  ): Promise<void> {
    if (suggestions.length === 0) return;

    // Persist suggestions as a platform row. They reach the UI via Electric SQL
    // sync (the persisted-history path), not the live stream: by the time
    // suggestions are generated the run has already emitted its terminal
    // `finish` event and the live stream is closing, so a stream append would
    // be ignored by consumers anyway.
    await db.insert(taskMessage).values({
      role: "platform",
      content: {
        type: "suggestions",
        suggestions,
      },
      taskId: this.taskId,
    });
  }

  async onRunError(_runId: string, error: Error): Promise<void> {
    await db
      .update(task)
      .set({ status: "failed" })
      .where(eq(task.id, this.taskId));

    const errorMessage = `An error occurred with the platform: ${error.message}`;

    await db.insert(taskMessage).values({
      role: "platform",
      content: {
        type: "error",
        message: errorMessage,
      },
      taskId: this.taskId,
    });

    this.log("error", `Agent run failed: ${error.message}`);

    await this.writer.append({
      event_type: "error",
      taskId: this.taskId,
      runId: this.runId,
      data: {
        message: errorMessage,
      },
    });

    await this.writer.append({
      event_type: "finish",
      taskId: this.taskId,
      runId: this.runId,
      data: { runId: this.runId, reason: "error" },
    });
  }

  log(
    level: "debug" | "info" | "error",
    message: string,
    data?: unknown,
  ): void {
    if (data !== undefined) {
      console[level](message, data);
    } else {
      console[level](message);
    }
  }

  async cleanup(): Promise<void> {
    // Give consumers a brief window to drain the final events before EOF.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await this.writer.close();
  }

  private mapEventToMessage(event: AgentEvent): Message | null {
    const base = {
      taskId: this.taskId,
      runId: this.runId,
    };

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
      case "finish":
        // The terminal `finish` stream event is appended explicitly in
        // onRunComplete / onRunError so it carries a reason.
        return null;
      default:
        return null;
    }
  }
}
