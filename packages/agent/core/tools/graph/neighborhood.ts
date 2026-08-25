import { tool } from "ai";
import { z } from "zod";

import { ENTITY_LOOKUP_QUERY, runQuery } from "@repo/graph";

import {
  attachProvenance,
  errorDetail,
  expandFrontier,
  factKey,
  factsToSubgraph,
  MAX_FACTS,
  MAX_NODES,
  toPublicFact,
  type ExpandedFact,
} from "./client";

const NAME = "graph-neighborhood" as const;

/** Bound the IN-list of the per-hop expansion query. */
const FRONTIER_CAP = 25;

export const graphNeighborhood = tool({
  description:
    "Expand the knowledge graph around one entity and return its facts (subject — predicate → object, with polarity, confidence, and source documents). hops=1 returns the entity's direct facts; hops=2–3 also follow the neighbors' facts outward. Use the EXACT entity name from graphSearch. Optionally filter to a single predicate (e.g. 'supplies_to'). Use this to answer \"what do we know about X\" and to explore around an entity.",
  inputSchema: z.object({
    entity: z
      .string()
      .min(1)
      .describe("Exact entity name (resolve it with graphSearch first)."),
    hops: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(1)
      .describe("How many hops out to expand (1 = direct facts only)."),
    predicate: z
      .string()
      .optional()
      .describe("Only follow facts with this exact predicate name."),
    limitPerHop: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(25)
      .describe("Maximum facts to keep per hop."),
  }),
  execute: async ({ entity, hops, predicate, limitPerHop }) => {
    try {
      const lookup = await runQuery<{ name: unknown; kind: unknown }>(
        ENTITY_LOOKUP_QUERY,
        { name: entity },
      );
      if (lookup.length === 0) {
        return {
          type: NAME,
          entity,
          error: `No entity named '${entity}' in the graph`,
          detail:
            "Entity names must match exactly. Use graphSearch to resolve the exact name first.",
          facts: [],
          documents: [],
          graph: { nodes: [], links: [] },
        };
      }
      const entityKind =
        lookup[0]?.kind == null ? null : String(lookup[0].kind);

      const facts: (ExpandedFact & { hop: number })[] = [];
      const seenInfons = new Set<string>();
      const seenFactKeys = new Set<string>();
      const visited = new Set<string>([entity]);
      let frontier = [entity];

      for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
        // Over-fetch so dedup (per-document repeats of the same fact) still
        // leaves enough fresh rows to fill the hop budget.
        const rows = await expandFrontier(frontier, {
          predicate,
          limit: limitPerHop * 4,
        });
        const nextFrontier: string[] = [];
        let kept = 0;
        for (const row of rows) {
          if (kept >= limitPerHop || facts.length >= MAX_FACTS) break;
          if (seenInfons.has(row.infonId)) continue;
          seenInfons.add(row.infonId);
          const key = factKey(row);
          if (seenFactKeys.has(key)) continue;
          seenFactKeys.add(key);
          facts.push({ ...row, hop });
          kept++;
          for (const name of [row.sourceEntity, row.targetEntity]) {
            if (!visited.has(name) && nextFrontier.length < FRONTIER_CAP) {
              visited.add(name);
              nextFrontier.push(name);
            }
          }
        }
        if (facts.length >= MAX_FACTS) break;
        frontier = nextFrontier;
      }

      const documents = await attachProvenance(facts);
      const subgraph = factsToSubgraph(facts);

      return {
        type: NAME,
        entity,
        entityKind,
        hops,
        ...(predicate ? { predicate } : {}),
        count: facts.length,
        facts: facts.map(toPublicFact),
        documents,
        graph: { nodes: subgraph.nodes, links: subgraph.links },
        truncated: subgraph.truncated || facts.length >= MAX_FACTS,
        caps: { maxFacts: MAX_FACTS, maxNodes: MAX_NODES, limitPerHop },
      };
    } catch (error) {
      return {
        type: NAME,
        entity,
        error: "Graph neighborhood expansion failed",
        detail: errorDetail(error),
        facts: [],
        documents: [],
        graph: { nodes: [], links: [] },
      };
    }
  },
});
