import {
  Atom,
  Beaker,
  Bot,
  Cpu,
  Eye,
  FileText,
  Lightbulb,
  Target,
  type LucideIcon,
} from "lucide-react"

import type { ProjectNodeKind } from "./project-graph-data"

export const KIND_ORDER: ProjectNodeKind[] = [
  "hypothesis",
  "observation",
  "evidence",
  "paper",
  "simulation",
  "target",
  "agent",
  "entity",
]

export const KIND_COLOR: Record<ProjectNodeKind, string> = {
  hypothesis: "#dc2626", // red
  observation: "#2563eb", // blue
  evidence: "#d97706", // amber
  paper: "#7c3aed", // violet
  simulation: "#0d9488", // teal
  target: "#16a34a", // green
  agent: "#475569", // slate
  entity: "#9ca3af", // gray
}

export const KIND_ICON: Record<ProjectNodeKind, LucideIcon> = {
  hypothesis: Lightbulb,
  observation: Eye,
  evidence: Beaker,
  paper: FileText,
  simulation: Cpu,
  target: Target,
  agent: Bot,
  entity: Atom,
}

export const BASE_RADIUS: Record<ProjectNodeKind, number> = {
  hypothesis: 11,
  observation: 7,
  evidence: 7,
  paper: 6,
  simulation: 6,
  target: 9,
  agent: 8,
  entity: 6,
}

export function nodeRadius(kind: ProjectNodeKind, degree: number): number {
  return BASE_RADIUS[kind] + Math.min(degree, 8) * 0.7
}
