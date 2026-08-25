import { createHash } from "node:crypto";

import { tool } from "ai";
import { z } from "zod";

import {
  CREATE_HYPOTHESIS_QUERY,
  CREATE_OBSERVATION_QUERY,
  DECISION_AFFECTS_QUERY,
  DECISION_INFORMED_BY_QUERY,
  LINK_CONTRADICTS_QUERY,
  LINK_DERIVED_FROM_QUERY,
  LINK_SUPPORTS_QUERY,
  RECORD_DECISION_QUERY,
  runQuery,
  SET_HYPOTHESIS_STATUS_QUERY,
} from "@repo/graph";

import { errorDetail } from "../graph/client";

/**
 * Result `type` discriminants, one per tool. Stamped onto every return (success
 * and error) so epistemic writes are attributable in analytics, matching the
 * `const NAME` pattern the read tools already use.
 */
const HYPOTHESIS_WRITE = "epistemic-propose-hypothesis" as const;
const OBSERVATION_WRITE = "epistemic-record-observation" as const;
const EVIDENCE_LINK = "epistemic-link-evidence" as const;
const HYPOTHESIS_STATUS_WRITE = "epistemic-set-hypothesis-status" as const;
const DECISION_WRITE = "epistemic-record-decision" as const;

/**
 * Epistemic-graph write tools ("graph-epistemic" group, enabled by default via
 * DEFAULT_TOOL_IDS). Where graphAddFact records objective facts as reified
 * (:Infon) triples, these tools record the agent's *reasoning* — Hypotheses it
 * proposes, Observations it derives from tool output, the evidence links
 * between them, and Decisions it makes — as DEDICATED node labels with typed
 * edges.
 *
 * Scoping mirrors graph-write: project_id and run_id are injected into the
 * agent loop's experimental_context by the worker (the model can't be trusted
 * to supply them) and stamped onto every node at write time. generating_agent
 * comes from the same channel, not a hardcoded literal.
 *
 * Node ids are a deterministic hash of the identifying content plus projectId,
 * so re-asserting the same hypothesis/observation MERGEs onto the same node
 * instead of duplicating it — same idempotency contract as graphAddFact.
 * created_at is coalesced in Cypher, so re-asserting never rewinds a node's
 * birth time or clobbers a status that has since advanced.
 */

const CONFIDENCE = ["low", "medium", "high"] as const;
const HYPOTHESIS_STATUS = [
  "proposed",
  "supported",
  "refuted",
  "superseded",
  "graduated",
] as const;

/** Deterministic, prefixed id. Prefix namespaces the node kind; projectId in
 * the key keeps the same claim under two projects distinct. */
