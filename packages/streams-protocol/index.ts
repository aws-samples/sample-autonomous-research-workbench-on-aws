import z from "zod";

/**
 * Electric Streams event contract.
 *
 * These are the typed, JSON-mode messages appended to a per-run durable
 * stream (`/v1/stream/run-{runId}`) by the agent worker and consumed live by
 * the web app. The shape mirrors the AI SDK's stream parts (text / reasoning /
 * tool deltas) plus a few lifecycle events (start / finish / error / metrics).
 *
 * This is the single source of truth for the wire format: the producer
 * (`@repo/agent` StreamRuntime) and the consumer (web `use-task-stream`) both
 * import it, so the two ends can never drift.
 */
export const eventTypes = {
  START: "start",
  FINISH: "finish",
  ERROR: "error",
  METRICS: "metrics",
  TEXT_START: "text-start",
  TEXT_DELTA: "text-delta",
  TEXT_END: "text-end",
  REASONING_START: "reasoning-start",
  REASONING_DELTA: "reasoning-delta",
  REASONING_END: "reasoning-end",
  TOOL_INPUT_START: "tool-input-start",
  TOOL_INPUT_DELTA: "tool-input-delta",
  TOOL_RESULT: "tool-result",
  SUGGESTIONS: "suggestions",
  SUBAGENT_START: "subagent-start",
  SUBAGENT_FINISH: "subagent-finish",
} as const;

export const baseMessageSchema = z.object({
  event_type: z.enum([
    eventTypes.START,
    eventTypes.FINISH,
    eventTypes.ERROR,
    eventTypes.METRICS,
    eventTypes.TEXT_START,
    eventTypes.TEXT_DELTA,
    eventTypes.TEXT_END,
    eventTypes.REASONING_START,
    eventTypes.REASONING_DELTA,
    eventTypes.REASONING_END,
    eventTypes.TOOL_INPUT_START,
    eventTypes.TOOL_INPUT_DELTA,
    eventTypes.TOOL_RESULT,
    eventTypes.SUGGESTIONS,
    eventTypes.SUBAGENT_START,
    eventTypes.SUBAGENT_FINISH,
  ]),
  taskId: z.string(),
  runId: z.string(),
  // When present, this event was produced by a nested sub-agent spawned via the
  // `run_subagent` tool. The UI groups these under the parent tool step so the
  // sub-agent's own text/reasoning/tool activity renders as nested progress.
  subAgentId: z.string().optional(),
  subAgentName: z.string().optional(),
});

export const startMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.START),
  data: z.object({
    runId: z.string(),
    userMessage: z.string(),
    userMessageMetadata: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const finishMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.FINISH),
  data: z.object({
    runId: z.string(),
    reason: z.enum(["complete", "error", "cancelled", "stopped"]),
  }),
});

export const errorMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.ERROR),
  data: z.object({
    message: z.string(),
  }),
});

export const metricsMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.METRICS),
  data: z.object({
    runCost: z.string(),
    runDurationMs: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
  }),
});

export const textStartMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.TEXT_START),
  id: z.coerce.string(),
});

export const textDeltaMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.TEXT_DELTA),
  id: z.coerce.string(),
  delta: z.string(),
});

export const textEndMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.TEXT_END),
  id: z.coerce.string(),
});

export const reasoningStartMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.REASONING_START),
  id: z.coerce.string(),
});

export const reasoningDeltaMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.REASONING_DELTA),
  id: z.coerce.string(),
  delta: z.string(),
});

export const reasoningEndMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.REASONING_END),
  id: z.coerce.string(),
});

export const toolInputStartMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.TOOL_INPUT_START),
  toolCallId: z.string(),
  toolName: z.string(),
});

export const toolInputDeltaMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.TOOL_INPUT_DELTA),
  toolCallId: z.string(),
  inputTextDelta: z.string(),
});

export const toolResultMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.TOOL_RESULT),
  toolCallId: z.string(),
  output: z.unknown(),
});

export const suggestionsMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.SUGGESTIONS),
  data: z.object({
    suggestions: z.array(z.string()),
  }),
});

export const subAgentStartMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.SUBAGENT_START),
  subAgentId: z.string(),
  data: z.object({
    /** The tool call id of the `run_subagent` invocation that spawned this. */
    toolCallId: z.string(),
    persona: z.string(),
    name: z.string(),
    task: z.string(),
  }),
});

export const subAgentFinishMessageSchema = baseMessageSchema.extend({
  event_type: z.literal(eventTypes.SUBAGENT_FINISH),
  subAgentId: z.string(),
  data: z.object({
    toolCallId: z.string(),
    reason: z.enum(["complete", "error"]),
  }),
});

export const messageSchema = z.discriminatedUnion("event_type", [
  startMessageSchema,
  finishMessageSchema,
  errorMessageSchema,
  metricsMessageSchema,
  textStartMessageSchema,
  textDeltaMessageSchema,
  textEndMessageSchema,
  reasoningStartMessageSchema,
  reasoningDeltaMessageSchema,
  reasoningEndMessageSchema,
  toolInputStartMessageSchema,
  toolInputDeltaMessageSchema,
  toolResultMessageSchema,
  suggestionsMessageSchema,
  subAgentStartMessageSchema,
  subAgentFinishMessageSchema,
]);

export type Message = z.infer<typeof messageSchema>;
export type StartMessage = z.infer<typeof startMessageSchema>;
export type FinishMessage = z.infer<typeof finishMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;
export type MetricsMessage = z.infer<typeof metricsMessageSchema>;
export type TextStartMessage = z.infer<typeof textStartMessageSchema>;
export type TextDeltaMessage = z.infer<typeof textDeltaMessageSchema>;
export type TextEndMessage = z.infer<typeof textEndMessageSchema>;
export type ReasoningStartMessage = z.infer<typeof reasoningStartMessageSchema>;
export type ReasoningDeltaMessage = z.infer<typeof reasoningDeltaMessageSchema>;
export type ReasoningEndMessage = z.infer<typeof reasoningEndMessageSchema>;
export type ToolInputStartMessage = z.infer<typeof toolInputStartMessageSchema>;
export type ToolInputDeltaMessage = z.infer<typeof toolInputDeltaMessageSchema>;
export type ToolResultMessage = z.infer<typeof toolResultMessageSchema>;
export type SuggestionsMessage = z.infer<typeof suggestionsMessageSchema>;
export type SubAgentStartMessage = z.infer<typeof subAgentStartMessageSchema>;
export type SubAgentFinishMessage = z.infer<typeof subAgentFinishMessageSchema>;

export const validateMessage = (message: unknown): Message | null => {
  const result = messageSchema.safeParse(message);
  if (!result.success) {
    return null;
  }

  return result.data;
};

/**
 * Build the durable-stream URL for a single agent run.
 *
 * Streams are per-run (not per-task): each run gets a fresh stream that is
 * created, appended to, then closed (EOF) when the run finishes. A durable
 * stream's close is terminal, so a per-task stream could only ever serve one
 * run — subsequent runs on the same task get their own `run-{runId}` stream.
 */
export const runStreamUrl = (baseUrl: string, runId: string): string => {
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/v1/stream/run-${runId}`;
};
