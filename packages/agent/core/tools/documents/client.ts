import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import * as lancedb from "@lancedb/lancedb";

/**
 * Shared config + clients for the document tools.
 *
 * These tools are the TypeScript port of the read-only Python scripts in
 * `scripts/lancedb-tests/`. They query the production LanceDB vector store the
 * `semantic-ingestion` worker writes to S3, embedding queries with Cohere Embed
 * v4 and reranking with Cohere Rerank v3.5 — both on Bedrock — to match exactly
 * what the worker stored (see `scripts/lancedb-tests/common.py`).
 *
 * Config is read inline from `process.env.*` (no central env module exists in
 * this package), using the same var names/defaults as the Python `Settings`.
 * Credentials resolve via the standard AWS provider chain, matching the
 * Bedrock provider in `core/agent.ts` and the sandbox client.
 */

/** Embed v4 output dimension; must match the ingested schema (`DocChunk`). */
export const EMBED_DIM = 1536;

/** Columns selected for search/page results (text-only — no `image_bytes`). */
export const RESULT_COLUMNS = [
  "id",
  "document_id",
  "source_file",
  "page_no",
  "modality",
  "caption",
  "text",
] as const;

function dbUri(): string {
  const uri = process.env.LANCEDB_URI;
  if (uri) {
    return uri;
  }
  const bucket = process.env.LANCEDB_BUCKET;
  if (bucket) {
    return `s3://${bucket}`;
  }
  return "./lancedb";
}

function tableName(): string {
  return process.env.LANCEDB_TABLE ?? "documents";
}

function embedModel(): string {
  return process.env.EMBED_MODEL ?? "global.cohere.embed-v4:0";
}

function rerankModel(): string {
  return process.env.RERANK_MODEL ?? "cohere.rerank-v3-5:0";
}

// Cohere Rerank has limited regional availability (many regions list zero
// rerank models → "The provided model identifier is invalid"). Default to
// us-east-1 where it is offered; override with RERANK_REGION if the stack's
// region gains support. Pinned via its own client, independent of the
// embed/S3 region.
const RERANK_REGION = process.env.RERANK_REGION ?? "us-east-1";

let cachedTable: Promise<lancedb.Table> | null = null;
let cachedBedrock: BedrockRuntimeClient | null = null;
let cachedRerankBedrock: BedrockRuntimeClient | null = null;

/**
 * Open (and cache) the LanceDB documents table. Throws a clear error when the
 * table is missing so callers can surface a structured failure.
 */
export function getTable(): Promise<lancedb.Table> {
  cachedTable ??= (async () => {
    const uri = dbUri();
    const name = tableName();
    // Region resolution is left entirely to the native object store's own
    // provider chain (env vars, profile, IMDS/task metadata) — in-region
    // deployments resolve to the task's region, which matches the bucket.
    //
    // Do NOT set an explicit `endpoint` here: a path-style endpoint
    // (https://s3.<region>.amazonaws.com/<bucket>) fails to connect from inside
    // the VPC (over NAT) — "error sending request". Omitting it lets the store
    // use virtual-hosted addressing (<bucket>.s3.<region>.amazonaws.com), the
    // same as the boto3-based ingestion worker that writes this bucket fine.
    const db = await lancedb.connect(uri, {
      // Without this, the native client pins the table version opened at first
      // use and NEVER sees later writes — a long-lived API task kept serving a
      // days-old snapshot while ingestion runs added documents ("No rows for
      // document" for anything ingested after the task started). 30s bounds
      // the staleness at a negligible per-read cost for an S3-backed store.
      readConsistencyInterval: 30,
    });
    const tables = await db.tableNames();
    if (!tables.includes(name)) {
      cachedTable = null;
      throw new Error(
        `LanceDB table '${name}' not found in ${uri} — run the ingestion worker first`,
      );
    }
    return db.openTable(name);
  })();
  return cachedTable;
}

function getBedrock(): BedrockRuntimeClient {
  // Region resolves via the SDK's default chain (env, profile, IMDS).
  cachedBedrock ??= new BedrockRuntimeClient({
    credentials: fromNodeProviderChain(),
    customUserAgent: process.env.USER_AGENT_STRING,
  });
  return cachedBedrock;
}

