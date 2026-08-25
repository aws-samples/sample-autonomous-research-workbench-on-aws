import { tool } from "ai";
import { z } from "zod";

import {
  DOC_INFON_EDGE_QUERY,
  DOC_TAXONOMY_QUERIES,
  runQuery,
  toNumber,
} from "@repo/graph";

import {
  errorDetail,
  factsToSubgraph,
  MAX_FACTS,
  rowToFact,
  toPublicFact,
} from "./client";

const NAME = "graph-document-facts" as const;

const DOC_LOOKUP_QUERY =
  "MATCH (d:Document {id: $documentId}) " +
  "RETURN d.id AS id, coalesce(d.title, d.id) AS title, " +
  "d.source_path AS source_path, d.page_count AS page_count LIMIT 1";

export const graphDocumentFacts = tool({
  description:
    "List the structured facts extracted from one document in the knowledge graph, given the platform document id (the documentId returned by queryDocuments / getDocument). Returns subject — predicate → object triples with polarity and confidence, plus the document's title and category tags. Use it to see a document's factual claims at a glance or to pivot from vector-search results into the graph.",
  inputSchema: z.object({
    documentId: z
      .string()
      .min(1)
      .describe(
        "Exact platform document id (uuid), e.g. from queryDocuments results.",
      ),
  }),
  execute: async ({ documentId }) => {
    try {
      const docRows = await runQuery<{
        id: unknown;
        title: unknown;
        source_path: unknown;
        page_count: unknown;
      }>(DOC_LOOKUP_QUERY, { documentId });
      if (docRows.length === 0) {
        return {
          type: NAME,
          documentId,
          error: `No graph entry for document '${documentId}'`,
          detail:
            "The document may not be graph-indexed yet, or the id is not a platform document id.",
          facts: [],
          graph: { nodes: [], links: [] },
        };
      }
      const doc = docRows[0];

      const taxonomy: Record<string, string[]> = {};
      for (const [key, cypher] of DOC_TAXONOMY_QUERIES) {
        const rows = await runQuery<{ name: unknown }>(cypher, { documentId });
        taxonomy[key] = rows.map((r) => String(r.name));
      }

      const factRows = await runQuery<Parameters<typeof rowToFact>[0]>(
        DOC_INFON_EDGE_QUERY,
        { documentId },
      );
      const allFacts = factRows.map(rowToFact);
      // Facts here are same-document by construction; drop the redundant
      // provenance fields from the LLM payload.
      const facts = allFacts.slice(0, MAX_FACTS).map((f) => {
        const { documentId: _d, documentTitle: _t, ...rest } = toPublicFact(f);
        return rest;
      });
      const subgraph = factsToSubgraph(allFacts);

      return {
        type: NAME,
        documentId,
        title: String(doc.title),
        sourcePath: doc.source_path == null ? null : String(doc.source_path),
        pageCount: doc.page_count == null ? null : toNumber(doc.page_count),
        taxonomy: {
          macro: taxonomy.macro?.[0] ?? null,
          micro: taxonomy.micro?.[0] ?? null,
          tags: taxonomy.tag ?? [],
        },
        totalFacts: allFacts.length,
        facts,
        graph: { nodes: subgraph.nodes, links: subgraph.links },
        truncated: subgraph.truncated || allFacts.length > MAX_FACTS,
        caps: { maxFacts: MAX_FACTS },
      };
    } catch (error) {
      return {
        type: NAME,
        documentId,
        error: "Graph document-facts lookup failed",
        detail: errorDetail(error),
        facts: [],
        graph: { nodes: [], links: [] },
      };
    }
  },
});
