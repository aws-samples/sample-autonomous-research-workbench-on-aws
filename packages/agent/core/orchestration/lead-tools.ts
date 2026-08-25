import { and, db, eq, project } from "@repo/database";
import { tool } from "ai";
import { z } from "zod";
import { reactivateProject, stopProjectHeartbeat } from "./heartbeat";
import { sendOwnerEmail } from "./owner-email";
import {
  listNewKnowledge,
  startContributionRound,
  summarizeNewKnowledge,
} from "./knowledge";
import {
  getAgentProgress,
  listProjectAgents,
  startProjectAgent,
  stopProjectAgent,
  type EnqueueRootRun,
} from "./project-agents";
import type { OrchestrationToolSet } from "./types";

/**
 * Tool group for the Team Lead agent: supervise a project's persona agents.
 * Thin wrappers around the shared project-agent operations, bound to one
 * project so the LLM can never reach across projects.
 */

export type LeadToolContext = {
  projectId: string;
  /** Enqueue a root orchestrator run (caller injects the dispatch layer). */
  enqueue: EnqueueRootRun;
  /**
   * Disable the project's heartbeat schedule (caller injects the EventBridge
   * Scheduler layer). The schedule is disabled, never deleted — the user can
   * re-enable it from settings. When absent, the stopHeartbeat tool reports
   * that stopping is unavailable in this environment.
   */
  disableHeartbeatSchedule?: (scheduleArn: string) => Promise<void>;
  /**
   * Re-enable the project's heartbeat schedule (the mirror of
   * disableHeartbeatSchedule). Used when starting an agent on a completed
   * project reactivates it. Paused projects keep their schedule state. When
   * absent, completion reactivation still flips the project back to active —
   * only the daily pulse stays off.
   */
  enableHeartbeatSchedule?: (scheduleArn: string) => Promise<void>;
};

