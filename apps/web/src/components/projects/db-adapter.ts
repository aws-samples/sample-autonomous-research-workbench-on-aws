import type { Project, ProjectStatus } from "./types"

// The shape returned by the projects.get / projects.list oRPC procedures.
export interface DbProject {
  id: string
  name: string
  status: string
  seedHypothesis: string
  checkInCadence: string | null
  leadModel?: string | null
  leadSystemPrompt?: string | null
  maxBudgetUsd?: number | null
  budgetExceededAt?: string | null
  leadTaskId?: string | null
  createdAt: string
  agents: { id: string; displayName: string; description: string }[]
}

const KNOWN_STATUSES: ProjectStatus[] = ["draft", "active", "paused", "completed"]

function toStatus(status: string): ProjectStatus {
  return (KNOWN_STATUSES as string[]).includes(status)
    ? (status as ProjectStatus)
    : "draft"
}

function kickoffText(project: DbProject): string {
  const parts: string[] = []
  if (project.maxBudgetUsd != null) parts.push(`budget: $${project.maxBudgetUsd}`)
  if (project.checkInCadence) parts.push(`check-ins ${project.checkInCadence}`)
  const constraints = parts.length ? ` (${parts.join(", ")})` : ""
  const agents =
    project.agents.length > 0
      ? ` I've assigned ${project.agents.length} agent${project.agents.length === 1 ? "" : "s"} to the program.`
      : ""
  return `Program scoped${constraints}.${agents}`
}

/**
 * Convert a DB-backed project (from oRPC) into the richer UI `Project` shape.
 * Live per-agent state comes from the Electric-synced `project_agent` shape at
 * render time (see `agent-roster.tsx`); the adapter only carries identity.
 */
export function dbProjectToUi(project: DbProject): Project {
  return {
    id: project.id,
    name: project.name,
    summary: project.seedHypothesis,
    status: toStatus(project.status),
    createdAt: project.createdAt,
    live: true,
    leadTaskId: project.leadTaskId ?? null,
    leadModel: project.leadModel ?? null,
    leadSystemPrompt: project.leadSystemPrompt ?? null,
    maxBudgetUsd: project.maxBudgetUsd ?? null,
    budgetExceededAt: project.budgetExceededAt ?? null,
    lead: {
      messages: [
        { id: "lead-user-1", role: "user", text: project.seedHypothesis },
        {
          id: "lead-assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: kickoffText(project) }],
        },
      ],
    },
    agents: project.agents.map((agent) => ({
      id: agent.id,
      agentId: agent.id,
      displayName: agent.displayName,
      description: agent.description,
      // Placeholder until the Electric-synced `project_agent` row hydrates the
      // real per-agent state in the roster.
      state: "idle",
      workItems: [],
    })),
  }
}
