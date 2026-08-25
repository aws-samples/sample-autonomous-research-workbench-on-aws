"use client"

import { ArrowDownRight, ArrowUpRight, Timer } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"

import type { MetricsPart } from "./types"

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function formatTokens(count: number) {
  if (count < 1000) return count.toString()
  return `${(count / 1000).toFixed(1)}k`
}

/**
 * Compact run-metrics footer (duration / in / out tokens) with the full
 * token + cost breakdown on hover. Rendered under an assistant turn.
 */
export function Metrics({ metrics }: { metrics: MetricsPart }) {
  const t = useTranslations("Tasks.metrics")

  return (
    <HoverCard>
      <HoverCardTrigger className="group flex cursor-help gap-3 py-2 text-muted-foreground/50">
        <div className="flex items-center gap-1 transition-colors">
          <Timer className="size-3" />
          <span className="text-xs">{formatDuration(metrics.runDurationMs)}</span>
        </div>
        <div className="flex items-center gap-1 transition-colors">
          <ArrowUpRight className="size-3" />
          <span className="text-xs">{formatTokens(metrics.inputTokens)}</span>
        </div>
        <div className="flex items-center gap-1 transition-colors">
          <ArrowDownRight className="size-3" />
          <span className="text-xs">{formatTokens(metrics.outputTokens)}</span>
        </div>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-52 p-3"
      >
        <div className="space-y-1.5 text-xs">
          {(metrics.cacheReadTokens ?? 0) > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("cacheRead")}</span>
              <span className="font-mono tabular-nums">
                {metrics.cacheReadTokens?.toLocaleString()}
              </span>
            </div>
          )}
          {(metrics.cacheWriteTokens ?? 0) > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("cacheWrite")}</span>
              <span className="font-mono tabular-nums">
                {metrics.cacheWriteTokens?.toLocaleString()}
              </span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("input")}</span>
            <span className="font-mono tabular-nums">
              {metrics.inputTokens.toLocaleString()}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("output")}</span>
            <span className="font-mono tabular-nums">
              {metrics.outputTokens.toLocaleString()}
            </span>
          </div>
          <div className="flex justify-between border-t pt-1.5">
            <span className="font-medium">{t("total")}</span>
            <span className="font-mono font-medium tabular-nums">
              {(
                metrics.inputTokens +
                metrics.outputTokens +
                (metrics.cacheReadTokens ?? 0) +
                (metrics.cacheWriteTokens ?? 0)
              ).toLocaleString()}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("cost")}</span>
            <span className="font-mono tabular-nums">${metrics.runCost}</span>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
