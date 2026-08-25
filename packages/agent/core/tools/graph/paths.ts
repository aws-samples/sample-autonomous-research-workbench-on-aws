import { tool } from "ai";
import { z } from "zod";

import { ENTITY_LOOKUP_QUERY, runQuery, toNumber } from "@repo/graph";

import {
  attachProvenance,
  errorDetail,
  expandFrontier,
  factsToSubgraph,
  toPublicFact,
  type ExpandedFact,
  type GraphFact,
} from "./client";

const NAME = "graph-paths" as const;

// Search bounds: hub entities can have hundreds of facts, so both the IN-list
// size and the per-expansion row count are capped. Paths through pruned hub
// edges can be missed — the payload's `caps` field says so.
const FRONTIER_CAP = 50;
const PER_HOP_ROW_LIMIT = 500;
const PARENTS_PER_NODE = 3;
const PATH_COMBINATION_CAP = 32;

type ParentEdge = { prev: string; fact: ExpandedFact };

type SearchSide = {
  root: string;
  frontier: string[];
  depths: Map<string, number>;
  parents: Map<string, ParentEdge[]>;
};

function newSide(root: string): SearchSide {
  return {
    root,
    frontier: [root],
    depths: new Map([[root, 0]]),
    parents: new Map(),
  };
}

/**
 * One BFS round: expand the side's frontier by one hop, recording parent
 * edges for path reconstruction. Edges are treated as undirected (a fact
 * connects sourceEntity↔targetEntity); the true direction survives on the
 * fact itself.
 */
async function expandSide(side: SearchSide): Promise<void> {
  const rows = await expandFrontier(side.frontier, {
    limit: PER_HOP_ROW_LIMIT,
  });
  const frontierSet = new Set(side.frontier);
  const nextFrontier: string[] = [];
  for (const fact of rows) {
    for (const [from, to] of [
      [fact.sourceEntity, fact.targetEntity],
      [fact.targetEntity, fact.sourceEntity],
    ] as const) {
      if (!frontierSet.has(from) || to === from) continue;
      const known = side.depths.has(to);
      if (!known) {
        side.depths.set(to, (side.depths.get(from) ?? 0) + 1);
        if (nextFrontier.length < FRONTIER_CAP) nextFrontier.push(to);
      }
      // Keep a few parent edges even for already-known nodes at the same
      // depth so multiple distinct paths survive reconstruction.
      const edges = side.parents.get(to) ?? [];
      if (
        edges.length < PARENTS_PER_NODE &&
        (side.depths.get(to) ?? 0) === (side.depths.get(from) ?? 0) + 1 &&
        !edges.some((e) => e.fact.infonId === fact.infonId)
      ) {
        edges.push({ prev: from, fact });
        side.parents.set(to, edges);
      }
    }
  }
  side.frontier = nextFrontier;
}

/** All root→node chains via the recorded parents, capped combinatorially. */
function chainsToRoot(side: SearchSide, node: string): ParentEdge[][] {
  if (node === side.root) return [[]];
  const out: ParentEdge[][] = [];
  for (const edge of side.parents.get(node) ?? []) {
    for (const prefix of chainsToRoot(side, edge.prev)) {
      out.push([...prefix, edge]);
      if (out.length >= PATH_COMBINATION_CAP) return out;
    }
  }
  return out;
}

type Path = { length: number; entities: string[]; facts: ExpandedFact[] };

function buildPaths(
  fromSide: SearchSide,
  toSide: SearchSide,
  meetingNodes: string[],
): Path[] {
  const paths: Path[] = [];
  const seen = new Set<string>();
  for (const meet of meetingNodes) {
    for (const fromChain of chainsToRoot(fromSide, meet)) {
      for (const toChain of chainsToRoot(toSide, meet)) {
        // fromChain runs from→meet; toChain runs to→meet and is reversed.
        const facts = [...fromChain.map((e) => e.fact)];
        const entities = [fromSide.root];
        for (const edge of fromChain) {
          entities.push(
            edge.fact.sourceEntity === entities[entities.length - 1]
              ? edge.fact.targetEntity
              : edge.fact.sourceEntity,
          );
        }
        // toChain walks to→meet; reversed, each edge steps from its arrived
        // node back to edge.prev, ending at the `to` root.
        for (let i = toChain.length - 1; i >= 0; i--) {
          facts.push(toChain[i].fact);
          entities.push(toChain[i].prev);
        }
        if (facts.length === 0) continue;
        // Entity-level cycles make a chain nonsensical for the model.
        if (new Set(entities).size !== entities.length) continue;
        // Dedup on the semantic chain (entities + predicates), not infon ids:
        // the same fact extracted from several documents must not yield
        // near-identical "distinct" paths.
        const steps = facts.map(
          (f, i) => `${entities[i]}|${f.predicate}|${entities[i + 1]}`,
        );
        const key = steps.join(">");
        const reversedKey = [...steps].reverse().join(">");
        if (seen.has(key) || seen.has(reversedKey)) continue;
        seen.add(key);
        paths.push({ length: facts.length, entities, facts });
      }
    }
  }
  return paths.sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    return meanConfidence(b.facts) - meanConfidence(a.facts);
  });
}

