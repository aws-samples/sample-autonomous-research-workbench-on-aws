import {
  Check,
  FileSearch,
  Globe,
  Loader2,
  Network,
  PenLine,
  Sigma,
  Sparkles,
  Users,
  Waypoints,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react"

import type { StepStatus } from "./types"

/**
 * Maps a tool identifier to its icon. Known tools get a dedicated icon; anything
 * else falls back to a generic wrench.
 */
const TOOL_ICON: Record<string, LucideIcon> = {
  currentDateTime: Sparkles,
  webSearch: Globe,
  web_search: Globe,
  queryDocuments: FileSearch,
  getDocument: FileSearch,
  getDocumentPage: FileSearch,
  graphSearch: Network,
  graphNeighborhood: Network,
  graphPaths: Waypoints,
  graphOverview: Network,
  graphDocumentFacts: Network,
  graphAddFact: PenLine,
  epistemicProposeHypothesis: Sigma,
  epistemicRecordObservation: PenLine,
  epistemicLinkEvidence: Waypoints,
  epistemicSetHypothesisStatus: Sigma,
  epistemicRecordDecision: PenLine,
  epistemicListHypotheses: Sigma,
  epistemicListEvidence: Sigma,
  runSubagent: Users,
  run_subagent: Users,
  // Pre-rename tool names. Task rows persist the toolName they were called
  // with, so historical timelines still resolve their icon here.
  searchGraph: Network,
  getEntityNeighborhood: Network,
  findPaths: Waypoints,
  getGraphOverview: Network,
  getDocumentFacts: Network,
  addGraphFact: PenLine,
  proposeHypothesis: Sigma,
  createObservation: PenLine,
  linkEvidence: Waypoints,
  updateHypothesisStatus: Sigma,
  recordDecision: PenLine,
  queryHypotheses: Sigma,
  getHypothesisEvidence: Sigma,
}

/**
 * Labels for tools whose generated name reads badly. `formatCamelCase` would
 * turn `epistemicProposeHypothesis` into "Epistemic Propose Hypothesis"; the
 * layer prefix is there for the model, not the reader. Pre-rename names are
 * included so historical task timelines stay readable.
 */
const TOOL_LABEL: Record<string, string> = {
  graphSearch: "Search Graph",
  graphNeighborhood: "Explore Entity",
  graphPaths: "Find Connections",
  graphOverview: "Graph Overview",
  graphDocumentFacts: "Document Facts",
  graphAddFact: "Add Fact",
  epistemicProposeHypothesis: "Propose Hypothesis",
  epistemicRecordObservation: "Record Observation",
  epistemicLinkEvidence: "Link Evidence",
  epistemicSetHypothesisStatus: "Update Hypothesis",
  epistemicRecordDecision: "Record Decision",
  epistemicListHypotheses: "Review Hypotheses",
  epistemicListEvidence: "Review Evidence",
  searchGraph: "Search Graph",
  getEntityNeighborhood: "Explore Entity",
  findPaths: "Find Connections",
  getGraphOverview: "Graph Overview",
  getDocumentFacts: "Document Facts",
  addGraphFact: "Add Fact",
  proposeHypothesis: "Propose Hypothesis",
  createObservation: "Record Observation",
  linkEvidence: "Link Evidence",
  updateHypothesisStatus: "Update Hypothesis",
  recordDecision: "Record Decision",
  queryHypotheses: "Review Hypotheses",
  getHypothesisEvidence: "Review Evidence",
}

export function getToolIcon(toolName: string): LucideIcon {
  return TOOL_ICON[toolName] ?? Wrench
}

export type ToolDisplay = {
  label: string
  description?: string
}

function toTitleWord(word: string): string {
  if (!word) return word
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

function formatSnakeOrKebabCase(toolName: string): string {
  return toolName
    .replace(/-/g, "_")
    .split("_")
    .filter(Boolean)
    .map(toTitleWord)
    .join(" ")
}

function formatCamelCase(toolName: string): string {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter(Boolean)
    .map((word) =>
      word.toUpperCase() === word && word.length <= 4 ? word : toTitleWord(word),
    )
    .join(" ")
}

/** Human-friendly label for a tool name, e.g. `web_search` -> `Web Search`. */
export function formatToolName(toolName: string): string {
  if (!toolName) return toolName
  const explicit = TOOL_LABEL[toolName]
  if (explicit) return explicit
  if (toolName.includes("_") || toolName.includes("-")) {
    return formatSnakeOrKebabCase(toolName)
  }
  return formatCamelCase(toolName)
}

export function getToolDisplay(toolName: string): ToolDisplay {
  return { label: formatToolName(toolName) }
}

export function statusIcon(status: StepStatus): LucideIcon {
  switch (status) {
    case "running":
      return Loader2
    case "error":
      return X
    case "completed":
    default:
      return Check
  }
}

export function statusIconClass(status: StepStatus): string {
  switch (status) {
    case "running":
      return "animate-spin text-blue-500"
    case "error":
      return "text-red-500"
    case "completed":
    default:
      return "text-emerald-500"
  }
}

export function statusBadgeClass(status: StepStatus): string {
  switch (status) {
    case "running":
      return "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400"
    case "error":
      return "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
    case "completed":
    default:
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
  }
}
