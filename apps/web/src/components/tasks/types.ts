export type TaskStatus = "running" | "completed" | "failed" | "timed_out"

export type StepStatus = "running" | "completed" | "error"

export interface UserMessage {
  id: string
  role: "user"
  text: string
}

export interface TextPart {
  type: "text"
  text: string
  /** True while live deltas are still arriving for this part. */
  streaming?: boolean
}

export interface ReasoningPart {
  type: "reasoning"
  text: string
  streaming?: boolean
  durationMs?: number
}

/** Lifecycle state of a tool invocation, mirroring the AI SDK tool part states. */
export type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"

export interface ToolPart {
  type: "tool"
  stepId: string
  toolName: string
  label: string
  description?: string
  status: StepStatus
  state?: ToolState
  input?: unknown
  output?: unknown
  errorText?: string
  /** Nested sub-agent activity spawned by a `run_subagent` call. */
  subAgent?: SubAgentSummary
}

/** Live/nested sub-agent transcript grouped under the spawning tool step. */
export interface SubAgentSummary {
  id: string
  name: string
  persona: string
  task: string
  status: StepStatus
  /** The sub-agent's own parts (text/reasoning/tool), in arrival order. */
  parts: AssistantPart[]
}

/**
 * A single tool invocation flattened out of the conversation for the steps
 * panel, ordered by occurrence.
 */
export interface ToolHistoryEntry {
  stepId: string
  index: number
  toolName: string
  label: string
  description?: string
  status: StepStatus
  input?: unknown
  output?: unknown
  errorText?: string
  subAgent?: SubAgentSummary
}

/** Run metrics persisted by the worker as a platform row after each turn. */
export interface MetricsPart {
  type: "metrics"
  /** Formatted USD cost of the run, e.g. "0.012". */
  runCost: string
  runDurationMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface SuggestionsPart {
  type: "suggestions"
  suggestions: string[]
}

export type AssistantPart =
  | TextPart
  | ReasoningPart
  | ToolPart
  | MetricsPart
  | SuggestionsPart

export interface AssistantMessage {
  id: string
  role: "assistant"
  parts: AssistantPart[]
}

export type ChatMessage = UserMessage | AssistantMessage

export interface Task {
  id: string
  title: string
  status: TaskStatus
  agent: string
  createdAt: string
  updatedAt?: string
  stepCount?: number
}
