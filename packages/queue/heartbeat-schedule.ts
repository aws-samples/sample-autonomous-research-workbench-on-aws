/**
 * Project heartbeat schedules (EventBridge Scheduler).
 *
 * Each activated project gets one schedule (name `project-heartbeat-<id>`)
 * that fires daily and triggers the Team Lead's pulse check of the project's
 * agents. THE SCHEDULE IS THE SOURCE OF TRUTH for the heartbeat config —
 * time of day, timezone, and enabled state all live on the Scheduler
 * resource; the project row only stores the schedule's ARN. Reads go through
 * GetSchedule and changes through UpdateSchedule, so there is no config to
 * keep in sync in Postgres.
 *
 * Creation needs the target Lambda, the scheduler execution role, and the
 * schedule group, published by the infra stack as env vars
 * (HEARTBEAT_TARGET_ARN, HEARTBEAT_SCHEDULER_ROLE_ARN,
 * HEARTBEAT_SCHEDULE_GROUP). When unset (local dev, envs without the
 * scheduler stack) creation is a no-op and the project keeps a null ARN —
 * mirroring the per-project AgentCore runtime provisioning. Get/update/
 * delete derive group and name from the ARN, so the worker (the Team Lead's
 * stop tool) needs no scheduler env at all.
 */
import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
  type GetScheduleCommandOutput,
} from "@aws-sdk/client-scheduler";

const NAME_PREFIX = "project-heartbeat-";

/** Default heartbeat: 9am daily. */
export const DEFAULT_HEARTBEAT_TIME = "09:00";
export const DEFAULT_HEARTBEAT_TIMEZONE = "UTC";

let cachedClient: SchedulerClient | null = null;
function getClient(): SchedulerClient {
  cachedClient ??= new SchedulerClient({
    customUserAgent: process.env.USER_AGENT_STRING,
  });
  return cachedClient;
}

interface HeartbeatScheduleConfig {
  targetArn: string;
  roleArn: string;
  groupName: string;
}

/**
 * Creation config from the environment, or null when this environment has no
 * heartbeat provisioning (local dev / stacks without the scheduler wiring).
 */
function getCreationConfig(): HeartbeatScheduleConfig | null {
  const targetArn = process.env.HEARTBEAT_TARGET_ARN;
  const roleArn = process.env.HEARTBEAT_SCHEDULER_ROLE_ARN;
  const groupName = process.env.HEARTBEAT_SCHEDULE_GROUP;
  if (!targetArn || !roleArn || !groupName) {
    console.warn(
      "[heartbeat-schedule] HEARTBEAT_TARGET_ARN / HEARTBEAT_SCHEDULER_ROLE_ARN / HEARTBEAT_SCHEDULE_GROUP not set — skipping heartbeat schedule creation",
    );
    return null;
  }
  return { targetArn, roleArn, groupName };
}

function scheduleName(projectId: string): string {
  return `${NAME_PREFIX}${projectId}`;
}

/** arn:aws:scheduler:<region>:<account>:schedule/<group>/<name> */
function parseScheduleArn(
  scheduleArn: string,
): { groupName: string; name: string } {
  const match = scheduleArn.match(/:schedule\/([^/]+)\/([^/]+)$/);
  if (!match) {
    throw new Error(`Cannot parse schedule ARN: ${scheduleArn}`);
  }
  return { groupName: match[1]!, name: match[2]! };
}

/** "HH:MM" (24h) → `cron(M H * * ? *)` — fires once a day. */
function dailyCron(time: string): string {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid heartbeat time (want "HH:MM"): ${time}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`Invalid heartbeat time (want "HH:MM"): ${time}`);
  }
  return `cron(${minutes} ${hours} * * ? *)`;
}

/** `cron(M H * * ? *)` → "HH:MM", or null for non-daily expressions. */
function timeFromCron(expression: string | undefined): string | null {
  const match = expression?.match(
    /^cron\((\d{1,2}) (\d{1,2}) \* \* \? \*\)$/,
  );
  if (!match) return null;
  return `${match[2]!.padStart(2, "0")}:${match[1]!.padStart(2, "0")}`;
}

/** The heartbeat config as read from the Scheduler (the source of truth). */
export type ProjectHeartbeat = {
  scheduleArn: string;
  /** "HH:MM" (24h) in `timezone`; null if the expression is not a simple daily cron. */
  time: string | null;
  timezone: string;
  enabled: boolean;
  scheduleExpression: string;
};

function toHeartbeat(
  scheduleArn: string,
  schedule: GetScheduleCommandOutput,
): ProjectHeartbeat {
  return {
    scheduleArn,
    time: timeFromCron(schedule.ScheduleExpression),
    timezone:
      schedule.ScheduleExpressionTimezone ?? DEFAULT_HEARTBEAT_TIMEZONE,
    enabled: schedule.State === "ENABLED",
    scheduleExpression: schedule.ScheduleExpression ?? "",
  };
}

/**
 * Create the project's heartbeat schedule and return its ARN, or null when
 * scheduler provisioning is not configured in this environment. Defaults to
 * 9am daily. The schedule name embeds the project id, so a retried
 * activation hits ConflictException and resolves to the existing schedule.
 */
