import type { AgentState } from "./types"

export function agentStateClass(state: AgentState): string {
  switch (state) {
    case "active":
      return "bg-emerald-500"
    case "blocked":
      return "bg-red-500"
    case "idle":
    default:
      return "bg-muted-foreground/40"
  }
}
