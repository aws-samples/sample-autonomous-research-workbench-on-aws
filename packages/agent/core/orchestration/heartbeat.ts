import {
  and,
  db,
  eq,
  inArray,
  isNull,
  project,
  task,
  taskMessage,
} from "@repo/database";
import { run } from "@repo/database";
import {
  ACTIVE_RUN_STATUSES,
  createRootRun,
  finishRun,
} from "./store";
import { TEAM_LEAD_AGENT_TYPE, type EnqueueRootRun } from "./project-agents";
import { checkProjectBudget } from "./usage";
import type { TaskSpec } from "./types";

/**
 * Project heartbeat: the scheduled Team Lead pulse check.
 *
 * An EventBridge Scheduler schedule (created at project activation, config
 * lives on the schedule itself) fires daily and lands here as a
 * `{ kind: "heartbeat", projectId }` invocation. The heartbeat starts one
 * Team Lead turn that reviews the roster and decides — entirely at the
 * lead's discretion — whether any agent should contribute further research,
 * and whether the project has concluded (in which case the lead stops the
 * schedule via its stop-heartbeat tool).
 *
 * The AWS side (deleting the schedule) is injected, keeping this package
 * free of AWS SDK dependencies — same pattern as run enqueueing.
 */

/**
 * The automated message the daily scheduled heartbeat posts to the Team Lead
 * thread. The fallback sweep of the research loop: knowledge/quiescence
 * pulses (knowledge.ts) react to agents finishing, this catches everything
 * else (knowledge trickling in below the lead's sufficiency bar, missed
 * pulses, stuck agents).
 */
const HEARTBEAT_MESSAGE = [
  "[Scheduled heartbeat] This is the project's automated daily pulse — no user is present. Do a pulse check of the team:",
  "",
  "1. Review each agent's status and latest results (listProjectAgents, getAgentProgress where useful).",
  "2. Review the knowledge added since your last sufficiency decision (getNewKnowledge) and judge it against the project's sufficiency criteria. If it is sufficient for the team to react to, call startContributionRound — it advances the knowledge watermark and offers each idle agent the new knowledge so they decide for themselves whether to contribute or pass.",
  "3. Contributing is optional. If the accumulated knowledge is not yet sufficient and no owner input is needed, start nothing and say you're waiting for more.",
  "4. If progress is blocked on missing context or a decision only the owner can provide, call pauseForGuidance. It pauses the project, stops in-flight work, and emails the owner; asking only in chat is insufficient because no user is present.",
  "5. If you judge the project has reached a conclusion — objective met, hypothesis resolved, or no further productive work — call stopHeartbeat to conclude the project and end all automated pulses. Then call emailProjectOwner to notify the owner of the conclusion. Summarize why.",
  "",
  "Finish with a brief pulse-check report.",
].join("\n");

export type HeartbeatResult =
  | { started: true; runId: string }
  | { started: false; reason: string };

/**
 * Execute one heartbeat delivery: post the pulse-check message to the
 * project's Team Lead thread and enqueue the lead turn. Mirrors the API's
 * sendLeadMessage flow (lazy thread creation, one-turn-at-a-time guard,
 * enqueue compensation), minus the authenticated user.
 *
 * Skips (without error) when the project is gone, not active, or its
 * heartbeat was stopped — schedule deletions are asynchronous, so a stale
 * delivery after the Team Lead concluded the project is expected.
 */
export async function runProjectHeartbeat(
  projectId: string,
  enqueue: EnqueueRootRun,
): Promise<HeartbeatResult> {
  const projectRow = await db.query.project.findFirst({
    where: eq(project.id, projectId),
    columns: { id: true, status: true, heartbeatScheduleArn: true },
  });
  if (!projectRow) {
    return { started: false, reason: "Project not found." };
  }
  if (projectRow.status !== "active") {
    return { started: false, reason: `Project is ${projectRow.status}.` };
  }
  if (!projectRow.heartbeatScheduleArn) {
    // Never provisioned in this environment (a stopped heartbeat keeps its
    // ARN — the schedule is just DISABLED and won't fire).
    return { started: false, reason: "No heartbeat schedule provisioned." };
  }

  return startLeadPulse({
    projectId,
    enqueue,
    message: HEARTBEAT_MESSAGE,
    title: "Team lead heartbeat pulse check",
    metadata: { heartbeat: true, pulse: "scheduled" },
  });
}

