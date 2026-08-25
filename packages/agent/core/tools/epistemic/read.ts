import { tool } from "ai";
import { z } from "zod";

import {
  HYPOTHESIS_EVIDENCE_QUERY,
  QUERY_HYPOTHESES_QUERY,
  QUERY_HYPOTHESES_STATUS_QUERY,
  runQuery,
  toInt,
  toNumber,
} from "@repo/graph";

import { errorDetail } from "../graph/client";

/**
 * Result `type` discriminants, one per tool — stamped on every return so read
 * results are attributable in analytics, matching the write tools.
 */
const EVIDENCE_READ = "epistemic-list-evidence" as const;
const HYPOTHESES_READ = "epistemic-list-hypotheses" as const;

/**
 * Read tools for the epistemic graph, in the same "graph-epistemic" group as
 * the write tools they pair with. Agents use these to review what they (or
 * prior runs in the same project) already recorded before proposing duplicates
 * or linking evidence. Reads are project-scoped through the same
 * experimental_context channel the write tools use.
 */

function getProjectId(experimentalContext: unknown): string | null {
  if (
    experimentalContext &&
    typeof experimentalContext === "object" &&
    "projectId" in experimentalContext
  ) {
    const { projectId } = experimentalContext as { projectId?: unknown };
    if (typeof projectId === "string" && projectId.length > 0) return projectId;
  }
  return null;
}

const HYPOTHESIS_STATUS = [
  "proposed",
  "supported",
  "refuted",
  "superseded",
  "graduated",
] as const;

export const epistemicListEvidence = tool({
  description:
    "List the observations linked to a hypothesis as supporting or contradicting evidence, with weights and rationale. Use this to review the evidence base before updating a hypothesis's status.",
  inputSchema: z.object({
    hypothesisId: z
      .string()
      .min(1)
      .describe("The hypothesisId returned by epistemicProposeHypothesis."),
  }),
  execute: async ({ hypothesisId }) => {
    try {
      const rows = await runQuery<{
        observation_id: unknown;
        claim: unknown;
        polarity: unknown;
        weight: unknown;
        rationale: unknown;
      }>(HYPOTHESIS_EVIDENCE_QUERY, { hypothesisId });
      const evidence = rows.map((row) => ({
        observationId: String(row.observation_id),
        claim: String(row.claim),
        polarity: String(row.polarity),
        weight: row.weight == null ? null : toNumber(row.weight),
        rationale: row.rationale == null ? "" : String(row.rationale),
      }));
      return {
        type: EVIDENCE_READ,
        hypothesisId,
        count: evidence.length,
        supporting: evidence.filter((e) => e.polarity === "supports").length,
        contradicting: evidence.filter((e) => e.polarity === "contradicts")
          .length,
        evidence,
      };
    } catch (error) {
      return {
        type: EVIDENCE_READ,
        hypothesisId,
        error: "evidence lookup failed",
        detail: errorDetail(error),
        evidence: [],
      };
    }
  },
});

export const epistemicListHypotheses = tool({
  description:
    "List hypotheses recorded in the current project, newest first, optionally filtered by status. Use this to see what has already been proposed before adding a new hypothesis.",
  inputSchema: z.object({
    status: z
      .enum(HYPOTHESIS_STATUS)
      .optional()
      .describe("Restrict to hypotheses with this status."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Maximum hypotheses to return."),
  }),
  execute: async ({ status, limit }, options) => {
    try {
      const projectId = getProjectId(options?.experimental_context);
      if (!projectId) {
        return {
          type: HYPOTHESES_READ,
          error: "no project context",
          detail:
            "epistemicListHypotheses is project-scoped and must run inside a project.",
          hypotheses: [],
        };
      }
      const rows = await runQuery<{
        id: unknown;
        claim: unknown;
        testable_prediction: unknown;
        status: unknown;
        confidence: unknown;
        created_at: unknown;
      }>(status ? QUERY_HYPOTHESES_STATUS_QUERY : QUERY_HYPOTHESES_QUERY, {
        projectId,
        limit: toInt(limit),
        ...(status ? { status } : {}),
      });
      const hypotheses = rows.map((row) => ({
        hypothesisId: String(row.id),
        claim: String(row.claim),
        testablePrediction:
          row.testable_prediction == null
            ? ""
            : String(row.testable_prediction),
        status: row.status == null ? null : String(row.status),
        confidence: row.confidence == null ? null : String(row.confidence),
        createdAt: row.created_at == null ? null : String(row.created_at),
      }));
      return {
        type: HYPOTHESES_READ,
        count: hypotheses.length,
        hypotheses,
        caps: { limit },
      };
    } catch (error) {
      return {
        type: HYPOTHESES_READ,
        error: "hypothesis query failed",
        detail: errorDetail(error),
        hypotheses: [],
      };
    }
  },
});
