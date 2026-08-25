"use client"

import { useQuery } from "@tanstack/react-query"
import { CircleDollarSign, Cpu, ListChecks, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis } from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import { client } from "@/orpc/client"

import type { Project } from "./types"

interface MetricsData {
  maxBudgetUsd: number | null
  budgetExceededAt: string | null
  totals: {
    spendUsd: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    totalRuns: number
    succeededRuns: number
    failedRuns: number
    cancelledRuns: number
    activeRuns: number
  }
  daily: {
    date: string
    costUsd: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
  }[]
  byAgent: {
    agentType: string
    displayName: string | null
    costUsd: number
    runs: number
  }[]
}

const FALLBACK_AGENT_COLOR = "#64748b"

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return `${Math.round(tokens)}`
}

function formatDay(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function ProjectMetrics({ project }: { project: Project }) {
  const t = useTranslations("Projects")

  const { data, isPending } = useQuery<MetricsData>({
    queryKey: ["projects", project.id, "metrics"],
    queryFn: () => client.projects.metrics({ id: project.id }),
    enabled: Boolean(project.live),
    refetchInterval: 30_000,
  })

  if (!project.live) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">
        {t("metrics.sampleUnavailable")}
      </div>
    )
  }

  if (isPending || !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const { totals } = data
  const totalTokens =
    totals.inputTokens +
    totals.outputTokens +
    totals.cacheReadTokens +
    totals.cacheWriteTokens
  const hasData = totals.totalRuns > 0

  if (!hasData) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">
        {t("metrics.empty")}
      </div>
    )
  }

  const budgetPct =
    data.maxBudgetUsd && data.maxBudgetUsd > 0
      ? Math.min(100, (totals.spendUsd / data.maxBudgetUsd) * 100)
      : null
  const overBudget =
    data.maxBudgetUsd !== null && totals.spendUsd >= data.maxBudgetUsd

  const spendConfig: ChartConfig = {
    costUsd: {
      label: t("metrics.charts.spend"),
      color: "var(--chart-1)",
    },
  }

  const tokensConfig: ChartConfig = {
    inputTokens: {
      label: t("metrics.charts.inputTokens"),
      color: "var(--chart-1)",
    },
    outputTokens: {
      label: t("metrics.charts.outputTokens"),
      color: "var(--chart-2)",
    },
    cacheReadTokens: {
      label: t("metrics.charts.cacheReadTokens"),
      color: "var(--chart-3)",
    },
  }

  const maxAgentCost = Math.max(...data.byAgent.map((a) => a.costUsd), 0)

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6 pt-4">
      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-3">
        <Card size="sm">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <CircleDollarSign className="size-3.5" strokeWidth={1.75} />
              {t("metrics.totalSpend")}
            </CardDescription>
            <CardTitle
              className={cn(
                "text-xl tabular-nums",
                overBudget && "text-destructive"
              )}
            >
              ${totals.spendUsd.toFixed(2)}
            </CardTitle>
          </CardHeader>
          {budgetPct !== null && (
            <CardContent className="space-y-1">
              <Progress
                value={budgetPct}
                className={cn(overBudget && "[&>div]:bg-destructive")}
              />
              <p className="text-[11px] text-muted-foreground tabular-nums">
                {t("metrics.ofBudget", {
                  budget: data.maxBudgetUsd!.toFixed(0),
                })}
              </p>
            </CardContent>
          )}
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <Cpu className="size-3.5" strokeWidth={1.75} />
              {t("metrics.totalTokens")}
            </CardDescription>
            <CardTitle className="text-xl tabular-nums">
              {formatTokens(totalTokens)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {t("metrics.tokenSplit", {
                input: formatTokens(totals.inputTokens),
                output: formatTokens(totals.outputTokens),
                cached: formatTokens(totals.cacheReadTokens),
              })}
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <ListChecks className="size-3.5" strokeWidth={1.75} />
              {t("metrics.runs")}
            </CardDescription>
            <CardTitle className="text-xl tabular-nums">
              {totals.totalRuns}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {t("metrics.runsBreakdown", {
                succeeded: totals.succeededRuns,
                failed: totals.failedRuns,
                active: totals.activeRuns,
              })}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Daily spend */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t("metrics.charts.spendTitle")}</CardTitle>
          <CardDescription>
            {t("metrics.charts.spendDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={spendConfig} className="h-48 w-full">
            <AreaChart data={data.daily} margin={{ left: 0, right: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={formatDay}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => formatDay(String(value))}
                    formatter={(value) => `$${Number(value).toFixed(4)}`}
                  />
                }
              />
              <Area
                dataKey="costUsd"
                type="monotone"
                fill="var(--color-costUsd)"
                fillOpacity={0.2}
                stroke="var(--color-costUsd)"
                strokeWidth={1.5}
              />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>

      {/* Daily tokens */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t("metrics.charts.tokensTitle")}</CardTitle>
          <CardDescription>
            {t("metrics.charts.tokensDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={tokensConfig} className="h-48 w-full">
            <BarChart data={data.daily} margin={{ left: 0, right: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={formatDay}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => formatDay(String(value))}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar
                dataKey="inputTokens"
                stackId="tokens"
                fill="var(--color-inputTokens)"
              />
              <Bar
                dataKey="outputTokens"
                stackId="tokens"
                fill="var(--color-outputTokens)"
              />
              <Bar
                dataKey="cacheReadTokens"
                stackId="tokens"
                fill="var(--color-cacheReadTokens)"
                radius={[2, 2, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>

      {/* Spend by agent */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t("metrics.charts.byAgentTitle")}</CardTitle>
          <CardDescription>
            {t("metrics.charts.byAgentDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {data.byAgent.map((row) => {
            // displayName comes from the agents table (joined on agentType);
            // orchestrator/lead rows have no agent row, so they fall back to
            // the raw type.
            const label = row.displayName ?? row.agentType
            const color = FALLBACK_AGENT_COLOR
            const pct =
              maxAgentCost > 0 ? Math.max((row.costUsd / maxAgentCost) * 100, 1.5) : 0
            return (
              <div key={row.agentType} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate text-foreground">
                    {label}
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {t("metrics.charts.byAgentRow", {
                      cost: row.costUsd.toFixed(3),
                      runs: row.runs,
                    })}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full transition-[width]"
                    style={{ width: `${pct}%`, backgroundColor: color }}
                  />
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
