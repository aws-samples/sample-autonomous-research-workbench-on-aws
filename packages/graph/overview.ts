/**
 * Server-side trim of the corpus entity network, ported from the web
 * viewer's computeVisible (apps/web/components/graph/graph-view.ts) so the
 * API ships only what the selected render-detail tier will draw instead of
 * the whole graph. The graph is trimmed to its most-connected core (highest
 * entity degree first) so what remains is the structure worth looking at.
 */
import type { GraphLink, GraphNode, GraphOverview } from "./types";

export interface GraphBudget {
  nodes: number;
  edges: number;
}

function confidence(link: GraphLink): number {
  const c = link.properties?.confidence;
  return typeof c === "number" ? c : 0;
}

export function trimToBudget(
  entities: GraphNode[],
  infonLinks: GraphLink[],
  budget: GraphBudget,
): GraphOverview {
  // Collapse repeats of (source, predicate, target) — the same fact arrives
  // once per document — so the budget counts edges the canvas actually draws.
  const seen = new Set<string>();
  let links: GraphLink[] = [];
  for (const l of infonLinks) {
    const key = `${l.source}|${l.label}|${l.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(l);
  }

  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  let nodes = entities.filter((n) => degree.has(n.id));
  const total = { nodes: nodes.length, edges: links.length };

  if (nodes.length > budget.nodes) {
    nodes = [...nodes]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .slice(0, budget.nodes);
  }
  let ids = new Set(nodes.map((n) => n.id));
  links = links.filter((l) => ids.has(l.source) && ids.has(l.target));

  if (links.length > budget.edges) {
    // The kept core can still be denser than the edge budget; keep the
    // best-attested facts and drop entities the cap orphaned.
    links = [...links]
      .sort((a, b) => confidence(b) - confidence(a))
      .slice(0, budget.edges);
    ids = new Set<string>();
    for (const l of links) {
      ids.add(l.source);
      ids.add(l.target);
    }
    nodes = nodes.filter((n) => ids.has(n.id));
  }

  return { nodes, links, total };
}
