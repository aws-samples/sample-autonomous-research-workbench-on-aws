'use client'

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  FileText,
  Loader2,
  MousePointerClick,
  Network,
  TriangleAlert,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { orpc } from '@/orpc/client'
import { cn } from '@/lib/utils'

import { GraphCanvas } from './graph-canvas-lazy'
import type { SigmaGraphData, SigmaGraphNode } from './graph-canvas-types'

// Stable, colorblind-friendly-ish palette assigned to node labels (groups).
const PALETTE = [
  '#2563eb',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#dc2626',
  '#0d9488',
  '#db2777',
  '#0891b2',
  '#ca8a04',
  '#4f46e5',
]

/**
 * The epistemic node labels get fixed colors rather than palette-by-index, so a
 * hypothesis is the same color in every project regardless of which labels
 * happen to be present. Anything else falls through to PALETTE. Values match
 * kind-style.ts, which the static project graph uses.
 */
const EG_GROUP_COLOR: Record<string, string> = {
  Hypothesis: '#dc2626', // red
  Observation: '#2563eb', // blue
  Decision: '#0d9488', // teal
  // Entities are the factual substrate the reasoning cites, not reasoning
  // itself — muted so they read as context behind the coloured EG nodes.
  Entity: '#9ca3af', // gray
}

// A hypothesis is the root a project's reasoning hangs off, so it reads larger
// than its evidence at equal degree; entities are cited leaves, so smallest.
const EG_GROUP_BASE_RADIUS: Record<string, number> = {
  Hypothesis: 11,
  Observation: 7,
  Decision: 8,
  Entity: 6,
}

/**
 * Evidence polarity is the load-bearing distinction in the epistemic graph —
 * an observation that refutes a hypothesis must not look like one that backs
 * it. Relations without a polarity keep the canvas's neutral edge.
 */
const RELATION_COLOR: Record<string, string> = {
  supports: '#16a34a', // green
  contradicts: '#dc2626', // red
}

/**
 * Key for the relation lookup behind the detail panel. Ids come from the
 * graph, so the separator is a character that cannot occur inside one — a
 * printable delimiter risks two distinct pairs mapping onto the same key.
 */
function pairKey(a: string, b: string): string {
  return `${a}\u0000${b}`
}

type LiveNode = {
  id: string
  label: string
  group: string
  properties: Record<string, unknown>
}
type LiveLink = { source: string; target: string; relation: string }
/** A neighbour plus how it connects to the selected node. */
type Neighbour = { node: LiveNode; relation?: string }

