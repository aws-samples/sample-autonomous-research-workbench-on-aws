"use client"

import { useTranslations } from "next-intl"
import { Network, PanelRightIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"

import { Button } from "@/components/ui/button"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { cn } from "@/lib/utils"

import { GraphCanvas } from "./graph-canvas-lazy"
import type { SigmaGraphData } from "./graph-canvas-types"
import { KIND_COLOR, KIND_ORDER, nodeRadius } from "./kind-style"
import { NodeDetail } from "./node-detail"
import {
  buildPlatformGraph,
  getNeighbourhood,
  getPlatformNode,
} from "./platform-graph"

export function GraphExplorer({
  title,
  padded = true,
}: {
  title?: string
  padded?: boolean
} = {}) {
  const t = useTranslations("GraphExplorer")
  const tLegend = useTranslations("GraphExplorer.legend")
  const heading = title ?? t("title")

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)

  const panelRef = useRef<PanelImperativeHandle>(null)
  const [collapsed, setCollapsed] = useState(false)

  const fullGraph = useMemo(() => buildPlatformGraph(), [])
  const graph = useMemo(
    () => (focusId ? getNeighbourhood(focusId, 1) : fullGraph),
    [focusId, fullGraph]
  )

  // Map the domain graph to the canvas's generic shape: kind → color, kind +
  // degree → size.
  const sigmaGraph = useMemo<SigmaGraphData>(
    () => ({
      nodes: graph.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        color: KIND_COLOR[n.kind],
        size: nodeRadius(n.kind, n.degree),
      })),
      links: graph.links.map((l) => ({
        source: String(l.source),
        target: String(l.target),
      })),
    }),
    [graph]
  )

  const legend = useMemo(
    () =>
      KIND_ORDER.map((kind) => ({
        label: tLegend(kind),
        color: KIND_COLOR[kind],
      })),
    [tLegend]
  )

  const focusNode = focusId ? getPlatformNode(focusId) : undefined

  const handleSelect = (id: string | null) => {
    setSelectedId(id)
    if (id && collapsed) {
      panelRef.current?.expand()
    }
  }

  const handleFocus = (id: string) => {
    setFocusId(id)
    setSelectedId(id)
    if (collapsed) panelRef.current?.expand()
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        e.preventDefault()
        const panel = panelRef.current
        if (!panel) return
        if (panel.isCollapsed()) panel.expand()
        else panel.collapse()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden",
        padded && "p-2"
      )}
    >
      <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <Network className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 items-center gap-1.5 text-sm">
              <button
                type="button"
                onClick={() => {
                  setFocusId(null)
                }}
                className={cn(
                  "truncate transition-colors",
                  focusId
                    ? "text-muted-foreground hover:text-foreground"
                    : "font-medium text-foreground"
                )}
              >
                {heading}
              </button>
              {focusNode ? (
                <>
                  <span className="text-muted-foreground/50">/</span>
                  <span className="truncate font-medium text-foreground">
                    {focusNode.label}
                  </span>
                </>
              ) : null}
            </div>
            <span className="ml-1 shrink-0 text-xs text-muted-foreground tabular-nums">
              {t("nodeCount", { count: graph.nodes.length })}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {focusId ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFocusId(null)}
              >
                {t("showFullGraph")}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={
                collapsed ? t("toolbar.showPanel") : t("toolbar.hidePanel")
              }
              title={collapsed ? t("toolbar.showPanel") : t("toolbar.hidePanel")}
              onClick={() => {
                const panel = panelRef.current
                if (!panel) return
                if (panel.isCollapsed()) panel.expand()
                else panel.collapse()
              }}
            >
              <PanelRightIcon />
            </Button>
          </div>
        </header>

        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="70%" minSize="40%">
            <GraphCanvas
              graph={sigmaGraph}
              legend={legend}
              selectedId={selectedId}
              onSelect={handleSelect}
              onFocus={handleFocus}
            />
          </ResizablePanel>
          <ResizableHandle
            withHandle
            className={cn(collapsed && "hidden")}
          />
          <ResizablePanel
            panelRef={panelRef}
            defaultSize="30%"
            minSize="22%"
            collapsible
            onResize={(size) => setCollapsed(size.asPercentage <= 0)}
          >
            <div className="h-full overflow-hidden bg-background/40">
              <NodeDetail
                selectedId={selectedId}
                onSelect={handleSelect}
                onFocus={handleFocus}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  )
}
