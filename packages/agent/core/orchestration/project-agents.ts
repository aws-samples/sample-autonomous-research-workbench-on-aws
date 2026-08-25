import {
  and,
  db,
  eq,
  isNull,
  project,
  projectAgent,
  run,
} from "@repo/database";
import {
  cancelRun,
  cancelRunTree,
  createRootRun,
  getPlanTasks,
} from "./store";
import { checkProjectBudget } from "./usage";
import type { AgentResult, TaskSpec } from "./types";

/**
 * Shared project-agent operations: start/stop/list a project's persona
 * orchestrators. Used by both the Team Lead agent's tools and the oRPC
 * routes so the UI buttons and the lead chat behave identically.
 *
 * Enqueueing is injected (the worker and API own the queue dependency);
 * everything durable happens here against Postgres.
 */

export type EnqueueRootRun = (runId: string) => Promise<void>;

/** Registry key stored on team-lead run rows (routed to the lead processor). */
export const TEAM_LEAD_AGENT_TYPE = "team-lead";

export type ProjectAgentSummary = {
  projectAgentId: string;
  agentId: string;
  agentType: string;
  displayName: string;
  description: string | null;
  state: "idle" | "working" | "blocked";
  activeRunId: string | null;
  activeRunStatus: string | null;
  lastResult: AgentResult | null;
  stateUpdatedAt: Date | null;
};

/** All persona agents on a project with live state + last outcome. */
export async function listProjectAgents(
  projectId: string,
): Promise<ProjectAgentSummary[]> {
  const rows = await db.query.projectAgent.findMany({
    where: eq(projectAgent.projectId, projectId),
    with: { agent: true, activeRun: true },
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });

  return rows.map((r) => ({
    projectAgentId: r.id,
    agentId: r.agentId,
    agentType: r.agent.id,
    displayName: r.agent.displayName,
    description: r.agent.description,
    state: r.state,
    activeRunId: r.activeRunId,
    activeRunStatus: r.activeRun?.status ?? null,
    lastResult: (r.lastResult as AgentResult | null) ?? null,
    stateUpdatedAt: r.stateUpdatedAt,
  }));
}

/**
 * Compose the auto-brief for a persona's root orchestrator run from the
 * project's seed hypothesis and the persona's own system prompt/description.
 */