export function ClusterGraph({
  padded = true,
  showSidebarTrigger = false,
  projectId,
  title,
}: {
  padded?: boolean
  /** Show the app-sidebar toggle in the header (full-page graph view only). */
  showSidebarTrigger?: boolean
  /**
   * When set, render only the subgraph scoped to this project (facts the
   * agents wrote under it). When omitted, render the whole graph.
   */
  projectId?: string
  /** Root label shown in the header (defaults to "Cluster"). */
  title?: string
} = {}) {
  const rootLabel = title ?? 'Cluster'
  const { data, isPending, isError, error } = useQuery(
    projectId
      ? orpc.graph.getProjectGraph.queryOptions({ input: { projectId } })
      : orpc.graph.getGraph.queryOptions({ input: {} }),
  )

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const panelRef = useRef<PanelImperativeHandle>(null)
  const [collapsed, setCollapsed] = useState(false)

  const nodes = (data?.nodes ?? []) as LiveNode[]
  const links = (data?.links ?? []) as LiveLink[]

  // Distinct groups → stable color map + legend order. Epistemic labels take
  // their fixed color; the rest consume PALETTE in sorted order, skipping any
  // swatch a present epistemic label already claimed so no two groups collide.
  const { groups, colorForGroup } = useMemo(() => {
    const seen: string[] = []
    for (const n of nodes) if (!seen.includes(n.group)) seen.push(n.group)
    seen.sort()

    const taken = new Set<string>()
    for (const g of seen) {
      const fixed = EG_GROUP_COLOR[g]
      if (fixed) taken.add(fixed)
    }
    const available = PALETTE.filter((c) => !taken.has(c))

    const map = new Map<string, string>()
    let next = 0
    for (const g of seen) {
      const fixed = EG_GROUP_COLOR[g]
      map.set(
        g,
        fixed ?? available[next++ % available.length] ?? '#9ca3af',
      )
    }
    return {
      groups: seen,
      colorForGroup: (g: string) => map.get(g) ?? '#9ca3af',
    }
  }, [nodes])

  // Degree per node + adjacency for neighbourhood focus and the detail panel.
  // `relationByPair` remembers how each pair is connected so the detail panel
  // can name the relation — polarity must be legible without reading edge color.
  const { degreeById, adjacency, nodeById, relationByPair } = useMemo(() => {
    const degree = new Map<string, number>()
    const adj = new Map<string, Set<string>>()
    const byId = new Map<string, LiveNode>()
    const relations = new Map<string, string>()
    for (const n of nodes) byId.set(n.id, n)
    for (const l of links) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1)
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
      if (!adj.has(l.source)) adj.set(l.source, new Set())
      if (!adj.has(l.target)) adj.set(l.target, new Set())
      adj.get(l.source)?.add(l.target)
      adj.get(l.target)?.add(l.source)
      relations.set(pairKey(l.source, l.target), l.relation)
      relations.set(pairKey(l.target, l.source), l.relation)
    }
    return {
      degreeById: degree,
      adjacency: adj,
      nodeById: byId,
      relationByPair: relations,
    }
  }, [nodes, links])

  // The graph actually rendered — full, or a 1-hop neighbourhood when
  // focused — mapped to the canvas's generic shape (group → color, degree →
  // size).
  const graph = useMemo<SigmaGraphData>(() => {
    const visible = focusId
      ? new Set<string>([focusId, ...(adjacency.get(focusId) ?? [])])
      : null

    const graphNodes: SigmaGraphNode[] = nodes
      .filter((n) => !visible || visible.has(n.id))
      .map((n) => ({
        id: n.id,
        label: n.label,
        color: colorForGroup(n.group),
        size:
          (EG_GROUP_BASE_RADIUS[n.group] ?? 6) +
          Math.min(degreeById.get(n.id) ?? 0, 10) * 0.8,
      }))

    const graphLinks = links
      .filter((l) => !visible || (visible.has(l.source) && visible.has(l.target)))
      .map((l) => ({
        source: l.source,
        target: l.target,
        color: RELATION_COLOR[l.relation],
      }))

    return { nodes: graphNodes, links: graphLinks }
  }, [nodes, links, focusId, adjacency, degreeById, colorForGroup])

  const legend = useMemo(
    () => groups.map((g) => ({ label: g, color: colorForGroup(g) })),
    [groups, colorForGroup],
  )

  const selected = selectedId ? nodeById.get(selectedId) : undefined
  const focusNode = focusId ? nodeById.get(focusId) : undefined

  const neighbours = useMemo(() => {
    if (!selectedId) return []
    return [...(adjacency.get(selectedId) ?? [])]
      .flatMap<Neighbour>((id) => {
        const node = nodeById.get(id)
        if (!node) return []
        return [{ node, relation: relationByPair.get(pairKey(selectedId, id)) }]
      })
  }, [selectedId, adjacency, nodeById, relationByPair])

  const handleSelect = (id: string | null) => {
    setSelectedId(id)
    if (id && collapsed) panelRef.current?.expand()
  }

  const handleFocus = (id: string) => {
    setFocusId(id)
    setSelectedId(id)
    if (collapsed) panelRef.current?.expand()
  }

  return (
    <div className={cn('flex h-full flex-col overflow-hidden', padded && 'p-2')}>
      <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {showSidebarTrigger ? (
              <>
                <SidebarTrigger className="-ml-1 shrink-0 text-muted-foreground hover:text-foreground" />
                <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
              </>
            ) : null}
            <Network className="size-4 shrink-0 text-muted-foreground" />
            <button
              type="button"
              onClick={() => setFocusId(null)}
              className={cn(
                'truncate text-sm transition-colors',
                focusId
                  ? 'text-muted-foreground hover:text-foreground'
                  : 'font-medium text-foreground',
              )}
            >
              {rootLabel}
            </button>
            {focusNode ? (
              <>
                <span className="text-muted-foreground/50">/</span>
                <span className="truncate text-sm font-medium text-foreground">
                  {focusNode.label}
                </span>
              </>
            ) : null}
            {!isPending && !isError ? (
              <span className="ml-1 shrink-0 text-xs text-muted-foreground tabular-nums">
                {graph.nodes.length} nodes · {graph.links.length} edges
              </span>
            ) : null}
          </div>
          {focusId ? (
            <Button variant="outline" size="sm" onClick={() => setFocusId(null)}>
              Show full graph
            </Button>
          ) : null}
        </header>

        {isPending ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading graph…
          </div>
        ) : isError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-destructive">
            <TriangleAlert className="size-5" />
            <p>Failed to load graph.</p>
            <p className="max-w-md text-center text-xs text-muted-foreground">
              {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </div>
        ) : graph.nodes.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
            <Network className="size-6 text-muted-foreground/40" />
            <p>{projectId ? 'No reasoning recorded yet.' : 'The graph is empty'}</p>
            <p className="text-xs">
              {projectId
                ? 'Hypotheses, observations, and decisions your agents record will appear here.'
                : 'Upload and sync documents in Settings → Knowledge to populate the graph'}
            </p>
            {!projectId ? (
              <Button asChild variant="outline" size="sm" className="mt-2">
                <Link to="/settings" search={{ tab: 'knowledge' }}>
                  <FileText className="size-4" />
                  Go to Knowledge
                </Link>
              </Button>
            ) : null}
          </div>
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
            <ResizablePanel defaultSize="70%" minSize="40%">
              <GraphCanvas
                graph={graph}
                legend={legend}
                selectedId={selectedId}
                onSelect={handleSelect}
                onFocus={handleFocus}
              />
            </ResizablePanel>
            <ResizableHandle withHandle className={cn(collapsed && 'hidden')} />
            <ResizablePanel
              panelRef={panelRef}
              defaultSize="30%"
              minSize="22%"
              collapsible
              onResize={(s) => setCollapsed(s.asPercentage <= 0)}
            >
              <div className="h-full overflow-y-auto bg-background/40">
                {selected ? (
                  <NodeDetail
                    node={selected}
                    color={colorForGroup(selected.group)}
                    neighbours={neighbours}
                    colorForGroup={colorForGroup}
                    onSelect={handleSelect}
                    onFocus={handleFocus}
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                    <MousePointerClick className="size-6 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">
                      Select a node to see its properties and connections.
                    </p>
                  </div>
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
    </div>
  )
}

function NodeDetail({
  node,
  color,
  neighbours,
  colorForGroup,
  onSelect,
  onFocus,
}: {
  node: LiveNode
  color: string
  neighbours: Neighbour[]
  colorForGroup: (group: string) => string
  onSelect: (id: string | null) => void
  onFocus: (id: string) => void
}) {
  const entries = Object.entries(node.properties)

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-2 border-b pb-4">
        <div className="flex items-center gap-2">
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
          <Badge variant="secondary" className="font-normal">
            {node.group}
          </Badge>
        </div>
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          {node.label}
        </h2>
        <Button
          size="sm"
          variant="outline"
          className="w-fit"
          onClick={() => onFocus(node.id)}
        >
          Focus neighbourhood
        </Button>
      </div>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Properties
        </h3>
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">No properties.</p>
        ) : (
          <dl className="flex flex-col gap-1 text-xs">
            {entries.map(([key, value]) => (
              <div key={key} className="flex items-start justify-between gap-3">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="max-w-[60%] truncate text-right font-medium text-foreground">
                  {String(value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Connections
          </h3>
          <span className="text-xs text-muted-foreground tabular-nums">
            {neighbours.length}
          </span>
        </div>
        {neighbours.length === 0 ? (
          <p className="text-xs text-muted-foreground">No connections.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {neighbours.map(({ node: n, relation }) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onSelect(n.id)}
                  className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-muted/50"
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: colorForGroup(n.group) }}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {n.label}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 text-[10px] tracking-wide uppercase',
                      relation && RELATION_COLOR[relation]
                        ? 'font-medium'
                        : 'text-muted-foreground/70',
                    )}
                    style={{
                      color: relation ? RELATION_COLOR[relation] : undefined,
                    }}
                  >
                    {relation ?? n.group}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
