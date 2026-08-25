import type { ModelMessage } from "ai";

/**
 * Interface for managing conversation history sent to the LLM.
 * Implementations define a strategy for trimming the ModelMessage array
 * to keep context within desired bounds.
 */
export interface ConversationManager {
  /**
   * Trim the message history according to the strategy.
   * Must return a valid message sequence (no orphaned tool results, etc.).
   */
  trimMessages(messages: ModelMessage[]): ModelMessage[];

  /** Whether to apply trimming before each LLM call in the agent loop. */
  readonly perTurn: boolean;
}

/**
 * Maintains a fixed-size sliding window of recent messages.
 *
 * When the history exceeds `windowSize`, older messages are dropped.
 * The trim never starts on a "tool" role message to avoid orphaning
 * a tool result from its preceding assistant tool-call message.
 */
export class SlidingWindowConversationManager implements ConversationManager {
  constructor(
    public readonly windowSize: number = 40,
    public readonly perTurn: boolean = false
  ) {
    if (windowSize < 1) {
      throw new Error("windowSize must be at least 1");
    }
  }

  trimMessages(messages: ModelMessage[]): ModelMessage[] {
    if (messages.length <= this.windowSize) {
      return messages;
    }

    let startIndex = messages.length - this.windowSize;

    // Walk forward past any leading "tool" messages so we never orphan
    // a tool result from its preceding assistant message.
    while (
      startIndex < messages.length &&
      messages[startIndex]?.role === "tool"
    ) {
      startIndex++;
    }

    return messages.slice(startIndex);
  }
}