/**
 * Start one automated Team Lead turn: post `message` to the project's lead
 * thread and enqueue the lead run. The shared machinery behind the scheduled
 * heartbeat AND the research loop's knowledge/quiescence pulses (see
 * knowledge.ts) — lazy thread creation, one-turn-at-a-time guard, and
 * enqueue compensation all live here.
 *
 * The busy-lead guard doubles as the loop's collapse valve: N persona runs
 * finishing simultaneously all attempt a pulse, exactly one wins, the rest
 * skip — and a skipped pulse is retried by the next run terminal or the
 * daily heartbeat, so no signal is lost.
 */
export async function startLeadPulse(args: {
  projectId: string;
  enqueue: EnqueueRootRun;
  /** The automated message posted to the lead thread as the turn's input. */
  message: string;
  /** Run row title, e.g. "Team lead knowledge pulse". */
  title: string;
  /**
   * taskMessage metadata; include `heartbeat: true` so the chat UI styles
   * the message as automated, plus a `pulse` kind for finer styling.
   */
  metadata: Record<string, unknown>;
}): Promise<HeartbeatResult> {
  const { projectId, enqueue, message, title, metadata } = args;
  const projectRow = await db.query.project.findFirst({
    where: eq(project.id, projectId),
  });
  if (!projectRow) {
    return { started: false, reason: "Project not found." };
  }
  if (projectRow.status !== "active") {
    return { started: false, reason: `Project is ${projectRow.status}.` };
  }

  // Budget gate: automated pulses pause on an over-budget project — a lead
  // turn costs money and couldn't start anything anyway (starts are refused
  // too). The user still sees the budget alert in the UI and can chat with
  // the lead directly; raising the cap resumes pulses automatically because
  // this checks live spend, not just the stamp.
  const budget = await checkProjectBudget(projectId);
  if (budget.over) {
    return {
      started: false,
      reason:
        `Project budget exceeded ($${budget.spendUsd.toFixed(2)} of ` +
        `$${budget.capUsd}) — automated pulses paused until the budget is raised.`,
    };
  }

  // Lazily create the persistent lead thread, exactly like the first chat
  // message would. Guarded on `leadTaskId IS NULL` so a concurrent first
  // message and a heartbeat converge on one thread.
  let leadTaskId = projectRow.leadTaskId;
  if (leadTaskId) {
    const existing = await db.query.task.findFirst({
      where: eq(task.id, leadTaskId),
    });
    if (!existing || existing.deletedAt) leadTaskId = null;
  }
  if (!leadTaskId) {
    const [thread] = await db
      .insert(task)
      .values({
        title: `Team Lead — ${projectRow.name}`,
        agent: TEAM_LEAD_AGENT_TYPE,
        userId: projectRow.ownerId,
      })
      .returning();
    if (!thread) {
      return { started: false, reason: "Failed to create lead thread." };
    }
    const [claimed] = await db
      .update(project)
      .set({ leadTaskId: thread.id })
      .where(and(eq(project.id, projectId), isNull(project.leadTaskId)))
      .returning({ leadTaskId: project.leadTaskId });
    if (claimed) {
      leadTaskId = thread.id;
    } else {
      // Lost the creation race — use the winner's thread, drop ours.
      await db.delete(task).where(eq(task.id, thread.id));
      const current = await db.query.project.findFirst({
        where: eq(project.id, projectId),
        columns: { leadTaskId: true },
      });
      leadTaskId = current?.leadTaskId ?? null;
      if (!leadTaskId) {
        return { started: false, reason: "Failed to resolve lead thread." };
      }
    }
  }

  // One turn at a time (same guard as the chat route). A busy lead means
  // the pulse is redundant right now — skip it; tomorrow's fires again.
  const activeTurn = await db.query.run.findFirst({
    where: and(
      eq(run.taskId, leadTaskId),
      eq(run.agentType, TEAM_LEAD_AGENT_TYPE),
      inArray(run.status, ACTIVE_RUN_STATUSES),
    ),
    columns: { id: true },
  });
  if (activeTurn) {
    return {
      started: false,
      reason: "The Team Lead is mid-turn; skipping this pulse.",
    };
  }

  const spec: TaskSpec = {
    title,
    instructions: message,
  };

  const root = await createRootRun({
    agentType: TEAM_LEAD_AGENT_TYPE,
    input: spec,
    taskId: leadTaskId,
    projectId,
  });

  // Surface the pulse in the lead chat like a user message would be, marked
  // (via metadata) so the UI can style it as automated.
  await db.insert(taskMessage).values({
    role: "user",
    content: { type: "text", text: message },
    metadata: { runId: root.id, ...metadata },
    taskId: leadTaskId,
  });

  await db
    .update(task)
    .set({ status: "running" })
    .where(eq(task.id, leadTaskId));

  try {
    await enqueue(root.id);
  } catch (error) {
    // Compensate: nothing will ever pick this run up (the sweeper only
    // rescues claimed runs), so fail it and release the thread.
    await finishRun(root.id, {
      status: "failed",
      summary: "Failed to enqueue the lead pulse run.",
    });
    await db
      .update(task)
      .set({ status: "failed" })
      .where(eq(task.id, leadTaskId));
    throw error;
  }

  return { started: true, runId: root.id };
}