export function createLeadTools(context: LeadToolContext): OrchestrationToolSet {
  const {
    projectId,
    enqueue,
    disableHeartbeatSchedule,
    enableHeartbeatSchedule,
  } = context;

  const listProjectAgentsTool = tool({
    description:
      "List this project's agents with their live status (idle | working | blocked), current run, and the summary of their last completed work. Call this before starting/stopping agents or reporting status.",
    inputSchema: z.object({}),
    execute: async () => {
      const agents = await listProjectAgents(projectId);
      return {
        agents: agents.map((a) => ({
          agentId: a.agentId,
          name: a.displayName,
          role: a.description,
          state: a.state,
          activeRunId: a.activeRunId,
          activeRunStatus: a.activeRunStatus,
          lastResultStatus: a.lastResult?.status ?? null,
          lastResultSummary: a.lastResult?.summary ?? null,
          stateUpdatedAt: a.stateUpdatedAt?.toISOString() ?? null,
        })),
      };
    },
  });

  const startProjectAgentTool = tool({
    description:
      "Start a project agent. It is auto-briefed from the project's seed hypothesis and its persona; optionally add extra instructions to focus this run. Fails if the agent is already working. Starting an agent on a paused or completed project reactivates it; completed projects also resume the daily heartbeat that conclusion disabled.",
    inputSchema: z.object({
      agentId: z.string().uuid().describe("The agentId from list_project_agents."),
      extraInstructions: z
        .string()
        .optional()
        .describe(
          "Optional focus for this run (e.g. a specific sub-question or constraint), appended to the auto-brief.",
        ),
    }),
    execute: async ({ agentId, extraInstructions }) => {
      const result = await startProjectAgent({
        projectId,
        agentId,
        enqueue,
        extraInstructions,
      });
      if (!result.ok) return { started: false, reason: result.reason };

      // Starting work on a paused or completed project restarts the research
      // loop. Only completion disabled the schedule; reactivateProject keeps
      // paused projects' existing heartbeat configuration unchanged.
      const revival = await reactivateProject({
        projectId,
        enableSchedule: enableHeartbeatSchedule ?? (async () => {}),
      });
      return {
        started: true,
        runId: result.runId,
        ...(revival.reactivated && {
          projectReactivated: true,
          previousProjectStatus: revival.previousStatus,
          heartbeatResumed: revival.heartbeatResumed,
        }),
      };
    },
  });

  const stopProjectAgentTool = tool({
    description:
      "Stop a working project agent: cancels its run and all of its in-flight sub-agents. Cooperative — anything mid-step finishes that step first.",
    inputSchema: z.object({
      agentId: z.string().uuid().describe("The agentId from list_project_agents."),
    }),
    execute: async ({ agentId }) => {
      const result = await stopProjectAgent({ projectId, agentId });
      return result.ok
        ? { stopped: true, cancelledRuns: result.cancelledRuns }
        : { stopped: false, reason: result.reason };
    },
  });

  const getAgentProgressTool = tool({
    description:
      "Inspect an agent's current (or most recent) run: overall run status plus each plan task with its status and result summary. Use this to answer 'what is X doing / how far along is it?'.",
    inputSchema: z.object({
      agentId: z.string().uuid().describe("The agentId from list_project_agents."),
    }),
    execute: async ({ agentId }) => {
      return getAgentProgress({ projectId, agentId });
    },
  });

  const getNewKnowledgeTool = tool({
    description:
      "Read the knowledge added to the project's graph since your last sufficiency decision (the knowledge watermark): the new findings — observations and hypotheses (each with its claim, confidence, and for hypotheses its testable prediction and status) — who authored each, and per-agent counts. Use this on knowledge pulses and heartbeats to judge whether the accumulated knowledge is sufficient for the team to react to. Reading does NOT advance the watermark — only startContributionRound does.",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(60)
        .describe("Max findings to return (oldest first)."),
    }),
    execute: async ({ limit }) => {
      const projectRow = await db.query.project.findFirst({
        where: eq(project.id, projectId),
        columns: { knowledgeWatermarkAt: true },
      });
      if (!projectRow) return { error: "Project not found." };
      const sinceMs = projectRow.knowledgeWatermarkAt?.getTime() ?? 0;
      const [summary, items] = await Promise.all([
        summarizeNewKnowledge(projectId, sinceMs),
        listNewKnowledge(projectId, sinceMs, limit),
      ]);
      return {
        watermark:
          projectRow.knowledgeWatermarkAt?.toISOString() ??
          "(never advanced — all agent findings are new)",
        newFindingCount: summary.total,
        byAuthor: summary.byAuthor,
        findings: items.map((f) => ({
          kind: f.kind,
          claim: f.claim,
          confidence: f.confidence,
          ...(f.kind === "hypothesis"
            ? { testablePrediction: f.testablePrediction, status: f.status }
            : { sourceTool: f.sourceTool }),
          author: f.author,
          createdAt: new Date(f.createdAtMs).toISOString(),
        })),
        truncated: summary.total > items.length,
      };
    },
  });

  const startContributionRoundTool = tool({
    description:
      "Your 'the accumulated knowledge is sufficient' action. In one move: advances the knowledge watermark past everything you just reviewed, then starts every idle agent (or a subset) with a triage brief listing the new findings — each agent decides for ITSELF whether to contribute another run or decline and finish immediately. Use this instead of startProjectAgent when acting on a knowledge/quiescence pulse, so the watermark advances with your decision. Do NOT call it when the knowledge is not yet sufficient. If no owner input is needed, wait; if work is blocked on owner input, call pauseForGuidance.",
    inputSchema: z.object({
      agentIds: z
        .array(z.string().uuid())
        .optional()
        .describe(
          "Restrict the round to these agentIds (from listProjectAgents). Default: every agent not currently working.",
        ),
      focus: z
        .string()
        .optional()
        .describe(
          "Optional guidance appended to every agent's triage brief, e.g. which new finding deserves scrutiny.",
        ),
    }),
    execute: async ({ agentIds, focus }) => {
      return startContributionRound({ projectId, enqueue, agentIds, focus });
    },
  });

  const stopHeartbeatTool = tool({
    description:
      "Conclude the project: marks it completed and stops ALL automated pulses (the scheduled daily heartbeat and the knowledge/quiescence pulses of the research loop). Use this ONLY when you judge the project has reached a conclusion: the objective is met, the hypothesis is resolved, or no further productive work remains. The schedule is disabled, not deleted — the user can re-enable it from project settings. Always explain your reasoning when concluding.",
    inputSchema: z.object({
      reason: z
        .string()
        .min(1)
        .describe(
          "Why the project has concluded and the automated pulses should stop.",
        ),
    }),
    execute: async ({ reason }) => {
      const result = await stopProjectHeartbeat({
        projectId,
        // No scheduler in this environment (local dev) → nothing to disable,
        // but concluding (status = completed) must still work: it is what
        // actually ends the research loop's pulses.
        disableSchedule: disableHeartbeatSchedule ?? (async () => {}),
        concludeProject: true,
      });
      return result.stopped
        ? { stopped: true, projectCompleted: true, recordedReason: reason }
        : { stopped: false, reason: result.reason };
    },
  });

  const pauseForGuidanceTool = tool({
    description:
      "Pause the project because productive work cannot continue without owner input. This changes the project from active to paused, cancels every working project agent and its in-flight sub-agents, and emails the owner with the exact guidance needed. Use this instead of merely asking in chat: automated pulses have no user present. Do NOT use it for routine waiting, temporary knowledge insufficiency, or a concluded project.",
    inputSchema: z.object({
      reason: z
        .string()
        .min(1)
        .describe(
          "Why productive work is blocked and the project must pause, written for the owner.",
        ),
      guidanceNeeded: z
        .string()
        .min(1)
        .describe(
          "The specific question, missing context, or decision the owner must provide before work can resume.",
        ),
    }),
    execute: async ({ reason, guidanceNeeded }) => {
      // Guard the lifecycle transition so a stale lead turn cannot pause a
      // project that was completed or otherwise changed concurrently.
      const [paused] = await db
        .update(project)
        .set({ status: "paused" })
        .where(and(eq(project.id, projectId), eq(project.status, "active")))
        .returning({ id: project.id });
      if (!paused) {
        const current = await db.query.project.findFirst({
          where: eq(project.id, projectId),
          columns: { status: true },
        });
        return {
          paused: false,
          reason: current
            ? `Project is ${current.status}; only an active project can be paused.`
            : "Project not found.",
        };
      }

      // Paused means no project work should remain in flight. Project status
      // is flipped first so terminal callbacks from these cancellations see
      // a non-active project and cannot start another pulse.
      const agents = await listProjectAgents(projectId);
      const stops = await Promise.all(
        agents
          .filter((agent) => agent.state === "working" && agent.activeRunId)
          .map((agent) =>
            stopProjectAgent({ projectId, agentId: agent.agentId }),
          ),
      );
      const cancelledRuns = stops.reduce(
        (total, result) => total + (result.ok ? result.cancelledRuns : 0),
        0,
      );

      try {
        const email = await sendOwnerEmail({
          projectId,
          scenario: "pause_awaiting_guidance",
          reason,
          details: `Guidance needed: ${guidanceNeeded}`,
        });
        return email.sent
          ? {
              paused: true,
              cancelledRuns,
              emailSent: true,
              notifiedOwner: email.to,
            }
          : {
              paused: true,
              cancelledRuns,
              emailSent: false,
              emailFailure: email.reason,
            };
      } catch (error) {
        return {
          paused: true,
          cancelledRuns,
          emailSent: false,
          emailFailure: `Email failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });

  const emailProjectOwnerTool = tool({
    description:
      "Email the project owner after the project has been concluded with stopHeartbeat. This tool is completion-only; use pauseForGuidance when work is blocked pending owner input. The recipient, sender, and project link are resolved automatically. Do NOT use it for routine status.",
    inputSchema: z.object({
      reason: z
        .string()
        .min(1)
        .describe(
          "What the project concluded, written for the owner in plain and specific language.",
        ),
      details: z
        .string()
        .optional()
        .describe(
          "Optional supporting detail: key findings, evidence, or recommended next steps.",
        ),
    }),
    execute: async ({ reason, details }) => {
      const current = await db.query.project.findFirst({
        where: eq(project.id, projectId),
        columns: { status: true },
      });
      if (current?.status !== "completed") {
        return {
          sent: false,
          reason: current
            ? `Project is ${current.status}; completion email requires completed status.`
            : "Project not found.",
        };
      }

      try {
        return await sendOwnerEmail({
          projectId,
          scenario: "project_completed",
          reason,
          details,
        });
      } catch (error) {
        return {
          sent: false,
          reason: `Email failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });

  return {
    listProjectAgents: listProjectAgentsTool,
    startProjectAgent: startProjectAgentTool,
    stopProjectAgent: stopProjectAgentTool,
    getAgentProgress: getAgentProgressTool,
    getNewKnowledge: getNewKnowledgeTool,
    startContributionRound: startContributionRoundTool,
    pauseForGuidance: pauseForGuidanceTool,
    stopHeartbeat: stopHeartbeatTool,
    emailProjectOwner: emailProjectOwnerTool,
  };
}
