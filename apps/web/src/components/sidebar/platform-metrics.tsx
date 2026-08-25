"use client"

import { useQuery } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { Lightbulb, Network, Activity, Plug } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { orpc } from "@/orpc/client"

type Metric = {
  key: "hypotheses" | "graph" | "tasks" | "sources"
  icon: LucideIcon
  value: string
}

const METRICS: Metric[] = [
  { key: "hypotheses", icon: Lightbulb, value: "1,842" },
  { key: "graph", icon: Network, value: "1.2M" },
  { key: "tasks", icon: Activity, value: "7" },
  { key: "sources", icon: Plug, value: "X" },
]

export function PlatformMetrics() {
  const t = useTranslations("AppShell.metrics")

  // "Active Research" reads a live count of active projects from the DB.
  const activeCount = useQuery(
    orpc.projects.activeCount.queryOptions({ input: {} }),
  )

  // "Knowledge Graph" reads a static placeholder from the API.
  const graphStats = useQuery(orpc.graph.getStats.queryOptions({ input: {} }))

  // "Active Hypotheses" reads live Hypothesis counts (+ 7-day delta) from Neptune.
  const hypothesisStats = useQuery(
    orpc.graph.getHypothesisStats.queryOptions({ input: {} }),
  )

  const compact = (n: number) =>
    new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n)

  const graphValue = graphStats.isPending
    ? "—"
    : (graphStats.data?.value ?? "X")

  const hypothesisValue = hypothesisStats.isPending
    ? "—"
    : compact(hypothesisStats.data?.total ?? 0)

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {METRICS.map(({ key, icon: Icon, value }) => {
        const displayValue =
          key === "tasks"
            ? activeCount.isPending
              ? "—"
              : String(activeCount.data?.count ?? 0)
            : key === "graph"
              ? graphValue
              : key === "hypotheses"
                ? hypothesisValue
                : value

        const displayDelta =
          key === "hypotheses"
            ? t("hypotheses.delta", {
                count: hypothesisStats.data?.lastWeek ?? 0,
              })
            : t(`${key}.delta`)
        return (
          <div
            key={key}
            className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2"
          >
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Icon className="size-3 shrink-0" strokeWidth={1.5} />
              <span className="truncate text-[10px] font-medium tracking-wide uppercase">
                {t(`${key}.label`)}
              </span>
            </div>
            <div className="text-xl leading-none font-semibold tracking-tight tabular-nums text-foreground">
              {displayValue}
            </div>
            <div className="truncate text-[10px] text-muted-foreground/70">
              {displayDelta}
            </div>
          </div>
        )
      })}
    </div>
  )
}
