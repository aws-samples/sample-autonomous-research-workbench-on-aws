import { graphBoltUrl, runQuery, toInt } from "./bolt-client";
import {
  CREATE_HYPOTHESIS_QUERY,
  DELETE_PROJECT_DECISIONS_QUERY,
  DELETE_PROJECT_HYPOTHESES_QUERY,
  DELETE_PROJECT_INFONS_QUERY,
  DELETE_PROJECT_OBSERVATIONS_QUERY,
} from "./queries";

/**
 * Write a project's seed hypothesis into the EPISTEMIC graph as the root
 * (:Hypothesis) node — the same node label the graph-epistemic tools and the
 * research loop key on. Agents' observations attach to it via linkEvidence,
 * and its accumulation is what drives the Team Lead's sufficiency loop.
 *
 * Called deterministically at project activation: the freeform seed text
 * becomes the claim, so the anchor node exists before any agent runs (no
 * dependency on a lead turn or the project runtime being READY). The node id
 * is fixed per project (`hypothesis:seed:<projectId>`) and CREATE_HYPOTHESIS_QUERY
 * coalesces status/birth time, so re-activation is idempotent.
 */

/** Deterministic, project-stable id for the seed hypothesis node. */
export function seedHypothesisId(projectId: string): string {
  return `hypothesis:seed:${projectId}`;
}

export type SeedHypothesisResult =
  | { seeded: true; hypothesisId: string }
  | { seeded: false; reason: string };

export async function seedProjectEpistemicHypothesis(args: {
  projectId: string;
  /** The seed hypothesis text (used verbatim as the claim). */
  claim: string;
  /** A concrete prediction that would confirm or refute the claim, if known. */
  testablePrediction?: string;
  /** Who authored it. Defaults to 'platform' for the activation-time seed. */
  authorName?: string;
  /** Prior confidence: low | medium | high. Defaults to low for a seed. */
  confidence?: "low" | "medium" | "high";
}): Promise<SeedHypothesisResult> {
  if (!graphBoltUrl()) {
    return { seeded: false, reason: "Graph is not configured in this environment." };
  }
  const claim = args.claim.trim();
  if (!claim) {
    return { seeded: false, reason: "Hypothesis claim is required." };
  }

  const author = args.authorName ?? "platform";
  const id = seedHypothesisId(args.projectId);
  await runQuery(CREATE_HYPOTHESIS_QUERY, {
    id,
    claim,
    testablePrediction: args.testablePrediction?.trim() ?? "",
    status: "proposed",
    confidence: args.confidence ?? "low",
    generatingAgent: author,
    authorName: author,
    projectId: args.projectId,
    // The seed is not written under a research run.
    runId: null,
    createdAt: new Date().toISOString(),
    createdAtMs: toInt(Date.now()),
  });
  return { seeded: true, hypothesisId: id };
}

/**
 * Remove everything a project wrote into the graph — the counterpart to
 * seeding, called when the project is deleted. Drops the project's epistemic
 * reasoning nodes (:Hypothesis / :Observation / :Decision, including the seed
 * hypothesis) and its agent-authored facts (:Infon), each with all of its
 * edges via DETACH DELETE.
 *
 * The shared substrate is left intact: (:Entity), (:Document), and the ontology
 * carry no project_id and are referenced across projects. An entity that this
 * project's fact pointed at survives (another project may still reference it);
 * only the project's own nodes and their edges go.
 *
 * Best-effort and idempotent: a no-op when the graph is unconfigured, and
 * re-running after a partial failure simply deletes whatever remains.
 */
export type DeleteProjectGraphResult =
  | { deleted: true }
  | { deleted: false; reason: string };

export async function deleteProjectEpistemicGraph(args: {
  projectId: string;
}): Promise<DeleteProjectGraphResult> {
  if (!graphBoltUrl()) {
    return { deleted: false, reason: "Graph is not configured in this environment." };
  }
  const params = { projectId: args.projectId };
  // Ordered infons → observations → hypotheses → decisions, though DETACH
  // DELETE makes the order immaterial (each drops its own edges).
  await runQuery(DELETE_PROJECT_INFONS_QUERY, params);
  await runQuery(DELETE_PROJECT_OBSERVATIONS_QUERY, params);
  await runQuery(DELETE_PROJECT_HYPOTHESES_QUERY, params);
  await runQuery(DELETE_PROJECT_DECISIONS_QUERY, params);
  return { deleted: true };
}