export function buildAgentBrief(args: {
  projectName: string;
  seedHypothesis: string;
  /** The project's enforced agent-spend cap in USD (always set). */
  maxBudgetUsd: number;
  checkInCadence?: string | null;
  agentDisplayName: string;
  agentDescription?: string | null;
  agentSystemPrompt?: string | null;
  extraInstructions?: string;
}): TaskSpec {
  const constraints: string[] = [
    `Budget: $${args.maxBudgetUsd} USD hard cap on the project's total agent spend (platform-enforced — agents stop when spend reaches it).`,
  ];
  if (args.checkInCadence) {
    constraints.push(`Check-in cadence: ${args.checkInCadence}.`);
  }

  const instructions = [
    `You are working as "${args.agentDisplayName}" on the research project "${args.projectName}".`,
    args.agentDescription ? `Your role: ${args.agentDescription}` : null,
    "",
    "## Project seed hypothesis",
    args.seedHypothesis,
    "",
    "## Your assignment",
    `Investigate the seed hypothesis from your role's perspective. Plan the work, delegate self-contained research tasks to sub-agents where useful, and integrate their findings into a final report with a clear bottom line: evidence for/against the hypothesis, key uncertainties, and recommended next steps.`,
    "",
    "Findings must also be persisted to the project's shared knowledge graph — the team's research loop reacts only to what is recorded there, not to report text. Your sub-agents carry the knowledge-graph tools: the epistemic tools (epistemicRecordObservation, epistemicProposeHypothesis, epistemicLinkEvidence) capture their reasoning and are what the research loop advances on, and graphAddFact records the concrete subject–predicate–object facts that reasoning cites (append-only — facts cannot be edited or deleted). The project's seed hypothesis is the root :Hypothesis node in the graph (find it with epistemicListHypotheses). Every brief you hand them must instruct them to record observations for their key findings, write the supporting facts, and use epistemicLinkEvidence to connect observations to the seed hypothesis (or a more specific hypothesis) where they support or contradict it.",
    args.extraInstructions ? `\n${args.extraInstructions}` : null,
    constraints.length > 0 ? `\n## Constraints\n${constraints.join("\n")}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const spec: TaskSpec = {
    title: `${args.agentDisplayName} — ${args.projectName}`,
    instructions,
  };
  if (args.agentSystemPrompt) {
    spec.context = `Persona guidance (how you operate):\n${args.agentSystemPrompt}`;
  }
  return spec;
}

export type StartProjectAgentResult =
  | { ok: true; runId: string }
  | { ok: false; reason: string };

/**
 * Start a persona agent: guard against double-starts, create the root
 * orchestrator run (agentType = persona so descendants inherit it via the
 * registry), flip the roster flag, and enqueue.
 */
export async function startProjectAgent(args: {
  projectId: string;
  agentId: string;
  enqueue: EnqueueRootRun;
  extraInstructions?: string;
}): Promise<StartProjectAgentResult> {
  const [projectRow, pa] = await Promise.all([
    db.query.project.findFirst({ where: eq(project.id, args.projectId) }),
    db.query.projectAgent.findFirst({
      where: and(
        eq(projectAgent.projectId, args.projectId),
        eq(projectAgent.agentId, args.agentId),
      ),
      with: { agent: true },
    }),
  ]);

  if (!projectRow) return { ok: false, reason: "Project not found." };
  if (!pa) return { ok: false, reason: "Agent is not part of this project." };
  if (pa.state === "working" && pa.activeRunId) {
    return {
      ok: false,
      reason: `${pa.agent.displayName} is already working (run ${pa.activeRunId}).`,
    };
  }

  // Budget gate: an over-budget project refuses every start (UI button, lead
  // tool, contribution round) until the cap is raised in settings. The
  // worker's segment checkpoints already stop anything mid-flight.
  const budget = await checkProjectBudget(args.projectId);
  if (budget.over) {
    return {
      ok: false,
      reason:
        `Project budget exceeded ($${budget.spendUsd.toFixed(2)} spent of the ` +
        `$${budget.capUsd} cap) — agents cannot run until the budget is raised in project settings.`,
    };
  }

  const brief = buildAgentBrief({
    projectName: projectRow.name,
    seedHypothesis: projectRow.seedHypothesis,
    maxBudgetUsd: projectRow.maxBudgetUsd,
    checkInCadence: projectRow.checkInCadence,
    agentDisplayName: pa.agent.displayName,
    agentDescription: pa.agent.description,
    agentSystemPrompt: pa.agent.systemPrompt,
    extraInstructions: args.extraInstructions,
  });

  const rootRun = await createRootRun({
    // The persona key is the agentType so the run tree is attributable in the
    // `projectRuns` Electric shape; roots are always processed as
    // orchestrators (routing is by queue + parentRunId, not agentType).
    agentType: pa.agent.id,
    input: brief,
    projectId: args.projectId,
  });

  // Guarded flip: only claim the roster slot if the row still looks exactly
  // like it did when we read it (state AND activeRunId), so a concurrent
  // start or stop loses cleanly instead of silently double-running.
  const activeRunGuard = pa.activeRunId
    ? eq(projectAgent.activeRunId, pa.activeRunId)
    : isNull(projectAgent.activeRunId);
  const [flipped] = await db
    .update(projectAgent)
    .set({
      state: "working",
      activeRunId: rootRun.id,
      stateUpdatedAt: new Date(),
    })
    .where(
      and(
        eq(projectAgent.id, pa.id),
        eq(projectAgent.state, pa.state),
        activeRunGuard,
      ),
    )
    .returning({ id: projectAgent.id });

  if (!flipped) {
    // Lost a concurrent start race — abandon our run row.
    await db.delete(run).where(eq(run.id, rootRun.id));
    return { ok: false, reason: "Agent was started concurrently; try again." };
  }

  try {
    await args.enqueue(rootRun.id);
  } catch (error) {
    // Compensate: an unenqueued `pending` run is invisible to the sweeper
    // (it only rescues claimed runs), so without this the roster would show
    // "working" forever with nothing executing.
    await cancelRun(rootRun.id);
    await db
      .update(projectAgent)
      .set({ state: pa.state, activeRunId: null, stateUpdatedAt: new Date() })
      .where(
        and(
          eq(projectAgent.id, pa.id),
          eq(projectAgent.activeRunId, rootRun.id),
        ),
      );
    throw error;
  }
  return { ok: true, runId: rootRun.id };
}

export type StopProjectAgentResult =
  | { ok: true; cancelledRuns: number }
  | { ok: false; reason: string };

/**
 * Stop a persona agent: cancel its whole active run tree via guarded
 * transitions and put the roster flag back to idle.
 */
export async function stopProjectAgent(args: {
  projectId: string;
  agentId: string;
}): Promise<StopProjectAgentResult> {
  const pa = await db.query.projectAgent.findFirst({
    where: and(
      eq(projectAgent.projectId, args.projectId),
      eq(projectAgent.agentId, args.agentId),
    ),
  });
  if (!pa) return { ok: false, reason: "Agent is not part of this project." };
  if (!pa.activeRunId) {
    // Nothing running; still normalize a stale blocked/working flag. Guarded
    // on activeRunId so a start that flipped the row since our read wins.
    await db
      .update(projectAgent)
      .set({ state: "idle", stateUpdatedAt: new Date() })
      .where(and(eq(projectAgent.id, pa.id), isNull(projectAgent.activeRunId)));
    return { ok: true, cancelledRuns: 0 };
  }

  const cancelled = await cancelRunTree(pa.activeRunId);

  // If nothing was cancelled the run already reached terminal on its own —
  // preserve its real result instead of stamping the cancelled stub over it.
  let lastResult: AgentResult = {
    status: "cancelled",
    summary: "Stopped by user/team lead.",
  };
  if (cancelled === 0) {
    const finished = await db.query.run.findFirst({
      where: eq(run.id, pa.activeRunId),
      columns: { result: true },
    });
    lastResult = (finished?.result as AgentResult | null) ?? lastResult;
  }

  // Guarded on the run we actually cancelled: a concurrent start that
  // already claimed the slot with a new run must not be clobbered to idle.
  await db
    .update(projectAgent)
    .set({
      state: "idle",
      activeRunId: null,
      lastResult,
      stateUpdatedAt: new Date(),
    })
    .where(
      and(
        eq(projectAgent.id, pa.id),
        eq(projectAgent.activeRunId, pa.activeRunId),
      ),
    );

  return { ok: true, cancelledRuns: cancelled };
}

export type AgentProgress = {
  runId: string;
  runStatus: string;
  planTasks: {
    seq: number;
    title: string;
    status: string;
    summary: string | null;
  }[];
};

/** Plan-task progress of an agent's most relevant (active or last) root run. */
export async function getAgentProgress(args: {
  projectId: string;
  agentId: string;
}): Promise<AgentProgress | { error: string }> {
  const pa = await db.query.projectAgent.findFirst({
    where: and(
      eq(projectAgent.projectId, args.projectId),
      eq(projectAgent.agentId, args.agentId),
    ),
    with: { agent: true },
  });
  if (!pa) return { error: "Agent is not part of this project." };

  const rootRun = pa.activeRunId
    ? await db.query.run.findFirst({ where: eq(run.id, pa.activeRunId) })
    : // Fall back to the persona's most recent root run on this project.
      await db.query.run.findFirst({
        where: and(
          eq(run.projectId, args.projectId),
          eq(run.agentType, pa.agent.id),
          isNull(run.parentRunId),
        ),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });
  if (!rootRun) return { error: "This agent has not been started yet." };

  const tasks = await getPlanTasks(rootRun.id);
  return {
    runId: rootRun.id,
    runStatus: rootRun.status,
    planTasks: tasks.map((t) => ({
      seq: t.seq,
      title: t.title,
      status: t.status,
      summary: (t.result as AgentResult | null)?.summary ?? null,
    })),
  };
}
