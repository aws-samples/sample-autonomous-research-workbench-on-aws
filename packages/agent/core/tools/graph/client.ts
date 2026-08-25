import {
  DOC_TITLES_BY_IDS_QUERY,
  FRONTIER_EXPAND_PREDICATE_QUERY,
  FRONTIER_EXPAND_QUERY,
  runQuery,
  toInt,
  toNumber,
  toPlain,
  type GraphLink,
  type GraphNode,
} from "@repo/graph";

/**
 * Shared plumbing for the knowledge-graph tools. Facts live reified in the
 * store — (:Infon) nodes between (:Entity) nodes — but tools serve them in
 * two parallel shapes: a flat `GraphFact` list for the model, and a collapsed
 * `{nodes, links}` subgraph (the same DocumentGraph convention the explorer
 * renders) for the web tool view's Sigma canvas.
 *
 * Everything numeric is coerced through toNumber/toPlain here: neo4j Integer
 * objects survive into the payload otherwise and JSON.stringify throws when
 * the tool result is persisted to TaskMessage, failing the whole run (same
 * trap as the LanceDB BigInt in documents/query.ts).
 */

/** One reified fact, flattened for the LLM. */
export type GraphFact = {
  infonId: string;
  /** Literal subject/object text on the infon (may differ from entity name). */
  subject: string;
  predicate: string;
  object: string;
  /** Canonical entity names — the subgraph node ids. */
  sourceEntity: string;
  targetEntity: string;
  polarity: string | null;
  confidence: number | null;
  inVocab: boolean | null;
  domainRangeOk: boolean | null;
  documentId: string | null;
  documentTitle?: string;
};

export type Subgraph = { nodes: GraphNode[]; links: GraphLink[] };

// Payload caps — tool results are persisted to TaskMessage and streamed to
// the browser, so bound the worst case (~120 KB). Every payload reports its
// caps so the model knows results may be partial.
export const MAX_FACTS = 50;
export const MAX_NODES = 150;
export const MAX_LINKS = 300;

type FrontierRow = {
  id: unknown;
  source: unknown;
  target: unknown;
  source_kind: unknown;
  target_kind: unknown;
  source_curated: unknown;
  target_curated: unknown;
  subject: unknown;
  predicate: unknown;
  object: unknown;
  polarity: unknown;
  confidence: unknown;
  in_vocab: unknown;
  domain_range_ok: unknown;
  document_id: unknown;
};

export type ExpandedFact = GraphFact & {
  sourceKind: string | null;
  targetKind: string | null;
  sourceCurated: boolean;
  targetCurated: boolean;
};

function asString(value: unknown): string {
  return value == null ? "" : String(value);
}

function asNullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function asNullableBoolean(value: unknown): boolean | null {
  return value == null ? null : Boolean(toPlain(value));
}

export function rowToFact(row: FrontierRow): ExpandedFact {
  return {
    infonId: asString(row.id),
    subject: asString(row.subject),
    predicate: asString(row.predicate),
    object: asString(row.object),
    sourceEntity: asString(row.source),
    targetEntity: asString(row.target),
    polarity: asNullableString(row.polarity),
    confidence: row.confidence == null ? null : toNumber(row.confidence),
    inVocab: asNullableBoolean(row.in_vocab),
    domainRangeOk: asNullableBoolean(row.domain_range_ok),
    documentId: asNullableString(row.document_id),
    sourceKind: asNullableString(row.source_kind),
    targetKind: asNullableString(row.target_kind),
    sourceCurated: Boolean(toPlain(row.source_curated)),
    targetCurated: Boolean(toPlain(row.target_curated)),
  };
}

/**
 * All facts touching any entity in `names` — one bounded query. Used per hop
 * by the neighborhood and path tools so LIMIT/dedup stay under TS control
 * instead of an unbounded variable-length Cypher pattern.
 */