export type StopHeartbeatResult =
  | { stopped: true }
  | { stopped: false; reason: string };

/**
 * Stop the project's heartbeat: DISABLE the EventBridge Scheduler schedule
 * (injected AWS call) — the schedule is not deleted. Its config and the
 * project's ARN reference survive, so the schedule remains the source of
 * truth ("stopped" = State DISABLED) and the user can re-enable it from
 * project settings. Used by the Team Lead's stop-heartbeat tool when the
 * project reaches a conclusion.
 *
 * With `concludeProject` the project is also marked `completed` (guarded on
 * `active` so a concurrent archive/pause isn't clobbered). That is what
 * actually ends the research loop: knowledge/quiescence pulses and the
 * scheduled heartbeat all refuse to start lead turns on non-active projects.
 * Concluding works even in environments without a provisioned schedule.
 */
export async function stopProjectHeartbeat(args: {
  projectId: string;
  /** Sets the schedule's State to DISABLED; already-deleted schedules are treated as stopped. */
  disableSchedule: (scheduleArn: string) => Promise<void>;
  /** Also mark the project `completed` — the research loop's conclusion. */
  concludeProject?: boolean;
}): Promise<StopHeartbeatResult> {
  const projectRow = await db.query.project.findFirst({
    where: eq(project.id, args.projectId),
    columns: { id: true, heartbeatScheduleArn: true },
  });
  if (!projectRow) {
    return { stopped: false, reason: "Project not found." };
  }
  if (projectRow.heartbeatScheduleArn) {
    await args.disableSchedule(projectRow.heartbeatScheduleArn);
  } else if (!args.concludeProject) {
    return {
      stopped: false,
      reason: "The project has no heartbeat schedule.",
    };
  }

  if (args.concludeProject) {
    await db
      .update(project)
      .set({ status: "completed" })
      .where(and(eq(project.id, args.projectId), eq(project.status, "active")));
  }

  return { stopped: true };
}

export type ReactivateProjectResult =
  | {
      reactivated: true;
      previousStatus: "paused" | "completed";
      heartbeatResumed: boolean;
    }
  | { reactivated: false; reason: string };

/**
 * Return a paused or completed project to `active` after an agent has been
 * successfully started. A paused project keeps its existing heartbeat
 * configuration, so no Scheduler update is needed. A completed project had
 * its schedule disabled by stopProjectHeartbeat, so that path re-enables it.
 *
 * Drafts remain activation-only: activation provisions project resources and
 * must stay the only path out of `draft`.
 */
export async function reactivateProject(args: {
  projectId: string;
  /** Re-enables the schedule when reopening a completed project. */
  enableSchedule: (scheduleArn: string) => Promise<void>;
}): Promise<ReactivateProjectResult> {
  const current = await db.query.project.findFirst({
    where: eq(project.id, args.projectId),
    columns: { status: true, heartbeatScheduleArn: true },
  });
  if (!current) {
    return { reactivated: false, reason: "Project not found." };
  }
  if (current.status !== "paused" && current.status !== "completed") {
    return {
      reactivated: false,
      reason: `Project is ${current.status}; it does not need reactivation.`,
    };
  }

  const previousStatus = current.status;
  const [flipped] = await db
    .update(project)
    .set({ status: "active" })
    .where(
      and(
        eq(project.id, args.projectId),
        eq(project.status, previousStatus),
      ),
    )
    .returning({ id: project.id });
  if (!flipped) {
    return {
      reactivated: false,
      reason: "Project status changed concurrently; no reactivation was needed.",
    };
  }

  // Pausing never changes the schedule, so status=active is sufficient to
  // resume its deliveries. Completion disables the schedule and must undo it.
  if (previousStatus === "completed" && current.heartbeatScheduleArn) {
    try {
      await args.enableSchedule(current.heartbeatScheduleArn);
      return { reactivated: true, previousStatus, heartbeatResumed: true };
    } catch (error) {
      console.error(
        `[heartbeat] failed to re-enable heartbeat schedule for project ${args.projectId}:`,
        error,
      );
    }
  }

  return { reactivated: true, previousStatus, heartbeatResumed: false };
}
