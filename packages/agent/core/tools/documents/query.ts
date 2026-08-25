import { tool } from "ai";
import { z } from "zod";

import {
  buildWhere,
  embedQuery,
  getTable,
  rerank,
  resolveSourceFiles,
  RESULT_COLUMNS,
} from "./client";

/**
 * Hybrid search over the ingested documents (TypeScript port of
 * `scripts/lancedb-tests/query.py`).
 *
 * Embeds the query with Cohere Embed v4 (search_query side) and runs hybrid
 * search (vector + full-text) over the unified multimodal vector column, with
 * optional Cohere Rerank v3.5 reranking. Filters by document (fuzzy filename or
 * exact `document_id`) and modality. Returns text/metadata only — image bytes
 * are fetched separately later.
 *
 * On missing config or failure it returns a structured `{ error }` payload
 * rather than throwing, so the model can react and the UI can render it.
 */

const NAME = "document-query" as const;

/** Cap each result snippet so a single search can't blow the context window. */
const SNIPPET_MAX_CHARACTERS = 300;

/**
 * Cap each candidate's text sent to Cohere Rerank. Rerank has a per-request
 * token budget across all documents; full page/table rows (thousands of chars)
 * exceed it and return "Too many tokens". ~2k chars is ample lead signal.
 */
const RERANK_TEXT_MAX_CHARACTERS = 2000;

function shorten(text: string, width: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= width) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, width - 3)).trimEnd()}...`;
}

type Row = {
  id: string;
  document_id: string | null;
  source_file: string;
  page_no: number | null;
  modality: string;
  caption: string | null;
  text: string;
};

export const queryDocuments = tool({
  description:
    "Search the ingested document corpus with hybrid vector + full-text search. Embeds the query (Cohere Embed v4) and retrieves the most relevant chunks across all modalities (text, figures, pages, tables), reranked by relevance. Optionally scope to a single document by name (fuzzy match) or exact document id, and filter by modality. Returns text snippets and metadata only; use get-document-page or get-document to read full text.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Natural-language search query. Supports long, semantically rich descriptions.",
      ),
    k: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(10)
      .describe("Number of results to return (1-25)."),
    file: z
      .string()
      .optional()
      .describe(
        "Restrict to a single document by name (fuzzy substring match against the stored filename).",
      ),
    documentId: z
      .string()
      .optional()
      .describe(
        "Restrict to a single document by exact platform Document id (the document_id column).",
      ),
    modality: z
      .array(z.enum(["text", "figure", "page", "table"]))
      .optional()
      .describe("Restrict to one or more modalities."),
    hybrid: z
      .boolean()
      .default(true)
      .describe(
        "When true, combine vector and full-text (BM25) search. When false, use pure vector search.",
      ),
    rerank: z
      .boolean()
      .default(true)
      .describe(
        "When true, rerank candidates with Cohere Rerank v3.5 for higher quality (slower). When false, return raw hybrid order.",
      ),
  }),
  execute: async ({ query, k, file, documentId, modality, hybrid, rerank: doRerank }) => {
    try {
      const table = await getTable();

      // Resolve a fuzzy --file phrase to an exact stored filename.
      let sourceFile: string | undefined;
      let resolvedFiles: string[] | undefined;
      let note: string | undefined;
      if (file) {
        const matches = await resolveSourceFiles(table, file);
        if (matches.length === 0) {
          return {
            type: NAME,
            query,
            error: `No document matches '${file}'`,
            count: 0,
            results: [],
          };
        }
        sourceFile = matches[0];
        if (matches.length > 1) {
          resolvedFiles = matches;
          note = `'${file}' matched ${matches.length} documents; scoped to '${sourceFile}'. Narrow the file phrase to disambiguate.`;
        }
      }

      const qvec = await embedQuery(query);
      const where = buildWhere({ documentId, sourceFile, modalities: modality });

      // Hybrid = vector + full-text. The precomputed Embed v4 vector is passed
      // explicitly (embeddings come from Bedrock, not a registered LanceDB
      // embedding function), plus the raw query string for BM25/FTS.
      let q = table.query().nearestTo(qvec);
      if (hybrid) {
        q = q.fullTextSearch(query);
      }
      if (where) {
        q = q.where(where);
      }

      // Over-fetch when reranking so the reranker has candidates to reorder.
      const fetch = doRerank ? Math.max(k * 4, k) : k;
      const rows = (await q
        .select([...RESULT_COLUMNS])
        .limit(fetch)
        .toArray()) as Row[];

      let ordered = rows;
      // Aligned with `ordered`: rerankScores[i] is the score for ordered[i].
      let rerankScores: number[] | null = null;
      let rerankNote: string | undefined;
      if (doRerank && rows.length > 1) {
        try {
          const order = await rerank(
            query,
            // Cap each candidate's text: Cohere Rerank has a per-request token
            // limit and full page/table rows blow past it ("Too many tokens").
            // The lead text is enough signal for reranking.
            rows.map((r) => (r.text ?? "").slice(0, RERANK_TEXT_MAX_CHARACTERS)),
            k,
          );
          if (order.length > 0) {
            const reordered = order
              .map(({ index }) => rows[index])
              .filter(Boolean);
            ordered = reordered;
            rerankScores = order
              .filter(({ index }) => rows[index])
              .map(({ score }) => score);
          }
        } catch (rerankError) {
          // Reranking is a best-effort quality boost, not a hard dependency. On
          // failure (rate limit, region availability, etc.) fall back to the
          // hybrid/vector order rather than failing the whole query.
          ordered = rows.slice(0, k);
          rerankNote = `Reranking skipped (${
            rerankError instanceof Error
              ? rerankError.message
              : String(rerankError)
          }); results are in hybrid/vector order.`;
        }
      }

      const trimmed = ordered.slice(0, k);
      const results = trimmed.map((row, i) => ({
        id: row.id,
        documentId: row.document_id == null ? null : String(row.document_id),
        sourceFile: row.source_file,
        // page_no comes back from LanceDB as a BigInt (int64 column). Leaving it
        // a BigInt makes JSON.stringify throw ("cannot serialize BigInt") when
        // the tool result is persisted to TaskMessage, failing the whole run.
        // Coerce to a plain number.
        pageNo: row.page_no == null ? null : Number(row.page_no),
        modality: row.modality,
        caption: row.caption ?? null,
        snippet: shorten(row.text ?? "", SNIPPET_MAX_CHARACTERS),
        ...(rerankScores ? { rerankScore: rerankScores[i] } : {}),
      }));

      return {
        type: NAME,
        query,
        count: results.length,
        results,
        ...(resolvedFiles ? { resolvedFiles } : {}),
        ...(note ? { note } : {}),
        ...(rerankNote ? { rerankNote } : {}),
      };
    } catch (error) {
      return {
        type: NAME,
        query,
        error: "Document query failed",
        detail: error instanceof Error ? error.message : String(error),
        count: 0,
        results: [],
      };
    }
  },
});
