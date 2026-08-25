import { db, eq, lt, isNull, or, and, project } from "@repo/database";
import {
  NEW_HYPOTHESES_COUNT_QUERY,
  NEW_HYPOTHESES_QUERY,
  NEW_OBSERVATIONS_COUNT_QUERY,
  NEW_OBSERVATIONS_QUERY,
  runQuery,
  toInt,
  toNumber,
} from "@repo/graph";
import { startLeadPulse, type HeartbeatResult } from "./heartbeat";
import {
  listProjectAgents,
  startProjectAgent,
  type EnqueueRootRun,
  type ProjectAgentSummary,
} from "./project-agents";

/**
 * The research loop's knowledge accounting and event-driven pulses.
 *
 * The loop: persona agents research and record their reasoning to the
 * knowledge graph as :Observation and :Hypothesis nodes (the graph-epistemic
 * tools), each stamped with created_at_ms + author provenance (see
 * tools/epistemic/write.ts). Raw :Infon facts (graphAddFact) are the factual
 * substrate that reasoning cites — the loop does NOT react to them; it turns
 * on accumulated observations and hypotheses. When a persona's root run
 * reaches terminal, the worker calls maybeKnowledgePulse — if knowledge has
 * accumulated past the project's watermark (or the whole roster just went
 * quiet), the Team Lead
 * gets one automated turn to judge SUFFICIENCY. Not sufficient → the lead
 * waits and the pool keeps growing. Sufficient → the lead's
 * startContributionRound advances the watermark and offers every idle agent
 * a triage brief, and each agent decides for itself whether to contribute
 * another run or pass. Nothing left to contribute → the lead concludes the
 * project (stopHeartbeat with concludeProject), which ends all pulses.
 *
 * The watermark (`project.knowledgeWatermarkAt`) is the lead's last
 * sufficiency DECISION, not the last pulse: pulses never advance it, so the
 * "new since" count in successive pulses is cumulative until the lead acts.
 */

/** Debounce for pulses while agents are still working (see maybeKnowledgePulse). */
const KNOWLEDGE_PULSE_COOLDOWN_MS = 5 * 60_000;

/** Max knowledge items inlined into lead reads and contribution-round briefs. */
const MAX_FACTS_LISTED = 60;

export type NewKnowledgeSummary = {
  /** Watermark this summary was computed against (epoch ms; 0 = never set). */
  sinceMs: number;
  total: number;
  /** Max created_at_ms among the new nodes — what the watermark advances to. */
  maxCreatedAtMs: number | null;
  byAuthor: { author: string | null; count: number }[];
};

/**
 * One piece of new reasoning the loop reacts to: an :Observation or a
 * :Hypothesis. Both carry a `claim`; a hypothesis additionally carries its
 * testable prediction and lifecycle status.
 */
export type NewKnowledgeItem = {
  kind: "observation" | "hypothesis";
  id: string;
  claim: string;
  confidence: string | null;
  author: string | null;
  createdAtMs: number;
  /** Observation-only: the tool/source it was derived from, if any. */
  sourceTool?: string | null;
  /** Hypothesis-only: the concrete prediction that would confirm/refute it. */
  testablePrediction?: string | null;
  /** Hypothesis-only: proposed | supported | refuted | superseded | graduated. */
  status?: string | null;
};

/** Fold a per-author count row into the running totals. */
function accumulateAuthors(
  rows: { author: unknown; n: unknown; max_ms: unknown }[],
  counts: Map<string | null, number>,
): number | null {
  let maxCreatedAtMs: number | null = null;
  for (const row of rows) {
    const author = row.author == null ? null : String(row.author);
    const count = toNumber(row.n);
    counts.set(author, (counts.get(author) ?? 0) + count);
    const rowMax = row.max_ms == null ? null : toNumber(row.max_ms);
    if (rowMax !== null && (maxCreatedAtMs === null || rowMax > maxCreatedAtMs)) {
      maxCreatedAtMs = rowMax;
    }
  }
  return maxCreatedAtMs;
}

