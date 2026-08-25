"use client"

import { useLiveQuery } from "@tanstack/react-db"
import { useMemo } from "react"

import type {
  AssistantMessage,
  AssistantPart,
  ChatMessage,
  MetricsPart,
  ToolPart,
} from "@/components/tasks/types"
import {
  taskMessagesCollection,
  type TaskMessageRow,
} from "@/db-collections/task-messages"

/**
 * Persisted conversation history for the Team Lead thread, synced from the
 * `task_message` table via Electric SQL and mapped into the chat view model.
 *
 * Rows are written by `projects.lead.send` (the user message) and by the
 * worker's `StreamRuntime` (assistant text/reasoning blocks, tool rows,
 * platform metrics/errors). Each assistant block is its own row, so
 * consecutive assistant/tool rows are regrouped into a single
 * `AssistantMessage` with ordered parts.
 */
export function useLeadMessages(taskId: string | null): {
  messages: ChatMessage[]
  isLoading: boolean
  /** True while the trailing message is from the user (reply still in flight). */
  isThinking: boolean
  /**
   * The in-flight run's id, recovered from the trailing user row's
   * `metadata.runId` (persisted by `projects.lead.send`). Lets the UI tail
   * the live token stream — including after a mid-run reload. Null once the
   * reply lands (the trailing row is no longer the user's).
   */
  pendingRunId: string | null
} {
  const collection = useMemo(
    () => (taskId ? taskMessagesCollection(taskId) : null),
    [taskId]
  )

  const { data: rows, isLoading } = useLiveQuery(
    (q) => (collection ? q.from({ message: collection }) : null),
    [collection]
  )

  return useMemo(() => {
    if (!collection) {
      return {
        messages: [],
        isLoading: false,
        isThinking: false,
        pendingRunId: null,
      }
    }
    const sorted = [...(rows ?? [])].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    )
    const last = sorted[sorted.length - 1]
    const isThinking = last?.role === "user"
    return {
      messages: mapRows(sorted),
      isLoading,
      isThinking,
      pendingRunId: isThinking ? metadataRunId(last?.metadata) : null,
    }
  }, [collection, rows, isLoading])
}

function metadataRunId(metadata: unknown): string | null {
  if (
    metadata &&
    typeof metadata === "object" &&
    "runId" in metadata &&
    typeof (metadata as { runId: unknown }).runId === "string"
  ) {
    return (metadata as { runId: string }).runId
  }
  return null
}

function mapRows(sorted: TaskMessageRow[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  let currentAssistant: AssistantMessage | null = null

  for (const row of sorted) {
    if (row.role === "user") {
      currentAssistant = null
      messages.push({ id: row.id, role: "user", text: userText(row.content) })
      continue
    }

    if (row.role === "assistant" || row.role === "tool") {
      const part =
        row.role === "assistant"
          ? toAssistantPart(row.content)
          : toToolPart(row.content)
      if (!part) continue
      if (!currentAssistant) {
        currentAssistant = { id: row.id, role: "assistant", parts: [] }
        messages.push(currentAssistant)
      }
      currentAssistant.parts.push(part)
      continue
    }

    // Platform rows carry metrics/errors/suggestions; attach metrics to the
    // current assistant turn, surface errors inline, ignore the rest.
    if (row.role === "platform") {
      const metrics = toMetricsPart(row.content)
      if (metrics) {
        if (currentAssistant) {
          currentAssistant.parts.push(metrics)
        }
        continue
      }
      const error = toErrorText(row.content)
      if (error) {
        currentAssistant = null
        messages.push({
          id: row.id,
          role: "assistant",
          parts: [{ type: "text", text: error }],
        })
      }
      continue
    }

    currentAssistant = null
  }

  return messages
}

/** User rows store `{ type: "text", text }` (or a bare string historically). */
function userText(content: unknown): string {
  if (typeof content === "string") return content
  if (
    content &&
    typeof content === "object" &&
    "text" in content &&
    typeof (content as { text: unknown }).text === "string"
  ) {
    return (content as { text: string }).text
  }
  return ""
}

/**
 * Assistant rows store one block: `{ type: "text" | "reasoning", text }`.
 * Reasoning blocks are skipped — the lead chat renders final answers only.
 */
function toAssistantPart(content: unknown): AssistantPart | null {
  if (
    content &&
    typeof content === "object" &&
    "type" in content &&
    "text" in content
  ) {
    const { type, text } = content as { type: string; text: unknown }
    if (type === "text" && typeof text === "string") {
      return { type: "text", text }
    }
  }
  return null
}

/** Friendly labels for the Team Lead's tools (shared with the live stream). */
export const TOOL_LABEL: Record<string, string> = {
  listProjectAgents: "Checking the team",
  startProjectAgent: "Starting an agent",
  stopProjectAgent: "Stopping an agent",
  getAgentProgress: "Reviewing progress",
}

/**
 * Tool rows store `{ toolCallId, name, input, output }`. A persisted tool row
 * is always a completed call (failures surface as a platform error row).
 */
function toToolPart(content: unknown): ToolPart | null {
  if (!content || typeof content !== "object" || !("toolCallId" in content)) {
    return null
  }
  const c = content as { toolCallId?: unknown; name?: unknown }
  if (typeof c.toolCallId !== "string") return null
  const toolName = typeof c.name === "string" ? c.name : "unknown"
  return {
    type: "tool",
    stepId: c.toolCallId,
    toolName,
    label: TOOL_LABEL[toolName] ?? toolName,
    status: "completed",
  }
}

/**
 * Metrics platform rows store the shape written by `StreamRuntime`'s
 * `onRunComplete`: `{ type: "metrics", runCost, runDurationMs, ... }`.
 */
function toMetricsPart(content: unknown): MetricsPart | null {
  if (
    !content ||
    typeof content !== "object" ||
    (content as { type?: unknown }).type !== "metrics"
  ) {
    return null
  }
  const c = content as Record<string, unknown>
  if (
    typeof c.runCost !== "string" ||
    typeof c.runDurationMs !== "number" ||
    typeof c.inputTokens !== "number" ||
    typeof c.outputTokens !== "number"
  ) {
    return null
  }
  return {
    type: "metrics",
    runCost: c.runCost,
    runDurationMs: c.runDurationMs,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    cacheReadTokens:
      typeof c.cacheReadTokens === "number" ? c.cacheReadTokens : undefined,
    cacheWriteTokens:
      typeof c.cacheWriteTokens === "number" ? c.cacheWriteTokens : undefined,
  }
}

function toErrorText(content: unknown): string | null {
  if (
    content &&
    typeof content === "object" &&
    "type" in content &&
    (content as { type: unknown }).type === "error" &&
    "message" in content &&
    typeof (content as { message: unknown }).message === "string"
  ) {
    return (content as { message: string }).message
  }
  return null
}