export async function expandFrontier(
  names: string[],
  opts: { predicate?: string; limit: number },
): Promise<ExpandedFact[]> {
  if (names.length === 0) return [];
  const rows = await runQuery<FrontierRow>(
    opts.predicate ? FRONTIER_EXPAND_PREDICATE_QUERY : FRONTIER_EXPAND_QUERY,
    {
      names,
      limit: toInt(opts.limit),
      ...(opts.predicate ? { predicate: opts.predicate } : {}),
    },
  );
  return rows.map(rowToFact);
}

/** Resolve provenance document ids to titles (missing ids are omitted). */
export async function resolveDocumentTitles(
  documentIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(documentIds)].filter(Boolean);
  if (ids.length === 0) return new Map();
  const rows = await runQuery<{ id: unknown; title: unknown }>(
    DOC_TITLES_BY_IDS_QUERY,
    { ids },
  );
  return new Map(rows.map((r) => [String(r.id), String(r.title)]));
}

/** Attach documentTitle to facts and return the distinct provenance list. */
export async function attachProvenance(
  facts: GraphFact[],
): Promise<{ id: string; title: string }[]> {
  const titles = await resolveDocumentTitles(
    facts.map((f) => f.documentId ?? ""),
  );
  for (const fact of facts) {
    if (fact.documentId && titles.has(fact.documentId)) {
      fact.documentTitle = titles.get(fact.documentId);
    }
  }
  return [...titles.entries()].map(([id, title]) => ({ id, title }));
}

/**
 * Build the collapsed-infon subgraph for the Sigma tool view: Entity nodes +
 * one labeled INFON link per fact — exactly what BoltGraphProvider serves, so
 * the embedded canvas renders tool output and explorer identically. Dedup by
 * entity name / infon id, enforce the payload caps.
 */
export function factsToSubgraph(
  facts: ExpandedFact[],
  extraNodes: GraphNode[] = [],
): Subgraph & { truncated: boolean } {
  const nodes = new Map<string, GraphNode>();
  for (const node of extraNodes) {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  }
  const links = new Map<string, GraphLink>();
  let truncated = false;

  for (const fact of facts) {
    for (const [name, kind, curated] of [
      [fact.sourceEntity, fact.sourceKind, fact.sourceCurated],
      [fact.targetEntity, fact.targetKind, fact.targetCurated],
    ] as const) {
      if (!nodes.has(name)) {
        if (nodes.size >= MAX_NODES) {
          truncated = true;
          continue;
        }
        nodes.set(name, {
          id: name,
          label: name,
          kind: "Entity",
          properties: { entity_kind: kind, curated },
        });
      }
    }
    if (!nodes.has(fact.sourceEntity) || !nodes.has(fact.targetEntity)) {
      continue;
    }
    if (!links.has(fact.infonId)) {
      if (links.size >= MAX_LINKS) {
        truncated = true;
        continue;
      }
      links.set(fact.infonId, {
        source: fact.sourceEntity,
        target: fact.targetEntity,
        type: "INFON",
        id: fact.infonId,
        label: fact.predicate,
        properties: {
          predicate: fact.predicate,
          subject: fact.subject,
          object: fact.object,
          polarity: fact.polarity,
          confidence: fact.confidence,
          in_vocab: fact.inVocab,
          domain_range_ok: fact.domainRangeOk,
          document_id: fact.documentId,
        },
      });
    }
  }

  return {
    nodes: [...nodes.values()],
    links: [...links.values()],
    truncated,
  };
}

/** Strip the expansion-only endpoint fields for the LLM-facing fact list. */
export function toPublicFact(fact: ExpandedFact & { hop?: number }): GraphFact & {
  hop?: number;
} {
  const {
    sourceKind: _sk,
    targetKind: _tk,
    sourceCurated: _sc,
    targetCurated: _tc,
    ...rest
  } = fact;
  return rest;
}

/** Dedup key collapsing per-document repeats of the same semantic fact. */
export function factKey(fact: GraphFact): string {
  return `${fact.sourceEntity}|${fact.predicate}|${fact.targetEntity}`;
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
