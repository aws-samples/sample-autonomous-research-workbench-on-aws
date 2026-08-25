import { tool } from "ai";
import { z } from "zod";

import { escapeSql, getTable, resolveSourceFiles } from "./client";

/**
 * Fetch the full text of a single stored page/figure row (TypeScript port of
 * `scripts/lancedb-tests/get_page.py`, text-only).
 *
 * Where `document-query` returns truncated snippets, this returns one row's
 * complete text. Fetch by exact row id (e.g. an id from document-query), or by
 * document (fuzzy filename or exact document id) + page number.
 *
 * Image retrieval (the stored page/figure render) is intentionally omitted for
 * now; it will be added later as a figure view.
 */

const NAME = "document-page" as const;

const PAGE_COLUMNS = ["id", "document_id", "source_file", "page_no", "modality", "text"] as const;

type Row = {
  id: string;
  document_id: string | null;
  source_file: string;
  page_no: number | null;
  modality: string;
  text: string;
};

export const getDocumentPage = tool({
  description:
    "Fetch the full, untruncated text of a single document page (or figure) row. Use after document-query to read a specific result in full. Identify the row either by its exact id (from document-query results) or by document (file name fuzzy match, or exact document id) plus page number. Returns text and metadata only (no image yet).",
  inputSchema: z.object({
    id: z
      .string()
      .optional()
      .describe(
        "Exact row id (e.g. an id returned by document-query). Takes precedence over file/documentId + page.",
      ),
    file: z
      .string()
      .optional()
      .describe("Document name (fuzzy substring match). Use with page."),
    documentId: z
      .string()
      .optional()
      .describe("Exact platform Document id (document_id column). Use with page."),
    page: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Page/slide number. Required when using file or documentId."),
    modality: z
      .enum(["page", "figure"])
      .default("page")
      .describe("Which row to fetch when using file/documentId + page."),
  }),
  execute: async ({ id, file, documentId, page, modality }) => {
    try {
      const table = await getTable();

      let where: string;
      if (id) {
        where = `id = '${escapeSql(id)}'`;
      } else if (documentId) {
        if (page === undefined) {
          return { type: NAME, error: "documentId requires a page number" };
        }
        where = `document_id = '${escapeSql(documentId)}' AND page_no = ${page} AND modality = '${escapeSql(modality)}'`;
      } else if (file) {
        if (page === undefined) {
          return { type: NAME, error: "file requires a page number" };
        }
        const matches = await resolveSourceFiles(table, file);
        if (matches.length === 0) {
          return { type: NAME, error: `No document matches '${file}'` };
        }
        const sourceFile = matches[0];
        where = `source_file = '${escapeSql(sourceFile)}' AND page_no = ${page} AND modality = '${escapeSql(modality)}'`;
      } else {
        return {
          type: NAME,
          error: "Provide id, or documentId + page, or file + page",
        };
      }

      const rows = (await table
        .query()
        .where(where)
        .select([...PAGE_COLUMNS])
        .limit(1)
        .toArray()) as Row[];

      const row = rows[0];
      if (!row) {
        return { type: NAME, error: `No row matched: ${where}` };
      }

      return {
        type: NAME,
        id: row.id,
        documentId: row.document_id == null ? null : String(row.document_id),
        sourceFile: row.source_file,
        // page_no is a BigInt (int64) from LanceDB; coerce so JSON.stringify
        // doesn't throw when this result is persisted to TaskMessage.
        pageNo: row.page_no == null ? null : Number(row.page_no),
        modality: row.modality,
        text: row.text ?? "",
      };
    } catch (error) {
      return {
        type: NAME,
        error: "Fetching document page failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
