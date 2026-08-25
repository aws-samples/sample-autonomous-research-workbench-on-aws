import type { TaskStatus } from "./types"

export function taskStatusBadgeClass(status: TaskStatus): string {
  switch (status) {
    case "running":
      return "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400"
    case "failed":
    case "timed_out":
      return "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
    case "completed":
    default:
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
  }
}

export function formatTaskDateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
