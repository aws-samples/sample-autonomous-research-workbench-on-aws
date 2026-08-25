import { tool } from "ai";
import { z } from "zod";

import { escapeSql, getTable, resolveSourceFiles } from "./client";

/**
 * Assemble and return a whole document's text, with optional line-range slicing
 * (TypeScript port of `scripts/lancedb-tests/get_document.py`).
 *
 * Stitches every page of a document into one text blob in reading order (each
 * page already carries its figure notes inline), and lets you view a line range
 * the way you'd `sed -n '1,500p'` a file. Falls back to text/table rows when a
 * document has no page rows (e.g. XLSX).
 *
 * The returned text is capped to protect the agent's context window; use
 * `lines` to page through a long document.
 */

const NAME = "document-text" as const;

/** Cap returned text so a single document read can't blow the context window. */
const TEXT_MAX_CHARACTERS = 16000;

type Row = {
  document_id: string | null;
  source_file: string | null;
  page_no: number | null;
  modality: string;
  text: string;
  ref: string | null;
};

/** Parse a 1-indexed inclusive line spec into a 0-indexed half-open range. */
function parseLines(spec: string, n: number): [number, number] {
  const s = (spec || "all").trim().toLowerCase();
  if (s === "all" || s === ":" || s === "") {
    return [0, n];
  }
  if (!s.includes(":")) {
    const i = Number.parseInt(s, 10);
    if (Number.isNaN(i)) {
      return [0, n];
    }
    return [Math.max(0, i - 1), Math.max(0, i)];
  }
  // `s` is known to contain ":" (checked above), so both halves always exist —
  // the defaults are only here to satisfy the compiler's index-access checks.
  const [lo = "", hi = ""] = s.split(":", 2);
  const start = lo.trim() ? Number.parseInt(lo, 10) - 1 : 0;
  const end = hi.trim() ? Number.parseInt(hi, 10) : n;
  const safeStart = Math.max(0, Number.isNaN(start) ? 0 : start);
  const safeEnd = Math.min(n, Math.max(safeStart, Number.isNaN(end) ? n : end));
  return [safeStart, safeEnd];
}

function assembleDocument(rows: Row[]): string {
  // page_no comes from LanceDB as a BigInt (int64). Coerce to a number before
  // any arithmetic — subtracting/mixing BigInt with number throws ("Conversion
  // from 'BigInt' to 'number' is not allowed" / "Cannot mix BigInt and other
  // types"), which previously failed the whole get-document call.
  const pageNo = (r: Row): number =>
    r.page_no == null ? 0 : Number(r.page_no);
  const pages = rows
    .filter((r) => r.modality === "page")
    .sort((a, b) => pageNo(a) - pageNo(b));
  if (pages.length > 0) {
    return pages
      .map(
        (r) =>
          `===== page ${r.page_no == null ? "?" : Number(r.page_no)} =====\n${r.text ?? ""}`,
      )
      .join("\n\n");
  }

  // Fallback: no page rows. Order text then tables by their ref.
  const rest = rows
    .filter((r) => r.modality === "text" || r.modality === "table")
    .sort((a, b) => {
      if (a.modality !== b.modality) {
        return a.modality.localeCompare(b.modality);
      }
      return (a.ref ?? "").localeCompare(b.ref ?? "");
    });
  return rest.map((r) => r.text ?? "").join("\n\n");
}

export const getDocument = tool({
  description:
    "Read the full text of a whole document, stitched together in page order (figure notes inline). Identify the document by name (fuzzy substring match) or exact document id. Use the lines parameter to view a specific 1-indexed inclusive range (e.g. '1:500', '200:', ':300', '450', or 'all') and page through long documents. Returned text is capped per call; request a later range to continue reading.",
  inputSchema: z.object({
    file: z
      .string()
      .optional()
      .describe("Document name (fuzzy substring match). One of file or documentId is required."),
    documentId: z
      .string()
      .optional()
      .describe("Exact platform Document id (document_id column). One of file or documentId is required."),
    lines: z
      .string()
      .default("all")
      .describe(
        "Line range, 1-indexed inclusive: '1:500' | '200:' | ':300' | '450' | 'all' (default).",
      ),
  }),
  execute: async ({ file, documentId, lines }) => {
    try {
      const table = await getTable();

      let where: string;
      let sourceLabel: string;
      if (documentId) {
        where = `document_id = '${escapeSql(documentId)}'`;
        sourceLabel = documentId;
      } else if (file) {
        const matches = await resolveSourceFiles(table, file);
        if (matches.length === 0) {
          return { type: NAME, error: `No document matches '${file}'` };
        }
        sourceLabel = matches[0];
        where = `source_file = '${escapeSql(sourceLabel)}'`;
      } else {
        return { type: NAME, error: "Provide either file or documentId" };
      }

      const rows = (await table
        .query()
        .where(where)
        .select(["document_id", "source_file", "page_no", "modality", "text", "ref"])
        .limit(100000)
        .toArray()) as Row[];

      if (rows.length === 0) {
        return { type: NAME, error: `No rows for document: ${sourceLabel}` };
      }

      // Prefer the real document_id / source_file from the rows so the UI gets a
      // platform id to link to and a proper filename to show, regardless of
      // whether the caller identified the document by id or by fuzzy filename.
      const resolvedDocumentId =
        documentId ??
        rows.find((r) => r.document_id != null)?.document_id ??
        null;
      const resolvedSourceFile =
        rows.find((r) => r.source_file)?.source_file ?? sourceLabel;

      const fullText = assembleDocument(rows);
      const allLines = fullText.split("\n");
      const totalLines = allLines.length;
      const [start, end] = parseLines(lines, totalLines);

      let shown = allLines.slice(start, end).join("\n");
      let truncated = false;
      if (shown.length > TEXT_MAX_CHARACTERS) {
        shown = shown.slice(0, TEXT_MAX_CHARACTERS);
        truncated = true;
      }

      return {
        type: NAME,
        documentId:
          resolvedDocumentId == null ? null : String(resolvedDocumentId),
        sourceFile: resolvedSourceFile,
        totalLines,
        startLine: start + 1,
        endLine: end,
        truncated,
        text: shown,
      };
    } catch (error) {
      return {
        type: NAME,
        error: "Reading document failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