export async function createProjectHeartbeatSchedule(
  projectId: string,
  options?: { time?: string; timezone?: string },
): Promise<string | null> {
  const config = getCreationConfig();
  if (!config) return null;

  const name = scheduleName(projectId);
  const input = {
    Name: name,
    GroupName: config.groupName,
    Description: `ResearchWorkbench project heartbeat (project ${projectId}): daily Team Lead pulse check`,
    ScheduleExpression: dailyCron(options?.time ?? DEFAULT_HEARTBEAT_TIME),
    ScheduleExpressionTimezone:
      options?.timezone ?? DEFAULT_HEARTBEAT_TIMEZONE,
    // The pulse is a daily nudge, not a precise alarm — a small window lets
    // the Scheduler spread invocations.
    FlexibleTimeWindow: {
      Mode: "FLEXIBLE" as const,
      MaximumWindowInMinutes: 15,
    },
    Target: {
      Arn: config.targetArn,
      RoleArn: config.roleArn,
      Input: JSON.stringify({ projectId }),
      RetryPolicy: {
        MaximumRetryAttempts: 3,
        MaximumEventAgeInSeconds: 3600,
      },
    },
    State: "ENABLED" as const,
  };

  try {
    const res = await getClient().send(
      new CreateScheduleCommand({ ...input, ClientToken: projectId }),
    );
    if (!res.ScheduleArn) {
      throw new Error("CreateSchedule returned no ScheduleArn");
    }
    return res.ScheduleArn;
  } catch (error) {
    // A previous activation created the schedule but the ARN never reached
    // the project row: recover by reading the existing schedule.
    if (error instanceof ConflictException) {
      const existing = await getClient().send(
        new GetScheduleCommand({ Name: name, GroupName: config.groupName }),
      );
      if (existing.Arn) return existing.Arn;
    }
    throw error;
  }
}

/** Read the heartbeat config off the schedule (the source of truth). */
export async function getProjectHeartbeat(
  scheduleArn: string,
): Promise<ProjectHeartbeat | null> {
  const { groupName, name } = parseScheduleArn(scheduleArn);
  try {
    const schedule = await getClient().send(
      new GetScheduleCommand({ Name: name, GroupName: groupName }),
    );
    return toHeartbeat(scheduleArn, schedule);
  } catch (error) {
    // The schedule is gone (deleted out of band) — callers treat a null as
    // "no heartbeat" and should clear the stale ARN.
    if (error instanceof ResourceNotFoundException) return null;
    throw error;
  }
}

/**
 * Change the heartbeat's time / timezone / enabled state. UpdateSchedule
 * replaces the whole resource, so unchanged fields (target, retry policy,
 * flexible window) are carried over from the current schedule.
 */
export async function updateProjectHeartbeat(
  scheduleArn: string,
  changes: { time?: string; timezone?: string; enabled?: boolean },
): Promise<ProjectHeartbeat> {
  const { groupName, name } = parseScheduleArn(scheduleArn);
  const current = await getClient().send(
    new GetScheduleCommand({ Name: name, GroupName: groupName }),
  );

  const scheduleExpression =
    changes.time !== undefined
      ? dailyCron(changes.time)
      : current.ScheduleExpression;
  const timezone =
    changes.timezone ??
    current.ScheduleExpressionTimezone ??
    DEFAULT_HEARTBEAT_TIMEZONE;
  const state =
    changes.enabled === undefined
      ? current.State
      : changes.enabled
        ? "ENABLED"
        : "DISABLED";

  await getClient().send(
    new UpdateScheduleCommand({
      Name: name,
      GroupName: groupName,
      Description: current.Description,
      ScheduleExpression: scheduleExpression,
      ScheduleExpressionTimezone: timezone,
      FlexibleTimeWindow: current.FlexibleTimeWindow,
      Target: current.Target,
      State: state,
    }),
  );

  const updated = await getClient().send(
    new GetScheduleCommand({ Name: name, GroupName: groupName }),
  );
  return toHeartbeat(scheduleArn, updated);
}

/**
 * Disable a project's heartbeat schedule (State = DISABLED) without deleting
 * it. Used by the Team Lead's stop-heartbeat tool when the project reaches a
 * conclusion — the schedule (and its config) survives, so the user can
 * re-enable it from settings. An already-deleted schedule is treated as
 * stopped.
 */
export async function disableProjectHeartbeatSchedule(
  scheduleArn: string,
): Promise<void> {
  try {
    await updateProjectHeartbeat(scheduleArn, { enabled: false });
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return;
    throw error;
  }
}

/**
 * Re-enable a project's heartbeat schedule (State = ENABLED). The mirror of
 * disableProjectHeartbeatSchedule: used when a concluded project is
 * reactivated (an agent is started again), so the daily pulse resumes
 * alongside the research loop. A deleted schedule is a no-op — the project
 * simply has no daily pulse until one is re-provisioned.
 */
export async function enableProjectHeartbeatSchedule(
  scheduleArn: string,
): Promise<void> {
  try {
    await updateProjectHeartbeat(scheduleArn, { enabled: true });
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return;
    throw error;
  }
}

/**
 * Best-effort deletion of a project's heartbeat schedule. Already-deleted
 * schedules are treated as success. Only used when the project itself is
 * deleted — the Team Lead's stop disables instead.
 */
export async function deleteProjectHeartbeatSchedule(
  scheduleArn: string,
): Promise<void> {
  try {
    const { groupName, name } = parseScheduleArn(scheduleArn);
    await getClient().send(
      new DeleteScheduleCommand({
        Name: name,
        GroupName: groupName,
        ClientToken: name,
      }),
    );
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return;
    console.error(
      `[heartbeat-schedule] failed to delete schedule ${scheduleArn}:`,
      error,
    );
  }
}
