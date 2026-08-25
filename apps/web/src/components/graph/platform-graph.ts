import {
  project,
  type ProjectEdge,
  type ProjectNode,
} from "./project-graph-data"

export interface PlatformGraphNode extends ProjectNode {
  degree: number
}

export interface PlatformGraphLink {
  source: string
  target: string
  relation?: string
}

export interface PlatformGraph {
  nodes: PlatformGraphNode[]
  links: PlatformGraphLink[]
}

let cached: PlatformGraph | null = null

export function buildPlatformGraph(): PlatformGraph {
  if (cached) return cached

  const nodeById = new Map<string, PlatformGraphNode>()
  for (const node of project.nodes) {
    nodeById.set(node.id, { ...node, degree: 0 })
  }

  const linkSet = new Set<string>()
  const links: PlatformGraphLink[] = []

  for (const edge of project.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue
    if (edge.source === edge.target) continue

    const dedupeKey =
      edge.source < edge.target
        ? `${edge.source}|${edge.target}`
        : `${edge.target}|${edge.source}`
    if (linkSet.has(dedupeKey)) continue
    linkSet.add(dedupeKey)
    links.push({
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
    })
  }

  for (const link of links) {
    const s = nodeById.get(String(link.source))
    const t = nodeById.get(String(link.target))
    if (s) s.degree += 1
    if (t) t.degree += 1
  }

  cached = { nodes: [...nodeById.values()], links }
  return cached
}

export function getNeighbourhood(nodeId: string, depth = 1): PlatformGraph {
  const full = buildPlatformGraph()
  const adjacency = new Map<string, Set<string>>()

  for (const link of full.links) {
    const s = String(link.source)
    const t = String(link.target)
    if (!adjacency.has(s)) adjacency.set(s, new Set())
    if (!adjacency.has(t)) adjacency.set(t, new Set())
    adjacency.get(s)!.add(t)
    adjacency.get(t)!.add(s)
  }

  const visited = new Set<string>([nodeId])
  let frontier = new Set<string>([nodeId])
  for (let hop = 0; hop < depth; hop++) {
    const next = new Set<string>()
    for (const id of frontier) {
      for (const neighbour of adjacency.get(id) ?? []) {
        if (!visited.has(neighbour)) {
          visited.add(neighbour)
          next.add(neighbour)
        }
      }
    }
    frontier = next
  }

  const nodes = full.nodes.filter((n) => visited.has(n.id))
  const links = full.links.filter(
    (l) => visited.has(String(l.source)) && visited.has(String(l.target))
  )

  return { nodes, links }
}

export function getNeighbourIds(nodeId: string): string[] {
  const full = buildPlatformGraph()
  const ids = new Set<string>()
  for (const link of full.links) {
    const s = String(link.source)
    const t = String(link.target)
    if (s === nodeId) ids.add(t)
    else if (t === nodeId) ids.add(s)
  }
  return [...ids]
}

export function getPlatformNode(nodeId: string): PlatformGraphNode | undefined {
  return buildPlatformGraph().nodes.find((n) => n.id === nodeId)
}

export type { ProjectEdge }