function epistemicId(
  prefix: string,
  parts: string[],
  projectId: string | null,
): string {
  const digest = createHash("sha256")
    .update([...parts, projectId ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}:${digest}`;
}

type Context = {
  projectId: string | null;
  runId: string | null;
  /** generating_agent / author_name: the persona that owns this run. */
  agent: string;
};

/** Read the scope ids the worker injected into the agent loop's context. */
function getContext(experimentalContext: unknown): Context {
  const ctx =
    experimentalContext && typeof experimentalContext === "object"
      ? (experimentalContext as Record<string, unknown>)
      : {};
  const str = (v: unknown) =>
    typeof v === "string" && v.length > 0 ? v : null;
  return {
    projectId: str(ctx.projectId),
    runId: str(ctx.runId),
    // generating_agent: the persona's display name the worker injects
    // (authorName — same channel graphAddFact reads), else a stable fallback so
    // writes are never anonymous. The research loop groups per author on this.
    agent: str(ctx.authorName) ?? str(ctx.agentName) ?? str(ctx.persona) ?? "agent",
  };
}

export const epistemicProposeHypothesis = tool({
  description:
    "Propose a testable scientific hypothesis and persist it to the knowledge graph. A hypothesis is a claim you can later support or refute with observations (use epistemicLinkEvidence). Idempotent: proposing the same claim again returns the existing hypothesis instead of duplicating it. Returns the hypothesisId you pass to epistemicLinkEvidence and epistemicSetHypothesisStatus.",
  inputSchema: z.object({
    claim: z
      .string()
      .min(1)
      .describe("The hypothesis, stated as a falsifiable claim."),
    testablePrediction: z
      .string()
      .min(1)
      .describe(
        "A concrete, testable prediction that would confirm or refute the claim.",
      ),
    confidence: z
      .enum(CONFIDENCE)
      .default("low")
      .describe("Your prior confidence in the hypothesis."),
  }),
  execute: async ({ claim, testablePrediction, confidence }, options) => {
    try {
      const { projectId, runId, agent } = getContext(
        options?.experimental_context,
      );
      const id = epistemicId(
        "hypothesis",
        [claim, testablePrediction],
        projectId,
      );
      const rows = await runQuery<{ id: unknown; status: unknown }>(
        CREATE_HYPOTHESIS_QUERY,
        {
          id,
          claim,
          testablePrediction,
          status: "proposed",
          confidence,
          generatingAgent: agent,
          authorName: agent,
          projectId,
          runId,
          createdAt: new Date().toISOString(),
          createdAtMs: Date.now(),
        },
      );
      return {
        type: HYPOTHESIS_WRITE,
        written: true,
        hypothesisId: id,
        status: rows[0]?.status == null ? "proposed" : String(rows[0].status),
        claim,
        projectId,
      };
    } catch (error) {
      return {
        type: HYPOTHESIS_WRITE,
        error: "graph write failed",
        detail: errorDetail(error),
      };
    }
  },
});

export const epistemicRecordObservation = tool({
  description:
    "Record an observation — a factual claim derived from tool output or data — in the knowledge graph. Optionally link it to the ingested entities it was derived from (resolve exact names with graphSearch first). Idempotent. Returns the observationId you pass to epistemicLinkEvidence.",
  inputSchema: z.object({
    claim: z
      .string()
      .min(1)
      .describe("The observation, stated as a factual claim."),
    confidence: z
      .enum(CONFIDENCE)
      .default("medium")
      .describe("Your confidence in the observation."),
    sourceTool: z
      .string()
      .optional()
      .describe("The tool or data source this observation came from, if any."),
    sourceEntities: z
      .array(z.string())
      .default([])
      .describe(
        "Exact canonical entity names this observation is derived from (creates derived_from edges). Resolve names with graphSearch first; unknown names are skipped, not created.",
      ),
  }),
  execute: async (
    { claim, confidence, sourceTool, sourceEntities },
    options,
  ) => {
    try {
      const { projectId, runId, agent } = getContext(
        options?.experimental_context,
      );
      const id = epistemicId(
        "observation",
        [claim, sourceTool ?? ""],
        projectId,
      );
      await runQuery(CREATE_OBSERVATION_QUERY, {
        id,
        claim,
        confidence,
        sourceTool: sourceTool ?? null,
        generatingAgent: agent,
        authorName: agent,
        projectId,
        runId,
        createdAt: new Date().toISOString(),
        createdAtMs: Date.now(),
      });

      // derived_from edges — report which names actually resolved so the model
      // can fix typos rather than assume all links landed.
      const linked: string[] = [];
      const unresolved: string[] = [];
      for (const name of sourceEntities) {
        const rows = await runQuery<{ name: unknown }>(
          LINK_DERIVED_FROM_QUERY,
          {
            observationId: id,
            entityName: name,
          },
        );
        if (rows.length > 0) linked.push(name);
        else unresolved.push(name);
      }

      return {
        type: OBSERVATION_WRITE,
        written: true,
        observationId: id,
        claim,
        projectId,
        derivedFrom: linked,
        ...(unresolved.length > 0
          ? {
              unresolvedEntities: unresolved,
              note: `these entity names were not found and were not linked: ${unresolved.join(", ")}. Use graphSearch to resolve exact names.`,
            }
          : {}),
      };
    } catch (error) {
      return {
        type: OBSERVATION_WRITE,
        error: "graph write failed",
        detail: errorDetail(error),
      };
    }
  },
});

export const epistemicLinkEvidence = tool({
  description:
    "Link an observation to a hypothesis as evidence, either supporting or contradicting it. Both ids come from epistemicRecordObservation / epistemicProposeHypothesis. Idempotent: re-linking the same pair updates the weight/rationale. Fails if either id is unknown.",
  inputSchema: z.object({
    hypothesisId: z
      .string()
      .min(1)
      .describe("The hypothesisId returned by epistemicProposeHypothesis."),
    observationId: z
      .string()
      .min(1)
      .describe("The observationId returned by epistemicRecordObservation."),
    polarity: z
      .enum(["supports", "contradicts"])
      .describe(
        "Whether the observation supports or contradicts the hypothesis.",
      ),
    weight: z
      .number()
      .min(0)
      .max(1)
      .default(0.5)
      .describe("Strength of the evidence, 0–1."),
    rationale: z
      .string()
      .default("")
      .describe("Why this observation is evidence for/against the hypothesis."),
  }),
  execute: async (
    { hypothesisId, observationId, polarity, weight, rationale },
    options,
  ) => {
    try {
      const { agent } = getContext(options?.experimental_context);
      const rows = await runQuery<{ polarity: unknown }>(
        polarity === "supports" ? LINK_SUPPORTS_QUERY : LINK_CONTRADICTS_QUERY,
        {
          hypothesisId,
          observationId,
          weight,
          rationale,
          generatingAgent: agent,
        },
      );
      if (rows.length === 0) {
        return {
          type: EVIDENCE_LINK,
          error: "endpoint not found",
          detail: `no evidence link created — check that hypothesisId '${hypothesisId}' and observationId '${observationId}' both exist.`,
        };
      }
      return {
        type: EVIDENCE_LINK,
        linked: true,
        hypothesisId,
        observationId,
        polarity,
        weight,
      };
    } catch (error) {
      return {
        type: EVIDENCE_LINK,
        error: "graph write failed",
        detail: errorDetail(error),
      };
    }
  },
});

export const epistemicSetHypothesisStatus = tool({
  description:
    "Update a hypothesis's status as evidence accumulates: 'supported', 'refuted', 'superseded', or back to 'proposed'. Persists the change. Fails if the hypothesisId is unknown.",
  inputSchema: z.object({
    hypothesisId: z
      .string()
      .min(1)
      .describe("The hypothesisId returned by epistemicProposeHypothesis."),
    newStatus: z
      .enum(HYPOTHESIS_STATUS)
      .describe("The new status for the hypothesis."),
    reason: z
      .string()
      .default("")
      .describe("Why the status changed (e.g. which evidence drove it)."),
  }),
  execute: async ({ hypothesisId, newStatus, reason }, _options) => {
    try {
      const rows = await runQuery<{ id: unknown; status: unknown }>(
        SET_HYPOTHESIS_STATUS_QUERY,
        { hypothesisId, status: newStatus, reason },
      );
      if (rows.length === 0) {
        return {
          type: HYPOTHESIS_STATUS_WRITE,
          error: "not found",
          detail: `no hypothesis with id '${hypothesisId}'`,
        };
      }
      return {
        type: HYPOTHESIS_STATUS_WRITE,
        updated: true,
        hypothesisId,
        status: String(rows[0]?.status ?? newStatus),
      };
    } catch (error) {
      return {
        type: HYPOTHESIS_STATUS_WRITE,
        error: "graph write failed",
        detail: errorDetail(error),
      };
    }
  },
});

export const epistemicRecordDecision = tool({
  description:
    "Record a decision (with rationale) in the knowledge graph — e.g. advancing or deprioritizing a compound, approving a gate, selecting a lead. Optionally record which nodes the decision affects and which observations/hypotheses informed it (by exact entity name or by hypothesis/observation id). Idempotent.",
  inputSchema: z.object({
    decisionType: z
      .string()
      .min(1)
      .describe(
        "Kind of decision, e.g. 'advance', 'deprioritize', 'gate_approval', 'select_lead', 'reject'.",
      ),
    description: z.string().min(1).describe("What was decided."),
    rationale: z.string().default("").describe("Why the decision was made."),
    affects: z
      .array(z.string())
      .default([])
      .describe(
        "Entity names or hypothesis ids this decision affects (creates affects edges). Unknown refs are skipped.",
      ),
    informedBy: z
      .array(z.string())
      .default([])
      .describe(
        "Observation/hypothesis ids (or entity names) that informed this decision (creates informs_decision edges). Unknown refs are skipped.",
      ),
  }),
  execute: async (
    { decisionType, description, rationale, affects, informedBy },
    options,
  ) => {
    const startedAt = Date.now();
    let runLabel = "?";
    let stage = "initialize";
    try {
      const { projectId, runId, agent } = getContext(
        options?.experimental_context,
      );
      runLabel = runId?.slice(0, 8) ?? "?";
      const id = epistemicId(
        "decision",
        [decisionType, description],
        projectId,
      );
      console.log(
        `[epistemicRecordDecision] run=${runLabel} start decision=${id} ` +
          `affects=${affects.length} informedBy=${informedBy.length}`,
      );

      stage = "write-decision";
      const decisionStartedAt = Date.now();
      console.log(
        `[epistemicRecordDecision] run=${runLabel} stage=${stage} start decision=${id}`,
      );
      await runQuery(RECORD_DECISION_QUERY, {
        id,
        decisionType,
        description,
        rationale,
        generatingAgent: agent,
        projectId,
        runId,
        createdAt: new Date().toISOString(),
      });
      console.log(
        `[epistemicRecordDecision] run=${runLabel} stage=${stage} complete ` +
          `durationMs=${Date.now() - decisionStartedAt}`,
      );

      const affected: string[] = [];
      const unresolvedAffects: string[] = [];
      for (const [index, ref] of affects.entries()) {
        stage = `link-affects-${index + 1}/${affects.length}`;
        const refStartedAt = Date.now();
        console.log(
          `[epistemicRecordDecision] run=${runLabel} stage=${stage} start ` +
            `ref=${JSON.stringify(ref).slice(0, 200)}`,
        );
        const rows = await runQuery<{ ref: unknown }>(DECISION_AFFECTS_QUERY, {
          decisionId: id,
          ref,
        });
        const resolved = rows.length > 0;
        console.log(
          `[epistemicRecordDecision] run=${runLabel} stage=${stage} complete ` +
            `resolved=${resolved} durationMs=${Date.now() - refStartedAt}`,
        );
        if (resolved) affected.push(ref);
        else unresolvedAffects.push(ref);
      }

      const informed: string[] = [];
      const unresolvedInformed: string[] = [];
      for (const [index, ref] of informedBy.entries()) {
        stage = `link-informed-${index + 1}/${informedBy.length}`;
        const refStartedAt = Date.now();
        console.log(
          `[epistemicRecordDecision] run=${runLabel} stage=${stage} start ` +
            `ref=${JSON.stringify(ref).slice(0, 200)}`,
        );
        const rows = await runQuery<{ ref: unknown }>(
          DECISION_INFORMED_BY_QUERY,
          { decisionId: id, ref },
        );
        const resolved = rows.length > 0;
        console.log(
          `[epistemicRecordDecision] run=${runLabel} stage=${stage} complete ` +
            `resolved=${resolved} durationMs=${Date.now() - refStartedAt}`,
        );
        if (resolved) informed.push(ref);
        else unresolvedInformed.push(ref);
      }

      console.log(
        `[epistemicRecordDecision] run=${runLabel} complete decision=${id} ` +
          `durationMs=${Date.now() - startedAt}`,
      );
      const unresolved = [...unresolvedAffects, ...unresolvedInformed];
      return {
        type: DECISION_WRITE,
        written: true,
        decisionId: id,
        decisionType,
        projectId,
        affects: affected,
        informedBy: informed,
        ...(unresolved.length > 0
          ? {
              unresolvedRefs: unresolved,
              note: `these refs were not found and were not linked: ${unresolved.join(", ")}.`,
            }
          : {}),
      };
    } catch (error) {
      console.error(
        `[epistemicRecordDecision] run=${runLabel} FAILED stage=${stage} ` +
          `durationMs=${Date.now() - startedAt}:`,
        error,
      );
      return {
        type: DECISION_WRITE,
        error: "graph write failed",
        detail: errorDetail(error),
      };
    }
  },
});
