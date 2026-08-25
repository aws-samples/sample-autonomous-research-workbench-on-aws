"use client"

/**
 * Sigma.js canvas built on @react-sigma/core: `SigmaContainer` owns the
 * renderer lifecycle and provides it through context, while small hook
 * components load the graph, register events, and drive settings.
 *
 * Data is generic — consumers map their domain nodes to `{id, label, color,
 * size}` and pass legend entries — so the same canvas serves the static
 * platform graph and the live cluster graph.
 *
 * `allowInvalidContainer` is on because the canvas can mount inside a hidden
 * tab panel (display: none) — e.g. the Project Graph tab, which stays mounted
 * so layout/zoom state survives tab switches. Sigma v3 only reacts to window
 * resize, so `AutoResize` observes the container and resizes the renderer
 * when the tab becomes visible.
 *
 * This module touches WebGL globals at import time (sigma), so it must only
 * load in the browser — import it through `graph-canvas-lazy.tsx`.
 */
import "@react-sigma/core/lib/style.css"

import {
  SigmaContainer,
  useLoadGraph,
  useRegisterEvents,
  useSetSettings,
  useSigma,
} from "@react-sigma/core"
import { NodeBorderProgram } from "@sigma/node-border"
import Graph from "graphology"
import { circular } from "graphology-layout"
import forceAtlas2 from "graphology-layout-forceatlas2"
import { Minus, Plus, RotateCcw, Tag } from "lucide-react"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useMemo, useState } from "react"

import { cn } from "@/lib/utils"

import type {
  GraphCanvasProps,
  SigmaGraphData,
} from "./graph-canvas-types"

const MIN_ZOOM = 0.25
const MAX_ZOOM = 4

interface ThemeColors {
  background: string
  foreground: string
  primary: string
}

const THEME_FALLBACK: ThemeColors = {
  background: "#ffffff",
  foreground: "#0a0a0a",
  primary: "#171717",
}

// Sigma draws to WebGL, so theme colors must be concrete values, not CSS
// variables. The canvas fillStyle round-trip normalizes whatever format the
// theme uses (oklch under Tailwind v4) into hex Sigma can parse.
function resolveThemeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement)
  const ctx = document.createElement("canvas").getContext("2d")
  const resolve = (cssVar: string, fallback: string) => {
    const raw = style.getPropertyValue(cssVar).trim()
    if (!raw || !ctx) return fallback
    ctx.fillStyle = fallback
    ctx.fillStyle = raw
    return typeof ctx.fillStyle === "string" ? ctx.fillStyle : fallback
  }
  return {
    background: resolve("--background", THEME_FALLBACK.background),
    foreground: resolve("--foreground", THEME_FALLBACK.foreground),
    primary: resolve("--primary", THEME_FALLBACK.primary),
  }
}

