import { createHash } from "node:crypto";

import { tool } from "ai";
import { z } from "zod";

import {
  PREDICATE_LOOKUP_QUERY,
  runQuery,
  WRITE_AGENT_INFON_QUERY,
  WRITE_AGENT_INFON_WITH_DOC_QUERY,
} from "@repo/graph";

import { errorDetail } from "./client";

/**
 * Result `type` discriminant, stamped onto every return (success and error) so
 * tool results are attributable in analytics the same way the read tools
 * already are — see the `const NAME` pattern in search.ts et al.
 */
const FACT_WRITE = "graph-add-fact" as const;

/**
 * Write tool for the knowledge graph ("graph-write" group, enabled by
 * default via DEFAULT_TOOL_IDS). Facts follow the same reified shape the ingestion
 * pipeline writes — (:Infon) between (:Entity) via S_OF/O_OF — so
 * agent-authored facts show up in every existing read tool and the explorer
 * with no extra plumbing. Agent writes are marked verified_by='agent'.
 *
 * The graph is append-only from the agent's side: there is no upsert to
 * re-kind/rename an existing entity and no delete to remove a fact — the
 * knowledge substrate only grows. (Re-asserting the same triple still MERGEs
 * onto the same node, so it corrects an in-flight polarity/confidence without
 * duplicating; the identifying triple itself is frozen by the id hash.)
 * Entities are created as a side effect of a fact (MERGE (s:Entity) in the
 * write query), so agents never need a dedicated entity-write tool.
 *
 * Facts written by an agent running under a project are stamped with that
 * project's id (i.project_id), which is what the project-scoped graph view
 * filters on. The project id is not a tool input — the model can't be trusted
 * to supply it — so it's injected into the agent loop's experimental_context
 * by the worker (same channel as spawnSubAgent) and read at call time.
 *
 * infon_id is a deterministic hash of (subject, predicate, object, documentId,
 * projectId), so re-asserting the same fact MERGEs onto the same node instead
 * of duplicating it — same idempotency contract as ingestion. projectId is
 * part of the key so the same triple asserted under two projects stays two
 * distinct, independently-scoped facts.
 */

function agentInfonId(
  subject: string,
  predicate: string,
  object: string,
  documentId: string | null,
  projectId: string | null,
): string {
  const digest = createHash("sha256")
    .update([subject, predicate, object, documentId ?? "", projectId ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
  return `agent:${digest}`;
}

/**
 * Provenance the worker injects into the agent loop's experimental_context.
 * None of it is a tool input — the model can't be trusted to supply it — and
 * all of it is stamped onto the infons this run writes so the research loop
 * can answer "what knowledge is new since the watermark, and who added it"
 * straight from the graph.
 */
export type GraphWriteContext = {
  projectId: string | null;
  runId: string | null;
  rootRunId: string | null;
  /** The persona agent that owns this run tree (root run's agentType). */
  authorAgentId: string | null;
  /** The persona's display name, for human-readable attribution. */
  authorName: string | null;
};

/** Read the provenance the worker injected into the agent loop's context. */
function getWriteContext(experimentalContext: unknown): GraphWriteContext {
  const context: GraphWriteContext = {
    projectId: null,
    runId: null,
    rootRunId: null,
    authorAgentId: null,
    authorName: null,
  };
  if (!experimentalContext || typeof experimentalContext !== "object") {
    return context;
  }
  const source = experimentalContext as Record<string, unknown>;
  for (const key of Object.keys(context) as (keyof GraphWriteContext)[]) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) context[key] = value;
  }
  return context;
}

export const graphAddFact = tool({
  description:
    "Write a fact (subject–predicate–object triple) to the knowledge graph. The graph is append-only: re-asserting the same triple MERGEs onto the existing fact (correcting its polarity/confidence) instead of duplicating it, and a fact cannot be deleted. Resolve exact entity names with graphSearch first — a misspelled subject/object silently creates a new entity. Any entity named here is created if it does not exist. Facts you write are marked as agent-authored.",
  inputSchema: z.object({
    subject: z
      .string()
      .min(1)
      .describe("Subject entity name (exact, canonical)."),
    predicate: z
      .string()
      .min(1)
      .describe(
        "Relationship predicate. Prefer predicates already in the ontology (graphOverview lists them).",
      ),
    object: z
      .string()
      .min(1)
      .describe("Object entity name (exact, canonical)."),
    polarity: z
      .enum(["positive", "negative"])
      .default("positive")
      .describe("'negative' asserts the relationship does NOT hold."),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .default(1)
      .describe("Confidence in the fact, 0–1."),
    subjectKind: z
      .string()
      .optional()
      .describe("Kind for the subject entity if it must be created."),
    objectKind: z
      .string()
      .optional()
      .describe("Kind for the object entity if it must be created."),
    documentId: z
      .string()
      .optional()
      .describe(
        "Provenance document id (from queryDocuments/graph tools). Links the fact to that document; fails if the id is unknown.",
      ),
  }),
  execute: async (
    {
      subject,
      predicate,
      object,
      polarity,
      confidence,
      subjectKind,
      objectKind,
      documentId,
    },
    options,
  ) => {
    try {
      const writeContext = getWriteContext(options?.experimental_context);
      const { projectId } = writeContext;

      // Advisory ontology check — writes are allowed off-vocabulary, but the
      // fact is flagged (in_vocab) exactly like ingestion does.
      const predicateRows = await runQuery<{ name: unknown }>(
        PREDICATE_LOOKUP_QUERY,
        { name: predicate },
      );
      const inVocab = predicateRows.length > 0;

      const infonId = agentInfonId(
        subject,
        predicate,
        object,
        documentId ?? null,
        projectId,
      );
      const params = {
        infonId,
        subject,
        predicate,
        object,
        polarity,
        confidence,
        inVocab,
        subjectKind: subjectKind ?? null,
        objectKind: objectKind ?? null,
        documentId: documentId ?? null,
        projectId,
        // Provenance for the research loop. coalesce-kept in the query: a
        // re-assert never refreshes created_at_ms, so dedup'd facts don't
        // re-count as new knowledge. App clock (epoch ms) — workers are
        // NTP-synced and the watermark advances to max-seen, which absorbs
        // millisecond skew.
        createdAtMs: Date.now(),
        authorAgentId: writeContext.authorAgentId,
        authorName: writeContext.authorName,
        runId: writeContext.runId,
        rootRunId: writeContext.rootRunId,
      };
      const rows = await runQuery<{ id: unknown }>(
        documentId ? WRITE_AGENT_INFON_WITH_DOC_QUERY : WRITE_AGENT_INFON_QUERY,
        params,
      );
      if (documentId && rows.length === 0) {
        return {
          type: FACT_WRITE,
          error: "document not found",
          detail: `no Document with id '${documentId}' — fact not written. Omit documentId or resolve a valid id first.`,
        };
      }
      return {
        type: FACT_WRITE,
        written: true,
        infonId,
        fact: { subject, predicate, object, polarity, confidence },
        projectId,
        inVocab,
        note: inVocab
          ? undefined
          : `predicate '${predicate}' is not in the ontology — the fact was written but flagged in_vocab=false. Check graphOverview for canonical predicates.`,
      };
    } catch (error) {
      return {
        type: FACT_WRITE,
        error: "graph write failed",
        detail: errorDetail(error),
      };
    }
  },
});