/**
 * Count agent reasoning (observations + hypotheses) newer than `sinceMs`,
 * grouped by author. The two label streams are counted separately (no UNION in
 * the shared dialect) and merged here.
 */
export async function summarizeNewKnowledge(
  projectId: string,
  sinceMs: number,
): Promise<NewKnowledgeSummary> {
  const params = { projectId, sinceMs: toInt(sinceMs) };
  const [obsRows, hypRows] = await Promise.all([
    runQuery<{ author: unknown; n: unknown; max_ms: unknown }>(
      NEW_OBSERVATIONS_COUNT_QUERY,
      params,
    ),
    runQuery<{ author: unknown; n: unknown; max_ms: unknown }>(
      NEW_HYPOTHESES_COUNT_QUERY,
      params,
    ),
  ]);

  const counts = new Map<string | null, number>();
  const maxObs = accumulateAuthors(obsRows, counts);
  const maxHyp = accumulateAuthors(hypRows, counts);
  const maxCreatedAtMs =
    maxObs === null ? maxHyp : maxHyp === null ? maxObs : Math.max(maxObs, maxHyp);

  let total = 0;
  const byAuthor: NewKnowledgeSummary["byAuthor"] = [];
  for (const [author, count] of counts) {
    total += count;
    byAuthor.push({ author, count });
  }
  byAuthor.sort((a, b) => b.count - a.count);
  return { sinceMs, total, maxCreatedAtMs, byAuthor };
}

/**
 * The new reasoning itself, oldest first, capped at `limit`. Each label stream
 * over-fetches to `limit`, then both are merged, re-sorted oldest-first, and
 * truncated to the true top-`limit` across both.
 */
export async function listNewKnowledge(
  projectId: string,
  sinceMs: number,
  limit = MAX_FACTS_LISTED,
): Promise<NewKnowledgeItem[]> {
  const params = { projectId, sinceMs: toInt(sinceMs), limit: toInt(limit) };
  const [obsRows, hypRows] = await Promise.all([
    runQuery<Record<string, unknown>>(NEW_OBSERVATIONS_QUERY, params),
    runQuery<Record<string, unknown>>(NEW_HYPOTHESES_QUERY, params),
  ]);

  const observations: NewKnowledgeItem[] = obsRows.map((row) => ({
    kind: "observation",
    id: String(row.id ?? ""),
    claim: String(row.claim ?? ""),
    confidence: row.confidence == null ? null : String(row.confidence),
    author: row.author == null ? null : String(row.author),
    createdAtMs: toNumber(row.created_at_ms),
    sourceTool: row.source_tool == null ? null : String(row.source_tool),
  }));
  const hypotheses: NewKnowledgeItem[] = hypRows.map((row) => ({
    kind: "hypothesis",
    id: String(row.id ?? ""),
    claim: String(row.claim ?? ""),
    confidence: row.confidence == null ? null : String(row.confidence),
    author: row.author == null ? null : String(row.author),
    createdAtMs: toNumber(row.created_at_ms),
    testablePrediction:
      row.testable_prediction == null ? null : String(row.testable_prediction),
    status: row.status == null ? null : String(row.status),
  }));

  return [...observations, ...hypotheses]
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .slice(0, limit);
}

/**
 * Advance the project's knowledge watermark to `toMs` (guarded: only moves
 * forward, so a stale/duplicate call is a no-op). Always advance to the max
 * fact timestamp actually reviewed — never wall-clock "now" — so an
 * in-flight write with a slightly earlier stamp can't land below the
 * watermark unseen.
 */
export async function advanceKnowledgeWatermark(
  projectId: string,
  toMs: number,
): Promise<boolean> {
  const to = new Date(toMs);
  const [row] = await db
    .update(project)
    .set({ knowledgeWatermarkAt: to })
    .where(
      and(
        eq(project.id, projectId),
        or(
          isNull(project.knowledgeWatermarkAt),
          lt(project.knowledgeWatermarkAt, to),
        ),
      ),
    )
    .returning({ id: project.id });
  return row !== undefined;
}