function withAlpha(color: string, alpha: number): string {
  if (!color.startsWith("#") || color.length < 7) return color
  const r = Number.parseInt(color.slice(1, 3), 16)
  const g = Number.parseInt(color.slice(3, 5), 16)
  const b = Number.parseInt(color.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Sigma v3 only listens to window resize; when the container's own box
 * changes (tab reveal, panel drag) the renderer keeps its stale — possibly
 * 1x1 — dimensions. Observe the container and resize the renderer to match.
 */
function AutoResize() {
  const sigma = useSigma()

  useEffect(() => {
    const container = sigma.getContainer()
    const observer = new ResizeObserver(() => {
      const { width, height } = sigma.getDimensions()
      if (
        container.offsetWidth !== width ||
        container.offsetHeight !== height
      ) {
        sigma.resize()
        sigma.refresh()
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [sigma])

  return null
}

/** Builds the graphology graph, runs layout, and wires interaction events. */
function GraphLoader({
  graph,
  onSelect,
  onFocus,
}: {
  graph: SigmaGraphData
  onSelect: (id: string | null) => void
  onFocus: (id: string) => void
}) {
  const sigma = useSigma()
  const loadGraph = useLoadGraph()
  const registerEvents = useRegisterEvents()

  useEffect(() => {
    const g = new Graph()
    for (const n of graph.nodes) {
      g.mergeNode(n.id, {
        label: n.label,
        size: n.size,
        color: n.color,
      })
    }
    for (const l of graph.links) {
      g.mergeEdge(String(l.source), String(l.target), {
        baseColor: l.color,
      })
    }

    circular.assign(g)
    forceAtlas2.assign(g, {
      iterations: 300,
      settings: {
        ...forceAtlas2.inferSettings(g),
        adjustSizes: true,
      },
    })

    loadGraph(g)
  }, [graph, loadGraph])

  useEffect(() => {
    // Node dragging: Sigma pans the stage by default, so while a node is
    // held we move it instead and suppress the camera.
    let draggedNode: string | null = null
    let hasDragged = false
    const g = sigma.getGraph()

    registerEvents({
      downNode: (e) => {
        draggedNode = e.node
        hasDragged = false
      },
      moveBody: ({ event }) => {
        if (!draggedNode) return
        hasDragged = true
        const pos = sigma.viewportToGraph(event)
        g.setNodeAttribute(draggedNode, "x", pos.x)
        g.setNodeAttribute(draggedNode, "y", pos.y)
        event.preventSigmaDefault()
        event.original.preventDefault()
        event.original.stopPropagation()
      },
      upNode: () => {
        draggedNode = null
      },
      upStage: () => {
        draggedNode = null
      },
      clickNode: (e) => {
        if (hasDragged) {
          hasDragged = false
          return
        }
        onSelect(e.node)
      },
      clickStage: () => onSelect(null),
      doubleClickNode: (e) => {
        e.preventSigmaDefault()
        onFocus(e.node)
      },
    })
  }, [sigma, registerEvents, onSelect, onFocus])

  return null
}

/**
 * Selection highlighting: the selected node keeps its neighbourhood lit,
 * everything else dims. Reducers are re-set whenever selection or theme
 * changes, per the react-sigma pattern.
 */
function SelectionHighlight({
  selectedId,
  adjacency,
  theme,
}: {
  selectedId: string | null
  adjacency: Map<string, Set<string>>
  theme: ThemeColors
}) {
  const sigma = useSigma()
  const setSettings = useSetSettings()

  useEffect(() => {
    sigma.setSetting("labelColor", {
      color: withAlpha(theme.foreground, 0.8),
    })
  }, [sigma, theme])

  useEffect(() => {
    const g = sigma.getGraph()
    setSettings({
      nodeReducer: (node, data) => {
        const selected = node === selectedId
        const dimmed =
          selectedId != null &&
          !selected &&
          !adjacency.get(selectedId)?.has(node)
        return {
          ...data,
          color: dimmed
            ? withAlpha(String(data.color), 0.25)
            : (data.color as string),
          label: dimmed ? null : (data.label as string),
          borderColor: selected ? theme.primary : theme.background,
          size: selected ? (data.size as number) + 2 : (data.size as number),
        }
      },
      edgeReducer: (edge, data) => {
        const [s, tg] = g.extremities(edge)
        const active =
          selectedId != null && (s === selectedId || tg === selectedId)
        const dimmed = selectedId != null && !active
        // Edges the consumer gave no color of their own default to plain white,
        // clearly visible on the dark canvas; only the alpha varies with
        // selection state.
        const base = (data.baseColor as string | undefined) ?? "#ffffff"
        return {
          ...data,
          color: withAlpha(base, active ? 0.9 : dimmed ? 0.08 : 0.4),
          size: active ? 1.5 : 1,
        }
      },
    })
  }, [sigma, setSettings, selectedId, adjacency, theme])

  return null
}

/** Toolbar + zoom readout, driven by the sigma camera from context. */
function GraphControls() {
  const t = useTranslations("GraphExplorer")
  const sigma = useSigma()
  const [showLabels, setShowLabels] = useState(true)
  const [zoomPct, setZoomPct] = useState(100)

  useEffect(() => {
    const camera = sigma.getCamera()
    const onCameraUpdate = () => setZoomPct(Math.round(100 / camera.ratio))
    camera.on("updated", onCameraUpdate)
    onCameraUpdate()
    return () => {
      camera.off("updated", onCameraUpdate)
    }
  }, [sigma])

  useEffect(() => {
    sigma.setSetting("renderLabels", showLabels)
  }, [sigma, showLabels])

  const zoomBy = useCallback(
    (factor: number) => {
      const camera = sigma.getCamera()
      const ratio = Math.min(
        1 / MIN_ZOOM,
        Math.max(1 / MAX_ZOOM, camera.ratio / factor)
      )
      camera.animate({ ratio }, { duration: 200 })
    },
    [sigma]
  )

  const resetView = useCallback(() => {
    sigma.getCamera().animatedReset({ duration: 300 })
  }, [sigma])

  return (
    <>
      <div className="absolute top-3 right-3 z-10 flex gap-1">
        <ToolbarButton
          active={showLabels}
          label={t("toolbar.labels")}
          onClick={() => setShowLabels((v) => !v)}
        >
          <Tag className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton label={t("toolbar.zoomIn")} onClick={() => zoomBy(1.25)}>
          <Plus className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton label={t("toolbar.zoomOut")} onClick={() => zoomBy(0.8)}>
          <Minus className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton label={t("toolbar.reset")} onClick={resetView}>
          <RotateCcw className="size-3.5" />
        </ToolbarButton>
      </div>

      <div className="absolute right-3 bottom-3 z-10 rounded-md border bg-card/90 px-2 py-1 text-[10px] text-muted-foreground tabular-nums backdrop-blur">
        {zoomPct}%
      </div>
    </>
  )
}

export function GraphCanvas({
  graph,
  legend,
  selectedId,
  onSelect,
  onFocus,
}: GraphCanvasProps) {
  const t = useTranslations("GraphExplorer")

  // Resolved theme colors, re-read when light/dark mode flips.
  const [theme, setTheme] = useState<ThemeColors>(THEME_FALLBACK)
  useEffect(() => {
    setTheme(resolveThemeColors())
    const observer = new MutationObserver(() => setTheme(resolveThemeColors()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [])

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const l of graph.links) {
      const s = String(l.source)
      const tg = String(l.target)
      if (!map.has(s)) map.set(s, new Set())
      if (!map.has(tg)) map.set(tg, new Set())
      map.get(s)?.add(tg)
      map.get(tg)?.add(s)
    }
    return map
  }, [graph])

  // Static settings only — anything dynamic (labelColor, renderLabels,
  // reducers) is applied through the sigma instance so the renderer isn't
  // recreated on every change.
  const settings = useMemo(
    () => ({
      allowInvalidContainer: true,
      minCameraRatio: 1 / MAX_ZOOM,
      maxCameraRatio: 1 / MIN_ZOOM,
      defaultNodeType: "border",
      nodeProgramClasses: { border: NodeBorderProgram },
      labelSize: 10,
      labelFont: "ui-sans-serif, system-ui, sans-serif",
      labelRenderedSizeThreshold: 0,
      defaultEdgeColor: "rgba(255, 255, 255, 0.4)",
    }),
    []
  )

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-background"
      role="img"
      aria-label={t("toolbar.ariaLabel")}
    >
      <SigmaContainer
        settings={settings}
        className="h-full w-full touch-none select-none !bg-transparent"
      >
        <AutoResize />
        <GraphLoader graph={graph} onSelect={onSelect} onFocus={onFocus} />
        <SelectionHighlight
          selectedId={selectedId}
          adjacency={adjacency}
          theme={theme}
        />
        <GraphControls />
      </SigmaContainer>

      <div className="absolute bottom-3 left-3 z-10 flex max-h-[60%] flex-col gap-1 overflow-auto rounded-lg border bg-card/90 p-2 backdrop-blur">
        {legend.map((item) => (
          <div key={item.label} className="flex items-center gap-1.5">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span className="text-[10px] text-muted-foreground">
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default GraphCanvas

function ToolbarButton({
  active,
  label,
  onClick,
  children,
}: {
  active?: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md border transition-colors",
        active
          ? "bg-foreground text-background"
          : "bg-card text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}
