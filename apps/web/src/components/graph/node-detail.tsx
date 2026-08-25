"use client"

import { useTranslations } from "next-intl"
import { Crosshair, ExternalLink, MousePointerClick } from "lucide-react"
import { createElement, useMemo } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { KIND_COLOR, KIND_ICON } from "./kind-style"
import {
  buildPlatformGraph,
  getNeighbourIds,
  type PlatformGraphNode,
} from "./platform-graph"
import type { HypothesisStatus } from "./project-graph-data"

const STATUS_CLASS: Record<HypothesisStatus, string> = {
  proposed: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  supported: "border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400",
  refuted: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
}

export function NodeDetail({
  selectedId,
  onSelect,
  onFocus,
}: {
  selectedId: string | null
  onSelect: (id: string | null) => void
  onFocus: (id: string) => void
}) {
  const t = useTranslations("GraphExplorer")
  const tLegend = useTranslations("GraphExplorer.legend")

  const { nodeById } = useMemo(() => {
    const graph = buildPlatformGraph()
    const map = new Map<string, PlatformGraphNode>()
    for (const n of graph.nodes) map.set(n.id, n)
    return { nodeById: map }
  }, [])

  const node = selectedId ? nodeById.get(selectedId) : undefined

  const neighbours = useMemo(() => {
    if (!selectedId) return []
    return getNeighbourIds(selectedId)
      .map((id) => nodeById.get(id))
      .filter((n): n is PlatformGraphNode => Boolean(n))
      .sort((a, b) => b.degree - a.degree)
  }, [selectedId, nodeById])

  const supporting = useMemo(
    () =>
      (node?.evidenceFor ?? [])
        .map((id) => nodeById.get(id))
        .filter((n): n is PlatformGraphNode => Boolean(n)),
    [node, nodeById]
  )
  const refuting = useMemo(
    () =>
      (node?.evidenceAgainst ?? [])
        .map((id) => nodeById.get(id))
        .filter((n): n is PlatformGraphNode => Boolean(n)),
    [node, nodeById]
  )

  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <MousePointerClick className="size-6 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">{t("detail.empty")}</p>
      </div>
    )
  }

  const KindIcon = KIND_ICON[node.kind]
  const meta = node.meta
  const hasMeta = Boolean(
    meta?.pmid || meta?.doi || meta?.jobId || meta?.reactomeId
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-3 border-b p-4">
        <div className="flex items-start gap-2.5">
          <span
            className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-white"
            style={{ backgroundColor: KIND_COLOR[node.kind] }}
          >
            {createElement(KindIcon, { className: "size-3.5" })}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] tracking-wide text-muted-foreground uppercase">
              {tLegend(node.kind)}
            </div>
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              {node.label}
            </h2>
          </div>
        </div>

        {(node.status || node.confidence) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {node.status ? (
              <span
                className={cn(
                  "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium",
                  STATUS_CLASS[node.status]
                )}
              >
                {t(`status.${node.status}`)}
              </span>
            ) : null}
            {node.confidence ? (
              <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground">
                {t("confidence.label")}: {t(`confidence.${node.confidence}`)}
              </span>
            ) : null}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => onFocus(node.id)}>
            <Crosshair className="size-3.5" />
            {t("detail.focus")}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-5">
          {node.agent ? (
            <Section label={t("detail.proposedBy")}>
              <p className="text-sm text-foreground">{node.agent}</p>
            </Section>
          ) : null}

          {node.summary ? (
            <Section label={t("detail.summary")}>
              <p className="text-sm leading-relaxed text-foreground">
                {node.summary}
              </p>
            </Section>
          ) : null}

          {node.reasoning ? (
            <Section label={t("detail.reasoning")}>
              <p className="rounded-md border-l-2 border-border bg-muted/40 px-3 py-2 text-sm leading-relaxed text-foreground/90">
                {node.reasoning}
              </p>
            </Section>
          ) : null}

          {supporting.length > 0 ? (
            <Section label={t("detail.supporting")}>
              <NodeList nodes={supporting} onSelect={onSelect} tLegend={tLegend} />
            </Section>
          ) : null}

          {refuting.length > 0 ? (
            <Section label={t("detail.refuting")}>
              <NodeList nodes={refuting} onSelect={onSelect} tLegend={tLegend} />
            </Section>
          ) : null}

          {hasMeta ? (
            <Section label={t("detail.metadata")}>
              <dl className="flex flex-col gap-1.5 text-xs">
                {meta?.pmid ? (
                  <MetaRow
                    label={t("detail.pmid")}
                    value={meta.pmid}
                    href={`https://pubmed.ncbi.nlm.nih.gov/${meta.pmid}/`}
                    linkLabel={t("detail.viewSource")}
                  />
                ) : null}
                {meta?.doi ? (
                  <MetaRow
                    label={t("detail.doi")}
                    value={meta.doi}
                    href={`https://doi.org/${meta.doi}`}
                    linkLabel={t("detail.viewSource")}
                  />
                ) : null}
                {meta?.jobId ? (
                  <MetaRow label={t("detail.jobId")} value={meta.jobId} />
                ) : null}
                {meta?.reactomeId ? (
                  <MetaRow
                    label={t("detail.reactomeId")}
                    value={meta.reactomeId}
                    href={`https://reactome.org/content/detail/${meta.reactomeId}`}
                    linkLabel={t("detail.viewSource")}
                  />
                ) : null}
              </dl>
            </Section>
          ) : null}

          <Section label={t("detail.connections")} count={neighbours.length}>
            {neighbours.length > 0 ? (
              <NodeList nodes={neighbours} onSelect={onSelect} tLegend={tLegend} />
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("detail.noConnections")}
              </p>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}

function Section({
  label,
  count,
  children,
}: {
  label: string
  count?: number
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </h3>
        {count != null ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function NodeList({
  nodes,
  onSelect,
  tLegend,
}: {
  nodes: PlatformGraphNode[]
  onSelect: (id: string | null) => void
  tLegend: (key: string) => string
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {nodes.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            onClick={() => onSelect(n.id)}
            className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-muted/50"
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: KIND_COLOR[n.kind] }}
            />
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {n.label}
            </span>
            <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground/70 uppercase">
              {tLegend(n.kind)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function MetaRow({
  label,
  value,
  href,
  linkLabel,
}: {
  label: string
  value: string
  href?: string
  linkLabel?: string
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-1.5 font-medium text-foreground tabular-nums">
        <span className="truncate">{value}</span>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-muted-foreground transition-colors hover:text-foreground"
            aria-label={linkLabel}
            title={linkLabel}
          >
            <ExternalLink className="size-3" />
          </a>
        ) : null}
      </dd>
    </div>
  )
}
