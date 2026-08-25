import type { ModelMessage } from "ai";
import type { AgentEvent, AgentRuntime, RunMetrics } from "../runtime";
import type { AgentMessage } from "../types";

const style = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  zinc400: "\x1b[38;5;248m",
  zinc500: "\x1b[38;5;246m",
  zinc600: "\x1b[38;5;242m",
  zinc700: "\x1b[38;5;240m",
  cyan: "\x1b[38;5;80m",
  red: "\x1b[38;5;203m",
} as const;

/**
 * ConsoleRuntime is a runtime implementation for local testing and development.
 * - Streams output to stdout with light styling
 * - Stores messages in memory (no DB, no streams server)
 */
export class ConsoleRuntime implements AgentRuntime {
  private history: ModelMessage[] = [];
  private agentMessages: AgentMessage[] = [];

  constructor(initialMessages?: ModelMessage[]) {
    this.history = initialMessages ?? [];
  }

  async loadMessages(): Promise<ModelMessage[]> {
    return this.history;
  }

  async saveMessages(
    agentHistory: ModelMessage[],
    messages: AgentMessage[]
  ): Promise<void> {
    this.history = agentHistory;
    this.agentMessages = messages;
  }

  async emit(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "reasoning-start":
        process.stdout.write(`${style.dim}${style.italic}${style.zinc500}`);
        break;
      case "reasoning-delta":
        process.stdout.write(event.text);
        break;
      case "reasoning-end":
        process.stdout.write(`${style.reset}\n`);
        break;
      case "text-start":
        process.stdout.write(`${style.reset}\n`);
        break;
      case "text-delta":
        process.stdout.write(event.text);
        break;
      case "tool-input-start":
        process.stdout.write(
          `\n${style.zinc600}┌─ ${style.cyan}${event.toolName}${style.reset}\n${style.zinc700}`
        );
        break;
      case "tool-input-delta":
        process.stdout.write(event.delta);
        break;
      case "tool-result":
        process.stdout.write(`${style.zinc600}└─${style.reset}\n`);
        break;
      case "finish":
        break;
    }
  }

  async onRunStart(runId: string): Promise<void> {
    process.stdout.write(
      `\n${style.zinc600}────────────────────────────${style.reset}\n` +
        `${style.zinc500}run ${style.zinc400}${runId.slice(0, 8)}${style.reset}\n\n`
    );
  }

  async onRunComplete(_runId: string, metrics: RunMetrics): Promise<void> {
    const formatCost = (n: number) => (n < 0.01 ? n.toFixed(4) : n.toFixed(2));
    const formatDuration = (ms: number) =>
      ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

    process.stdout.write(
      `\n\n${style.zinc600}────────────────────────────${style.reset}\n` +
        `${style.zinc600}${metrics.tokenCount.toLocaleString()} tokens · ` +
        `$${formatCost(metrics.costUSD)} · ${formatDuration(metrics.durationMs)}${style.reset}\n\n`
    );
  }

  async onRunError(runId: string, error: Error): Promise<void> {
    process.stdout.write(
      `\n${style.red}${style.bold}error${style.reset} ${style.zinc500}${runId.slice(0, 8)}${style.reset}\n` +
        `${style.red}${error.message}${style.reset}\n`
    );
  }

  log(
    level: "debug" | "info" | "error",
    message: string,
    data?: unknown
  ): void {
    const prefix =
      level === "error"
        ? `${style.red}${style.bold}error${style.reset}`
        : level === "debug"
          ? `${style.zinc600}debug${style.reset}`
          : `${style.zinc500}info${style.reset}`;

    if (data !== undefined) {
      console.log(`${prefix} ${style.zinc400}${message}${style.reset}`, data);
    } else {
      console.log(`${prefix} ${style.zinc400}${message}${style.reset}`);
    }
  }

  async cleanup(): Promise<void> {
    // No cleanup needed for console runtime.
  }

  getMessages(): ModelMessage[] {
    return this.history;
  }

  getAgentMessages(): AgentMessage[] {
    return this.agentMessages;
  }
}