function meanConfidence(facts: GraphFact[]): number {
  const values = facts
    .map((f) => f.confidence)
    .filter((c): c is number => c != null);
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 1-hop degree of an entity, for the no-connection diagnostics. */
async function entityDegree(name: string): Promise<number> {
  const rows = await runQuery<{ degree: unknown }>(
    "MATCH (e:Entity {name: $name})<-[:S_OF|O_OF]-(i:Infon) " +
      "RETURN count(i) AS degree",
    { name },
  );
  return rows.length > 0 ? toNumber(rows[0]?.degree) : 0;
}

export const graphPaths = tool({
  description:
    'Find how two entities are connected in the knowledge graph. Returns up to K distinct multi-hop paths as ordered fact chains (entity — predicate → entity — predicate → entity …), each fact with its source document. Use EXACT entity names from graphSearch. This is the right tool for "how is X related to Y" / "what connects X and Y" questions. Direction is ignored while searching, but each fact in a chain reports its true subject/object direction.',
  inputSchema: z.object({
    from: z.string().min(1).describe("Exact name of the first entity."),
    to: z.string().min(1).describe("Exact name of the second entity."),
    maxHops: z
      .number()
      .int()
      .min(1)
      .max(6)
      .default(4)
      .describe("Maximum facts (semantic hops) per path."),
    maxPaths: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("Maximum number of distinct paths to return."),
  }),
  execute: async ({ from, to, maxHops, maxPaths }) => {
    try {
      for (const name of [from, to]) {
        const rows = await runQuery<{ name: unknown }>(ENTITY_LOOKUP_QUERY, {
          name,
        });
        if (rows.length === 0) {
          return {
            type: NAME,
            from,
            to,
            error: `No entity named '${name}' in the graph`,
            detail:
              "Entity names must match exactly. Use graphSearch to resolve the exact name first.",
            paths: [],
            documents: [],
            graph: { nodes: [], links: [] },
          };
        }
      }

      if (from === to) {
        return {
          type: NAME,
          from,
          to,
          error: "from and to are the same entity",
          detail: "Use graphNeighborhood to explore around one entity.",
          paths: [],
          documents: [],
          graph: { nodes: [], links: [] },
        };
      }

      const fromSide = newSide(from);
      const toSide = newSide(to);

      let meetingNodes: string[] = [];
      while (
        meetingNodes.length === 0 &&
        fromSide.frontier.length > 0 &&
        toSide.frontier.length > 0
      ) {
        const fromDepth = Math.max(...fromSide.depths.values());
        const toDepth = Math.max(...toSide.depths.values());
        if (fromDepth + toDepth >= maxHops) break;
        // Expand the cheaper side (meet-in-the-middle).
        const side =
          fromSide.frontier.length <= toSide.frontier.length
            ? fromSide
            : toSide;
        await expandSide(side);
        meetingNodes = [...fromSide.depths.keys()].filter((n) =>
          toSide.depths.has(n),
        );
      }

      const paths = buildPaths(fromSide, toSide, meetingNodes)
        .filter((p) => p.length <= maxHops)
        .slice(0, maxPaths);

      if (paths.length === 0) {
        const [fromDegree, toDegree] = await Promise.all([
          entityDegree(from),
          entityDegree(to),
        ]);
        return {
          type: NAME,
          from,
          to,
          maxHops,
          paths: [],
          documents: [],
          graph: { nodes: [], links: [] },
          note: `No connection between '${from}' and '${to}' within ${maxHops} hops. '${from}' has ${fromDegree} facts, '${to}' has ${toDegree}. The search is bounded (frontier cap ${FRONTIER_CAP}, ${PER_HOP_ROW_LIMIT} rows/hop), so paths through very high-degree hubs may be missed — try raising maxHops, or explore each entity with graphNeighborhood.`,
          caps: {
            maxHops,
            maxPaths,
            perHopRowLimit: PER_HOP_ROW_LIMIT,
            frontierCap: FRONTIER_CAP,
          },
        };
      }

      const allFacts = paths.flatMap((p) => p.facts);
      const documents = await attachProvenance(allFacts);
      const subgraph = factsToSubgraph(allFacts);

      return {
        type: NAME,
        from,
        to,
        maxHops,
        count: paths.length,
        paths: paths.map((p) => ({
          length: p.length,
          entities: p.entities,
          facts: p.facts.map(toPublicFact),
        })),
        documents,
        graph: { nodes: subgraph.nodes, links: subgraph.links },
        caps: {
          maxHops,
          maxPaths,
          perHopRowLimit: PER_HOP_ROW_LIMIT,
          frontierCap: FRONTIER_CAP,
        },
      };
    } catch (error) {
      return {
        type: NAME,
        from,
        to,
        error: "Graph path search failed",
        detail: errorDetail(error),
        paths: [],
        documents: [],
        graph: { nodes: [], links: [] },
      };
    }
  },
});