/** How a triggering run is described in the pulse message. */
export type PulseTrigger = {
  /** Display name of the persona whose root run just reached terminal. */
  agentName: string | null;
  /** Terminal status of that run (succeeded | failed | cancelled). */
  runStatus: string;
};

/**
 * The research loop's event-driven trigger, called by the worker whenever a
 * persona's ROOT run reaches terminal. Decides whether the moment warrants
 * an automated Team Lead turn:
 *
 * - Knowledge pulse: facts have accumulated past the watermark. Debounced
 *   (cooldown) while other agents are still working — bursts of finishes
 *   collapse into one pulse and nothing is lost, because the count is
 *   cumulative until the lead's next sufficiency decision.
 * - Quiescence pulse: the roster just went fully idle. Never debounced —
 *   with no runs left to finish it may be the loop's last signal, and the
 *   lead must get the chance to run another round or conclude the project.
 *
 * Everything else skips quietly; the daily scheduled heartbeat remains the
 * fallback sweep. The busy-lead guard lives in startLeadPulse; when it (or
 * anything else) skips the pulse, the watermark and pool are untouched, so
 * the next trigger retries with the same-or-larger count.
 */
export async function maybeKnowledgePulse(args: {
  projectId: string;
  enqueue: EnqueueRootRun;
  trigger?: PulseTrigger;
}): Promise<HeartbeatResult> {
  const { projectId, enqueue, trigger } = args;

  const projectRow = await db.query.project.findFirst({
    where: eq(project.id, projectId),
    columns: {
      id: true,
      status: true,
      knowledgeWatermarkAt: true,
      lastKnowledgePulseAt: true,
    },
  });
  if (!projectRow) return { started: false, reason: "Project not found." };
  if (projectRow.status !== "active") {
    return { started: false, reason: `Project is ${projectRow.status}.` };
  }

  const sinceMs = projectRow.knowledgeWatermarkAt?.getTime() ?? 0;
  const summary = await summarizeNewKnowledge(projectId, sinceMs);

  const roster = await listProjectAgents(projectId);
  const working = roster.filter(
    (a) => a.state === "working" && a.activeRunId !== null,
  );
  const allIdle = working.length === 0;

  if (summary.total === 0 && !allIdle) {
    return {
      started: false,
      reason: "No new knowledge yet and agents are still working.",
    };
  }

  if (
    !allIdle &&
    projectRow.lastKnowledgePulseAt &&
    Date.now() - projectRow.lastKnowledgePulseAt.getTime() <
      KNOWLEDGE_PULSE_COOLDOWN_MS
  ) {
    return {
      started: false,
      reason: "Knowledge pulse cooldown active; the pool keeps accumulating.",
    };
  }

  const quiescence = allIdle && summary.total === 0;
  const message = buildPulseMessage({ summary, working, trigger, allIdle });
  const result = await startLeadPulse({
    projectId,
    enqueue,
    message,
    title: quiescence
      ? "Team lead quiescence pulse"
      : "Team lead knowledge pulse",
    metadata: {
      heartbeat: true,
      pulse: quiescence ? "quiescence" : "knowledge",
    },
  });

  if (result.started) {
    await db
      .update(project)
      .set({ lastKnowledgePulseAt: new Date() })
      .where(eq(project.id, projectId));
  }
  return result;
}