/** Bedrock client pinned to the rerank region (Cohere Rerank is us-east-1 only). */
function getRerankBedrock(): BedrockRuntimeClient {
  cachedRerankBedrock ??= new BedrockRuntimeClient({
    region: RERANK_REGION,
    credentials: fromNodeProviderChain(),
    customUserAgent: process.env.USER_AGENT_STRING,
  });
  return cachedRerankBedrock;
}

async function invokeJson(
  modelId: string,
  body: Record<string, unknown>,
  client: BedrockRuntimeClient = getBedrock(),
): Promise<unknown> {
  const response = await client.send(
    new InvokeModelCommand({
      modelId,
      body: JSON.stringify(body),
      contentType: "application/json",
      accept: "application/json",
    }),
  );
  return JSON.parse(new TextDecoder().decode(response.body));
}

/**
 * Embed a query string with Cohere Embed v4 (search_query side), returning a
 * 1536-dim float vector in the same unified multimodal space the worker stored.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const out = (await invokeJson(embedModel(), {
    texts: [text || " "],
    input_type: "search_query",
    embedding_types: ["float"],
    output_dimension: EMBED_DIM,
  })) as { embeddings?: unknown };

  const emb = out.embeddings;
  // Embed v4 returns {"float": [[...]]} when embedding_types is set, or a bare
  // [[...]] otherwise. Handle both (mirrors `_embed_invoke` in common.py).
  if (emb && typeof emb === "object" && !Array.isArray(emb)) {
    const floats = (emb as { float?: number[][] }).float;
    if (floats && floats[0]) {
      return floats[0];
    }
  }
  if (Array.isArray(emb) && Array.isArray(emb[0])) {
    return emb[0] as number[];
  }
  throw new Error("Unexpected Embed v4 response shape");
}

export type RerankResult = { index: number; score: number };

/**
 * Rerank candidate documents against the query with Cohere Rerank v3.5
 * (multilingual). Returns `[{ index, score }]` best-first, where `index` is the
 * position in the input `documents` array.
 */
export async function rerank(
  query: string,
  documents: string[],
  topN?: number,
): Promise<RerankResult[]> {
  if (documents.length === 0) {
    return [];
  }
  const out = (await invokeJson(
    rerankModel(),
    {
      query,
      documents,
      top_n: topN ?? documents.length,
      api_version: 2,
    },
    // Cohere Rerank lives in us-east-1, not the embed/S3 region.
    getRerankBedrock(),
  )) as { results?: { index: number; relevance_score: number }[] };

  return (out.results ?? []).map((r) => ({
    index: r.index,
    score: r.relevance_score,
  }));
}

/** Escape a string for embedding in a LanceDB SQL `where` clause. */
export function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Fuzzy-match a user phrase against stored `source_file` names. Returns the
 * sorted, de-duplicated list of matching filenames.
 */
export async function resolveSourceFiles(
  table: lancedb.Table,
  phrase: string,
): Promise<string[]> {
  const rows = (await table
    .query()
    .where(`source_file LIKE '%${escapeSql(phrase)}%'`)
    .select(["source_file"])
    .limit(500)
    .toArray()) as { source_file: string }[];

  const unique = new Set<string>();
  for (const row of rows) {
    if (row.source_file) {
      unique.add(row.source_file);
    }
  }
  return [...unique].sort();
}

/**
 * Build an AND-joined `where` clause from the optional document/modality
 * filters. Returns `undefined` when no filters are set.
 */
export function buildWhere(opts: {
  documentId?: string;
  sourceFile?: string;
  modalities?: string[];
}): string | undefined {
  const clauses: string[] = [];
  if (opts.documentId) {
    clauses.push(`document_id = '${escapeSql(opts.documentId)}'`);
  }
  if (opts.sourceFile) {
    clauses.push(`source_file = '${escapeSql(opts.sourceFile)}'`);
  }
  if (opts.modalities && opts.modalities.length > 0) {
    const joined = opts.modalities
      .map((m) => `'${escapeSql(m)}'`)
      .join(", ");
    clauses.push(`modality IN (${joined})`);
  }
  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}
