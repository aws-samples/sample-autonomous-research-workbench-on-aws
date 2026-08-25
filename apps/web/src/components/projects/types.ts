import type { ChatMessage } from "@/components/tasks/types"

export type AgentState = "active" | "idle" | "blocked"

export type WorkItemState = "active" | "current" | "pending"

export interface AgentWorkItem {
  id: string
  title: string
  state: WorkItemState
  taskId?: string
}

export interface ProjectAgent {
  id: string
  displayName: string
  description: string
  state: AgentState
  currentTask?: string
  workItems: AgentWorkItem[]
  /**
   * Catalog agent id (uuid) for DB-backed projects. Sample/static projects
   * leave it unset, which disables the live status sync and run/stop actions.
   */
  agentId?: string
}

export type ProjectStatus = "draft" | "active" | "paused" | "completed"

export interface Project {
  id: string
  name: string
  summary: string
  status: ProjectStatus
  createdAt: string
  lead: {
    messages: ChatMessage[]
  }
  agents: ProjectAgent[]
  /**
   * True for DB-backed projects: enables Electric live sync, run/stop agent
   * actions, and the Team Lead chat. Sample projects render statically.
   */
  live?: boolean
  /** The Team Lead chat thread id (null until the first message is sent). */
  leadTaskId?: string | null
  /** Preferred model for Team Lead runs (null = platform default). */
  leadModel?: string | null
  /** Custom system prompt for Team Lead runs (null = platform default). */
  leadSystemPrompt?: string | null
  /** Hard spend cap in USD (null = no cap). */
  maxBudgetUsd?: number | null
  /** ISO timestamp set by the worker when spend crossed the cap. */
  budgetExceededAt?: string | null
}
