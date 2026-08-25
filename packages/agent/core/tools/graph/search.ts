import { tool } from "ai";
import { z } from "zod";

import {
  DOC_TITLE_SEARCH_QUERY,
  ENTITY_KIND_COUNT_QUERY,
  ENTITY_SEARCH_KIND_QUERY,
  ENTITY_SEARCH_QUERY,
  ONTOLOGY_USAGE_QUERY,
  runQuery,
  TAG_SEARCH_QUERY,
  toInt,
  toNumber,
  type GraphNode,
} from "@repo/graph";

import { errorDetail } from "./client";

const NAME = "graph-search" as const;

export const graphSearch = tool({
  description:
    "Find nodes in the knowledge graph by name. Case-insensitive substring match over entities (companies, technologies, vehicle models, suppliers…), optionally also documents (by title) and taxonomy tags. Returns each match with its kind and fact count (degree) so you can pick the right entity. ALWAYS call this first to resolve exact entity names before graphNeighborhood or graphPaths — those tools require exact names. If nothing matches, the response lists the available entity kinds and predicates so you can rephrase.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        "Substring to match, case-insensitive. Korean and English names both work.",
      ),
    kind: z
      .string()
      .optional()
      .describe(
        "Restrict entities to one kind, e.g. 'OEM', 'Supplier', 'Technology'.",
      ),
    includeDocuments: z
      .boolean()
      .default(true)
      .describe("Also match document titles."),
    includeTags: z
      .boolean()
      .default(false)
      .describe("Also match taxonomy tags."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(10)
      .describe("Maximum matches per category."),
  }),
  execute: async ({ query, kind, includeDocuments, includeTags, limit }) => {
    try {
      const entityRows = await runQuery<{
        name: unknown;
        kind: unknown;
        canonical_id: unknown;
        curated: unknown;
        degree: unknown;
      }>(kind ? ENTITY_SEARCH_KIND_QUERY : ENTITY_SEARCH_QUERY, {
        q: query,
        limit: toInt(limit),
        ...(kind ? { kind } : {}),
      });
      const entities = entityRows.map((row) => ({
        name: String(row.name),
        kind: row.kind == null ? null : String(row.kind),
        canonicalId: row.canonical_id == null ? null : String(row.canonical_id),
        curated: Boolean(row.curated),
        degree: toNumber(row.degree),
      }));

      const documents = includeDocuments
        ? (
            await runQuery<{ id: unknown; title: unknown }>(
              DOC_TITLE_SEARCH_QUERY,
              { q: query, limit: toInt(limit) },
            )
          ).map((row) => ({ id: String(row.id), title: String(row.title) }))
        : [];

      const tags = includeTags
        ? (
            await runQuery<{ name: unknown }>(TAG_SEARCH_QUERY, {
              q: query,
              limit: toInt(limit),
            })
          ).map((row) => String(row.name))
        : [];

      // Zero matches: tell the model what the graph actually contains so it
      // can rephrase instead of retrying blind variations.
      let availableKinds:
        | { kind: string | null; count: number }[]
        | undefined;
      let availablePredicates:
        | { predicate: string; count: number }[]
        | undefined;
      if (entities.length === 0 && documents.length === 0 && tags.length === 0) {
        const kindRows = await runQuery<{ kind: unknown; n: unknown }>(
          ENTITY_KIND_COUNT_QUERY,
        );
        availableKinds = kindRows.map((row) => ({
          kind: row.kind == null ? null : String(row.kind),
          count: toNumber(row.n),
        }));
        const usageRows = await runQuery<{ predicate: unknown; n: unknown }>(
          ONTOLOGY_USAGE_QUERY,
        );
        availablePredicates = usageRows
          .map((row) => ({
            predicate: String(row.predicate),
            count: toNumber(row.n),
          }))
          .sort((a, b) => b.count - a.count);
      }

      const nodes: GraphNode[] = [
        ...entities.map(
          (e): GraphNode => ({
            id: e.name,
            label: e.name,
            kind: "Entity",
            properties: {
              entity_kind: e.kind,
              curated: e.curated,
              degree: e.degree,
            },
          }),
        ),
        ...documents.map(
          (d): GraphNode => ({ id: d.id, label: d.title, kind: "Document" }),
        ),
        ...tags.map(
          (t): GraphNode => ({ id: t, label: t, kind: "Tag" }),
        ),
      ];

      return {
        type: NAME,
        query,
        count: entities.length + documents.length + tags.length,
        entities,
        documents,
        tags,
        ...(availableKinds ? { availableKinds } : {}),
        ...(availablePredicates ? { availablePredicates } : {}),
        graph: { nodes, links: [] },
        caps: { limit },
      };
    } catch (error) {
      return {
        type: NAME,
        query,
        error: "Graph search failed",
        detail: errorDetail(error),
        count: 0,
        entities: [],
        documents: [],
        tags: [],
        graph: { nodes: [], links: [] },
      };
    }
  },
});
