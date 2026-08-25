import { tool } from "ai";
import { z } from "zod";

import {
  ONTOLOGY_MACRO_QUERY,
  ONTOLOGY_PREDICATE_QUERY,
  ONTOLOGY_USAGE_QUERY,
  runQuery,
  STATS_EDGE_QUERY,
  STATS_NODE_QUERY,
  toInt,
  toNumber,
  TOP_ENTITY_EDGE_QUERY,
  TOP_ENTITY_QUERY,
  type GraphNode,
} from "@repo/graph";

import { errorDetail, factsToSubgraph, rowToFact } from "./client";

const NAME = "graph-overview" as const;

export const graphOverview = tool({
  description:
    "Get an orientation snapshot of the knowledge graph: node/edge counts, the taxonomy (macro categories), the predicate vocabulary with usage counts, the most-connected entities, and the document count. Call this when you're unsure what the graph covers, which predicates exist, or which entities are central — for example before choosing a predicate filter for graphNeighborhood.",
  inputSchema: z.object({
    topEntities: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(15)
      .describe("How many of the most-connected entities to return."),
  }),
  execute: async ({ topEntities }) => {
    try {
      const nodeRows = await runQuery<{ label: unknown; n: unknown }>(
        STATS_NODE_QUERY,
      );
      const nodesByLabel: Record<string, number> = {};
      for (const row of nodeRows) {
        nodesByLabel[String(row.label)] = toNumber(row.n);
      }

      const edgeRows = await runQuery<{ type: unknown; n: unknown }>(
        STATS_EDGE_QUERY,
      );
      const edgesByType: Record<string, number> = {};
      for (const row of edgeRows) {
        edgesByType[String(row.type)] = toNumber(row.n);
      }

      const macroRows = await runQuery<{ macro: unknown }>(
        ONTOLOGY_MACRO_QUERY,
      );
      const macros = [...new Set(macroRows.map((r) => String(r.macro)))];

      const usageRows = await runQuery<{ predicate: unknown; n: unknown }>(
        ONTOLOGY_USAGE_QUERY,
      );
      const usage = new Map(
        usageRows.map((r) => [String(r.predicate), toNumber(r.n)]),
      );
      const predicateRows = await runQuery<{
        name: unknown;
        description: unknown;
        domainKinds: unknown;
        rangeKinds: unknown;
      }>(ONTOLOGY_PREDICATE_QUERY);
      const predicates = predicateRows
        .map((row) => ({
          name: String(row.name),
          description: row.description == null ? "" : String(row.description),
          domainKinds: row.domainKinds == null ? "" : String(row.domainKinds),
          rangeKinds: row.rangeKinds == null ? "" : String(row.rangeKinds),
          usageCount: usage.get(String(row.name)) ?? 0,
        }))
        .sort((a, b) => b.usageCount - a.usageCount);

      const topRows = await runQuery<{
        name: unknown;
        kind: unknown;
        degree: unknown;
      }>(TOP_ENTITY_QUERY, { topN: toInt(topEntities) });
      const top = topRows.map((row) => ({
        name: String(row.name),
        kind: row.kind == null ? null : String(row.kind),
        degree: toNumber(row.degree),
      }));

      // Mini-graph: the top entities plus the facts among them. Ensure every
      // top entity appears even when it has no facts inside the top set.
      const names = top.map((t) => t.name);
      const factRows =
        names.length > 0
          ? await runQuery<Parameters<typeof rowToFact>[0]>(
              TOP_ENTITY_EDGE_QUERY,
              { names },
            )
          : [];
      const topNodes: GraphNode[] = top.map((t) => ({
        id: t.name,
        label: t.name,
        kind: "Entity",
        properties: { entity_kind: t.kind, degree: t.degree },
      }));
      const subgraph = factsToSubgraph(factRows.map(rowToFact), topNodes);

      return {
        type: NAME,
        totals: {
          nodes: Object.values(nodesByLabel).reduce((a, b) => a + b, 0),
          edges: Object.values(edgesByType).reduce((a, b) => a + b, 0),
          documents: nodesByLabel.Document ?? 0,
          entities: nodesByLabel.Entity ?? 0,
          facts: nodesByLabel.Infon ?? 0,
        },
        nodesByLabel,
        edgesByType,
        macros,
        predicates,
        topEntities: top,
        graph: { nodes: subgraph.nodes, links: subgraph.links },
      };
    } catch (error) {
      return {
        type: NAME,
        error: "Graph overview failed",
        detail: errorDetail(error),
        graph: { nodes: [], links: [] },
      };
    }
  },
});