function buildPulseMessage(args: {
  summary: NewKnowledgeSummary;
  working: ProjectAgentSummary[];
  trigger?: PulseTrigger;
  allIdle: boolean;
}): string {
  const { summary, working, trigger, allIdle } = args;
  const quiescence = allIdle && summary.total === 0;

  const lines: string[] = [];

  const finished = trigger?.agentName
    ? `${trigger.agentName} just ${
        trigger.runStatus === "succeeded"
          ? "completed a run"
          : `finished a run (${trigger.runStatus})`
      }. `
    : "";

  if (quiescence) {
    lines.push(
      `[Quiescence pulse] ${finished}All project agents are now idle and no new knowledge has been added since your last sufficiency decision — the research loop has gone quiet.`,
    );
  } else {
    const contributors =
      summary.byAuthor.length > 0
        ? ` (contributors: ${summary.byAuthor
            .map((a) => `${a.author ?? "unknown"}: ${a.count}`)
            .join(", ")})`
        : "";
    const rosterNote = allIdle
      ? "All agents are now idle."
      : `Still working: ${working.map((a) => a.displayName).join(", ")}.`;
    lines.push(
      `[Knowledge pulse] ${finished}${summary.total} new finding${
        summary.total === 1 ? "" : "s"
      } (observations and hypotheses) ${
        summary.total === 1 ? "has" : "have"
      } accumulated in the project's knowledge graph since your last sufficiency decision${contributors}. ${rosterNote}`,
    );
  }

  lines.push(
    "",
    "This is an automated research-loop pulse — no user is present. Decide how the project proceeds:",
    "",
  );

  if (!quiescence) {
    lines.push(
      "1. Read the new knowledge (getNewKnowledge) and judge it against the project's sufficiency criteria.",
      "2. Not sufficient yet, but no owner input is needed → start nothing and reply briefly that you are waiting; the pool keeps accumulating and you'll be pulsed again.",
      "3. Blocked on missing context or a decision only the owner can provide → MUST call pauseForGuidance before your final report. It pauses the project, stops in-flight work, and emails the owner with the exact guidance needed; because no user is present, asking only in chat is insufficient.",
      "4. Sufficient → call startContributionRound: it advances the knowledge watermark and offers every idle agent the new knowledge with a triage brief — each decides for itself whether to contribute another run or pass.",
      "5. If the objective is met or no agent can productively contribute further, call stopHeartbeat to conclude the project instead.",
    );
  } else {
    lines.push(
      "1. If there is a clear reason for another look despite no new knowledge (e.g. a previously blocked angle, or your sufficiency criteria changed), call startContributionRound.",
      "2. If progress is blocked on missing context or a decision only the owner can provide, MUST call pauseForGuidance before your final report. It pauses the project, stops in-flight work, and emails the owner with the exact guidance needed; because no user is present, asking only in chat is insufficient.",
      "3. If more knowledge may still arrive from outside the team and no owner input is needed, reply that you are waiting — the daily heartbeat keeps watch.",
      "4. If the objective is met or no agent can productively contribute further, call stopHeartbeat to conclude the project and summarize the outcome.",
    );
  }

  lines.push("", "Finish with a brief report of your decision and reasoning.");
  return lines.join("\n");
}

export type ContributionRoundResult = {
  ok: boolean;
  reason?: string;
  newFindingCount: number;
  watermarkAdvancedTo: string | null;
  round: {
    agentId: string;
    name: string;
    started: boolean;
    runId?: string;
    reason?: string;
  }[];
};

/**
 * The Team Lead's "sufficient — who wants to contribute?" action. In one
 * move:
 *
 * 1. Advances the knowledge watermark to the max fact timestamp reviewed
 *    (this is the lead's sufficiency decision becoming durable), and
 * 2. Starts every non-working agent (or the given subset) with a triage
 *    brief listing the new facts: each agent first assesses whether it has
 *    a genuine angle and may decline by finishing immediately.
 *
 * The watermark advances BEFORE the agents start, so the facts their runs
 * produce land after it and count toward the NEXT round.
 */
