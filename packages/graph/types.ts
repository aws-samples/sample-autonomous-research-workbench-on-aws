import { z } from "zod";

/**
 * Graph types for the knowledge-graph views. These mirror the web
 * `DocumentGraph` shape and are intentionally kept separate from the relational
 * document schema: the graph is sourced from a graph database (Memgraph
 * locally, Amazon Neptune in production), not Postgres.
 *
 * Infons (facts) are STORED reified — (:Infon) nodes with S_OF/O_OF edges —
 * but SERVED collapsed: one labeled entity→entity link per infon, so viewers
 * draw the fact as an edge instead of a duplicate node.
 */
export const graphNodeKindSchema = z.enum([
  "Document",
  "Infon",
  "Entity",
  "Macro",
  "Micro",
  "Tag",
  "Predicate",
  // Epistemic graph: agent-authored reasoning nodes (see graph-epistemic tool
  // group). Dedicated labels, not reified infons, because they carry a status
  // lifecycle and typed evidence edges.
  "Hypothesis",
  "Observation",
  "Decision",
]);

const propertiesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const graphNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: graphNodeKindSchema,
  // Detail-panel payload (kind-dependent).
  properties: propertiesSchema.optional(),
});

export const graphLinkSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.string(),
  // Present on collapsed infon edges: stable edge key (infon_id).
  id: z.string().optional(),
  // Rendered on the edge (the predicate); structural edges stay unlabeled.
  label: z.string().optional(),
  // Detail-panel payload for infon edges (polarity, confidence, flags…).
  properties: propertiesSchema.optional(),
});

export const documentGraphSchema = z.object({
  nodes: z.array(graphNodeSchema),
  links: z.array(graphLinkSchema),
});

export const graphOverviewSchema = z.object({
  nodes: z.array(graphNodeSchema),
  links: z.array(graphLinkSchema),
  // Deduped corpus counts before the budget applied — for "showing X of Y".
  total: z.object({ nodes: z.number(), edges: z.number() }),
});

export const entitySearchResultSchema = z.object({
  name: z.string(),
  kind: z.string().nullable(),
  canonicalId: z.string().nullable(),
  curated: z.boolean(),
  // Fact count, the search ranking key.
  degree: z.number(),
});

export const graphStatsSchema = z.object({
  totalNodes: z.number(),
  totalEdges: z.number(),
  nodesByLabel: z.record(z.string(), z.number()),
  edgesByType: z.record(z.string(), z.number()),
  documents: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      infonCount: z.number(),
    }),
  ),
});

export const ontologyViewSchema = z.object({
  taxonomy: z.array(
    z.object({
      macro: z.string(),
      micros: z.array(
        z.object({
          micro: z.string(),
          tags: z.array(z.string()),
        }),
      ),
    }),
  ),
  entitiesByKind: z.record(
    z.string(),
    z.array(
      z.object({
        name: z.string(),
        canonicalId: z.string().nullable(),
      }),
    ),
  ),
  predicates: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      domainKinds: z.string(),
      rangeKinds: z.string(),
      usageCount: z.number(),
    }),
  ),
});

export type GraphNodeKind = z.infer<typeof graphNodeKindSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphLink = z.infer<typeof graphLinkSchema>;
export type DocumentGraph = z.infer<typeof documentGraphSchema>;
export type GraphOverview = z.infer<typeof graphOverviewSchema>;
export type EntitySearchResult = z.infer<typeof entitySearchResultSchema>;
export type GraphStats = z.infer<typeof graphStatsSchema>;
export type OntologyView = z.infer<typeof ontologyViewSchema>;