export async function startContributionRound(args: {
  projectId: string;
  enqueue: EnqueueRootRun;
  /** Restrict the round to these agents (default: every non-working agent). */
  agentIds?: string[];
  /** Optional lead guidance appended to every agent's triage brief. */
  focus?: string;
}): Promise<ContributionRoundResult> {
  const { projectId, enqueue, agentIds, focus } = args;

  const projectRow = await db.query.project.findFirst({
    where: eq(project.id, projectId),
    columns: { id: true, status: true, knowledgeWatermarkAt: true },
  });
  if (!projectRow) {
    return {
      ok: false,
      reason: "Project not found.",
      newFindingCount: 0,
      watermarkAdvancedTo: null,
      round: [],
    };
  }
  if (projectRow.status !== "active") {
    return {
      ok: false,
      reason: `Project is ${projectRow.status}.`,
      newFindingCount: 0,
      watermarkAdvancedTo: null,
      round: [],
    };
  }

  const sinceMs = projectRow.knowledgeWatermarkAt?.getTime() ?? 0;
  const [summary, items] = await Promise.all([
    summarizeNewKnowledge(projectId, sinceMs),
    listNewKnowledge(projectId, sinceMs),
  ]);

  // Durable sufficiency decision: everything reviewed is now behind the
  // watermark. Guarded — only ever moves forward.
  let watermarkAdvancedTo: string | null = null;
  if (summary.maxCreatedAtMs !== null) {
    await advanceKnowledgeWatermark(projectId, summary.maxCreatedAtMs);
    watermarkAdvancedTo = new Date(summary.maxCreatedAtMs).toISOString();
  }

  const roster = await listProjectAgents(projectId);
  let candidates = roster.filter((a) => a.state !== "working");
  if (agentIds && agentIds.length > 0) {
    const wanted = new Set(agentIds);
    candidates = candidates.filter((a) => wanted.has(a.agentId));
  }

  const brief = buildTriageBrief(items, summary, focus);
  const round: ContributionRoundResult["round"] = [];
  for (const candidate of candidates) {
    const result = await startProjectAgent({
      projectId,
      agentId: candidate.agentId,
      enqueue,
      extraInstructions: brief,
    });
    round.push({
      agentId: candidate.agentId,
      name: candidate.displayName,
      started: result.ok,
      ...(result.ok ? { runId: result.runId } : { reason: result.reason }),
    });
  }

  return {
    ok: true,
    newFindingCount: summary.total,
    watermarkAdvancedTo,
    round,
  };
}

/** The per-agent brief for a contribution round: new findings + permission to decline. */
function buildTriageBrief(
  items: NewKnowledgeItem[],
  summary: NewKnowledgeSummary,
  focus?: string,
): string {
  const lines: string[] = [
    "## Research loop — contribution round",
    "",
    "The Team Lead judged that enough new knowledge has accumulated for the team to take another look. Observations and hypotheses added to the project's knowledge graph since the last round:",
    "",
  ];

  for (const item of items) {
    const label = item.kind === "hypothesis" ? "Hypothesis" : "Observation";
    const qualifiers: string[] = [];
    if (item.kind === "hypothesis" && item.status && item.status !== "proposed") {
      qualifiers.push(item.status.toUpperCase());
    }
    if (item.confidence) qualifiers.push(`confidence ${item.confidence}`);
    const suffix = qualifiers.length > 0 ? ` (${qualifiers.join(", ")})` : "";
    const prediction =
      item.kind === "hypothesis" && item.testablePrediction
        ? ` — predicts: ${item.testablePrediction}`
        : "";
    lines.push(
      `- ${label}: ${item.claim}${prediction}${suffix}${
        item.author ? ` [by ${item.author}]` : ""
      }`,
    );
  }
  if (summary.total > items.length) {
    lines.push(
      `- …and ${summary.total - items.length} more — explore the project's knowledge graph for the rest.`,
    );
  }

  lines.push(
    "",
    "FIRST assess whether this new knowledge gives you a genuine angle to contribute from your role's perspective — corroborating, contradicting, extending, or filling a gap. Declining is a valid outcome: if you have nothing meaningful to add, say so plainly in a short final message and finish immediately, without spawning sub-agents. If you do see an angle, state it, then plan and execute the research and write your findings to the knowledge graph.",
  );

  if (focus) {
    lines.push("", `Team Lead's guidance for this round: ${focus}`);
  }

  return lines.join("\n");
}
