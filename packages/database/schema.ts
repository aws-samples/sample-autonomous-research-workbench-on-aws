import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const taskStatusEnum = pgEnum("TaskStatus", [
  "running",
  "completed",
  "failed",
  "timed_out",
]);

export const codeInterpreterSessionStatusEnum = pgEnum(
  "CodeInterpreterSessionStatus",
  ["active", "stopped", "expired"],
);

// ── Multi-agent orchestration enums ──

export const runStatusEnum = pgEnum("RunStatus", [
  "pending", // created, not yet picked up by a worker
  "planning", // orchestrator is producing/refreshing its plan
  "running", // actively executing (LLM loop in progress)
  "waiting_on_children", // yielded; will resume when children complete
  "succeeded",
  "failed",
  "cancelled",
]);

export const planTaskStatusEnum = pgEnum("PlanTaskStatus", [
  "pending",
  "spawned",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);

// Live status flag for a project's persona agent, synced to the UI via
// Electric SQL. Written by the API on start and by the worker on terminal.
export const projectAgentStateEnum = pgEnum("ProjectAgentState", [
  "idle",
  "working",
  "blocked",
]);

export const agentRunStatusEnum = pgEnum("AgentRunStatus", [
  "queued",
  "running",
  "completed",
  "failed",
]);

// Per-document ingestion state, tracked independently for the two indexes the
// pipeline builds (the Neptune graph and the LanceDB vector store).
export const indexStatusEnum = pgEnum("IndexStatus", [
  "pending", // uploaded, not yet processed
  "indexed", // successfully processed into the index
  "failed", // last processing attempt errored
]);

// ── Auth tables (better-auth convention, table names lowercased) ──

export const user = pgTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
  updatedAt: timestamp({ precision: 3 })
    .notNull()
    .$onUpdate(() => new Date()),
  // better-auth admin plugin fields
  role: text(),
  banned: boolean().default(false),
  banReason: text(),
  banExpires: timestamp({ precision: 3 }),
});

export const session = pgTable(
  "session",
  {
    id: text().primaryKey(),
    expiresAt: timestamp({ precision: 3 }).notNull(),
    token: text().notNull().unique(),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp({ precision: 3 })
      .notNull()
      .$onUpdate(() => new Date()),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // better-auth admin plugin field
    impersonatedBy: text(),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ precision: 3 }),
    refreshTokenExpiresAt: timestamp({ precision: 3 }),
    scope: text(),
    password: text(),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp({ precision: 3 })
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ precision: 3 }).notNull(),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp({ precision: 3 })
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ── Application tables ──

export const project = pgTable(
  "project",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    status: text().notNull().default("draft"),
    seedHypothesis: text().notNull(),
    // Objective & success criteria: what a successful outcome looks like and
    // how it will be judged.
    objective: text(),
    checkInCadence: text(),
    // Preferred model for the project's Team Lead runs (null = platform default).
    leadModel: text(),
    // User-provided override for the Team Lead's system prompt
    // (null = platform default template).
    leadSystemPrompt: text(),
    // Hard spend cap in USD for the project's agents. Every project has one
    // ($100 default) — it can be raised or lowered in settings but never
    // removed. Once spend crosses the cap the worker cancels all running
    // agents and starts are refused until the cap is raised.
    maxBudgetUsd: doublePrecision().notNull().default(100),
    // Set once by the worker when spend crosses the cap; cleared when the
    // budget is raised. Drives the UI alert.
    budgetExceededAt: timestamp({ precision: 3 }),
    // Flags & watch-outs: tripwires that should trigger an out-of-band alert
    // or halt, independent of the regular cadence.
    flags: text(),
    // Context & constraints captured opportunistically (target/protein, known
    // data, timeline, modality, out-of-scope areas).
    contextNotes: text(),
    // ARN of the project's S3 Files access point (rooted at
    // projects/{id}/ in the artifacts bucket). Created on activation;
    // null for drafts or if provisioning failed.
    s3AccessPointArn: text(),
    // ARN of the project's dedicated AgentCore runtime (worker image with the
    // project's S3 Files access point mounted at /mnt/files). Created on
    // activation; null for drafts, local dev, or if provisioning failed —
    // dispatch falls back to the shared platform runtime.
    agentRuntimeArn: text(),
    // ARN of the project's heartbeat schedule (EventBridge Scheduler). The
    // schedule itself is the source of truth for the heartbeat config (time,
    // timezone, enabled state) — read via GetSchedule, changed via
    // UpdateSchedule. Created on activation; null for drafts, envs without
    // scheduler provisioning, or after the Team Lead concluded the project
    // and stopped the heartbeat.
    heartbeatScheduleArn: text(),
    // Knowledge watermark: the `created_at` high-water mark (Neptune server
    // clock) of the Team Lead's last sufficiency decision. Agent-authored
    // graph facts stamped after this are "new knowledge" the lead has not yet
    // acted on. Advanced ONLY by the lead's startContributionRound tool — and
    // always to the max fact timestamp the lead actually reviewed, never to
    // wall-clock "now" (avoids skipping in-flight writes). Null = never
    // advanced (all agent facts are new).
    knowledgeWatermarkAt: timestamp({ precision: 3 }),
    // Debounce for knowledge pulses: set whenever a knowledge/quiescence pulse
    // actually starts a lead turn, so bursts of agents finishing close
    // together collapse into one pulse.
    lastKnowledgePulseAt: timestamp({ precision: 3 }),
    ownerId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // The Team Lead's persistent chat thread; lazily created on first
    // lead message. SET NULL so deleting the thread never blocks.
    leadTaskId: uuid().references((): AnyPgColumn => task.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp({ precision: 3 })
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("project_ownerId_idx").on(t.ownerId)],
);

export const agent = pgTable(
  "agent",
  {
    id: uuid().primaryKey().defaultRandom(),
    displayName: text().notNull(),
    description: text(),
    systemPrompt: text(),
    preferredModel: text(),
    tools: text().array().notNull().default([]),
    maxTokens: integer(),
    reasoningEnabled: boolean(),
    reasoningBudgetTokens: integer(),
    reasoningEffort: text(),
    historyStrategy: text().notNull().default("sliding-window"),
    historyWindowSize: integer().notNull().default(40),
    historyPerTurn: boolean().notNull().default(true),
    metadata: jsonb().notNull().default({}),
    userId: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp({ precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("agent_userId_idx").on(t.userId)],
);

// A skill is an uploaded folder of files (SKILL.md + supporting files) that
// extends what an agent can do. Files are stored as text rows so the UI can
// render a file-system view and the runtime can read them.
export const agentSkill = pgTable(
  "agent_skill",
  {
    id: uuid().primaryKey().defaultRandom(),
    agentId: uuid()
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text(),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp({ precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("agent_skill_agentId_name_idx").on(t.agentId, t.name),
    index("agent_skill_agentId_idx").on(t.agentId),
  ],
);

export const agentSkillFile = pgTable(
  "agent_skill_file",
  {
    id: uuid().primaryKey().defaultRandom(),
    skillId: uuid()
      .notNull()
      .references(() => agentSkill.id, { onDelete: "cascade" }),
    // Path relative to the skill root, e.g. "SKILL.md" or "scripts/run.py".
    path: text().notNull(),
    content: text().notNull(),
    size: integer().notNull(),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_skill_file_skillId_path_idx").on(t.skillId, t.path),
    index("agent_skill_file_skillId_idx").on(t.skillId),
  ],
);

export const projectAgent = pgTable(
  "project_agent",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    agentId: uuid()
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    // Live status flag: idle | working | blocked. Synced to the UI via
    // Electric SQL so the project roster updates in real time.
    state: projectAgentStateEnum().notNull().default("idle"),
    // The root orchestrator run currently executing for this agent (null when
    // idle). SET NULL so run-tree GC never FK-fails.
    activeRunId: uuid().references((): AnyPgColumn => run.id, {
      onDelete: "set null",
    }),
    // Copy of the last terminal run's AgentResult, kept after activeRunId is
    // cleared so the roster can show the latest outcome.
    lastResult: jsonb(),
    stateUpdatedAt: timestamp({ precision: 3 }),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_agent_projectId_agentId_idx").on(
      t.projectId,
      t.agentId,
    ),
    index("project_agent_agentId_idx").on(t.agentId),
    index("project_agent_activeRunId_idx").on(t.activeRunId),
  ],
);

// ── Project intake conversation (AgentCore harness session) ──

export const projectSession = pgTable(
  "project_session",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // Prospect harness run currently producing the assistant reply. This is
    // the durable stream lookup key used to resume an in-progress turn after
    // a page reload; null means there is no active prospect turn.
    activeRunId: uuid(),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp({ precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("project_session_projectId_idx").on(t.projectId),
  ],
);

export const projectMessage = pgTable(
  "project_message",
  {
    id: uuid().primaryKey().defaultRandom(),
    sessionId: uuid()
      .notNull()
      .references(() => projectSession.id, { onDelete: "cascade" }),
    role: text().notNull(),
    content: text().notNull(),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index("project_message_sessionId_idx").on(t.sessionId)],
);

// ── Tasks (a.k.a. threads) ──

export const task = pgTable(
  "task",
  {
    id: uuid().primaryKey().defaultRandom(),
    title: text().notNull(),
    status: taskStatusEnum().notNull().default("running"),
    agent: text().notNull(),
    // Full LLM ModelMessage[] history, kept for prompt-cache continuity across
    // agent runs. The UI reads human-facing messages from `taskMessage`, not
    // this column.
    agentHistory: jsonb().notNull().default([]),
    userId: text().references(() => user.id, { onDelete: "set null" }),
    // Soft-delete marker. When set, the task is treated as deleted: excluded
    // from list/get queries, but the row (and its messages) remain.
    deletedAt: timestamp({ precision: 3 }),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp({ precision: 3 })
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("task_userId_idx").on(t.userId),
    index("task_status_idx").on(t.status),
    index("task_deletedAt_idx").on(t.deletedAt),
  ],
);

// A single table holds the whole message. Tool calls / steps (toolName,
// status, input, output) live inside the assistant message `content` jsonb.
export const taskMessage = pgTable(
  "task_message",
  {
    id: uuid().primaryKey().defaultRandom(),
    role: text().notNull(),
    content: jsonb().notNull(),
    metadata: jsonb(),
    taskId: uuid()
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index("task_message_taskId_idx").on(t.taskId)],
);

// ── Agent runs ──

// One row per dispatched agent run. A run is a single `agent.run()` invocation
// against a task: it carries the run's lifecycle status and, once finished, its
// usage metrics. The per-run durable stream is keyed by this `id` (the stream
// path is `/v1/stream/run-{id}`). The API's stream proxy authorizes a live
// tail by checking the run's `taskId` is the caller's own thread or a
// project's Team Lead thread (projects are platform-visible).
export const agentRun = pgTable(
  "agent_run",
  {
    // The run id (matches the durable-stream key `run-{id}`). Generated by the
    // caller (`generateRunId`) so the stream can be tailed before the row is
    // guaranteed visible.
    id: text().primaryKey(),
    taskId: uuid()
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    status: agentRunStatusEnum().notNull().default("queued"),
    // The message that kicked off the run (the user's prompt for this turn).
    message: text().notNull(),
    // Usage/metrics, populated on completion.
    costUsd: text(),
    durationMs: integer(),
    inputTokens: integer(),
    outputTokens: integer(),
    error: text(),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
    finishedAt: timestamp({ precision: 3 }),
  },
  (t) => [
    index("agent_run_taskId_idx").on(t.taskId),
    index("agent_run_status_idx").on(t.status),
  ],
);
// ── Graph extraction template ──

// The entity/relation extraction template that drives the ingestion pipeline's
// entity skimming. Stored as a single jsonb blob keyed by a stable `name`
// ("default" is the platform template shown in the Schema tab). The shape is a
// map of entry name -> { type: actor|feature|relation, tokens: string[] };
// validation of that shape lives in the oRPC layer.
export const extractionTemplate = pgTable("extraction_template", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull().unique(),
  template: jsonb().notNull().default({}),
  // User who last saved it (null once that user is deleted).
  updatedBy: text().references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
  updatedAt: timestamp({ precision: 3 })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ── Knowledge documents (ingestion source-of-truth + per-index state) ──
//
// One row per object in the knowledge S3 bucket. The knowledge-upload API
// upserts a row (status `pending`) when a file is stored; the ingestion Step
// Function flips `indexStatus` / `graphIndexStatus` to `indexed`/`failed` as
// each branch finishes (via the in-VPC WriteStatus stage). This lets a run skip
// already-processed files and lets the UI show per-document progress.
export const document = pgTable(
  "document",
  {
    id: uuid().primaryKey().defaultRandom(),
    // The object key in the knowledge bucket — the natural key the API knows at
    // upload time and the pipeline receives per map item.
    sourceKey: text().notNull(),
    // Original file name (last path segment), kept for display.
    fileName: text().notNull(),
    // The pipeline's content-addressed id ("doc-" + sha256(fileName)[:12]),
    // recorded so graph/vector rows can be correlated back to this row.
    documentId: text(),
    // Vector (LanceDB) index state.
    indexStatus: indexStatusEnum().notNull().default("pending"),
    indexedAt: timestamp({ precision: 3 }),
    // Graph (Neptune) index state.
    graphIndexStatus: indexStatusEnum().notNull().default("pending"),
    graphIndexedAt: timestamp({ precision: 3 }),
    // Last error message from whichever branch failed (truncated).
    lastError: text(),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp({ precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("document_sourceKey_idx").on(t.sourceKey),
    index("document_indexStatus_idx").on(t.indexStatus),
    index("document_graphIndexStatus_idx").on(t.graphIndexStatus),
  ],
);

// ── Code Interpreter sessions (AWS Bedrock AgentCore sandbox per task) ──

// Tracks the agent's sandbox sessions. A task has at most one `active`
// session at a time (enforced by a partial unique index on `taskId` where
// `status = 'active'`, added in the migration SQL); sessions expire 60
// minutes after creation, mirroring the AWS `sessionTimeoutSeconds` we
// request.
export const codeInterpreterSession = pgTable(
  "code_interpreter_session",
  {
    id: uuid().primaryKey().defaultRandom(),
    taskId: uuid()
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    // The session ID returned by AWS StartCodeInterpreterSession.
    sessionId: text().notNull(),
    status: codeInterpreterSessionStatusEnum().notNull().default("active"),
    expiresAt: timestamp({ precision: 3 }).notNull(),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp({ precision: 3 })
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("code_interpreter_session_taskId_idx").on(t.taskId),
    index("code_interpreter_session_status_idx").on(t.status),
  ],
);

// ── Multi-agent orchestration ──
//
// Durable orchestration state. Postgres is the source of truth; the dispatch
// layer only coordinates (invocations carry a run ID pointer). Executors claim runs with a
// guarded status transition (UPDATE ... WHERE status IN (...) RETURNING *),
// so duplicate deliveries, retries, and concurrent resume notifications are
// all safe by construction.

// One row per agent execution — orchestrators AND sub-agents.
export const run = pgTable(
  "run",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Deleting a run deletes its whole subtree (plan_task rows cascade via
    // their own runId FK), making run-tree GC a single root delete.
    parentRunId: uuid().references((): AnyPgColumn => run.id, {
      onDelete: "cascade",
    }),
    // Equals `id` for the root orchestrator run; propagated to all descendants.
    rootRunId: uuid().notNull(),
    // Key into the agent registry: "orchestrator" or an `agent.persona` /
    // `agent.id` for sub-agents.
    agentType: text().notNull(),
    status: runStatusEnum().notNull().default("pending"),
    // The brief / TaskSpec this run executes.
    input: jsonb().notNull(),
    // Structured AgentResult written when the run reaches a terminal status.
    result: jsonb(),
    // Serialized orchestrator state (compacted view); the raw transcript
    // lives in `run_message`.
    checkpoint: jsonb(),
    error: text(),
    // Total execution segments claimed for this run. Includes normal
    // start/resume/retry segments and is used for observability/resume
    // detection — it is deliberately NOT the crash retry budget.
    attempt: integer().notNull().default(0),
    // Execution segments lost to a processor crash or expired lease. Normal
    // yield/resume cycles never increment this counter.
    failedAttempts: integer().notNull().default(0),
    // Maximum failed execution segments before the run becomes terminal.
    maxAttempts: integer().notNull().default(3),
    // Durable per-run usage, incremented after every completed segment so a
    // project's spend is a cheap SUM. (run.result.metrics is only the final
    // segment's snapshot and its token fields are unreliable.)
    costUsd: doublePrecision().notNull().default(0),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cacheReadTokens: integer().notNull().default(0),
    cacheWriteTokens: integer().notNull().default(0),
    // Wall-clock budget for the whole run.
    deadlineAt: timestamp({ precision: 3 }),
    // Root runs link back to the user-facing conversation thread; sub-agent
    // runs have no thread row.
    taskId: uuid().references(() => task.id, { onDelete: "set null" }),
    // Set on a persona/lead root run (and propagated to descendants) so a
    // project's run activity can be Electric-synced as one shape.
    projectId: uuid().references(() => project.id, { onDelete: "cascade" }),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
    startedAt: timestamp({ precision: 3 }),
    finishedAt: timestamp({ precision: 3 }),
    updatedAt: timestamp({ precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("run_rootRunId_idx").on(t.rootRunId),
    index("run_parentRunId_idx").on(t.parentRunId),
    index("run_taskId_idx").on(t.taskId),
    index("run_projectId_idx").on(t.projectId),
    index("run_active_status_idx")
      .on(t.status)
      .where(
        sql`${t.status} IN ('pending', 'planning', 'running', 'waiting_on_children')`,
      ),
  ],
);

// The orchestrator's decomposed plan. One row per planned unit of work.
// (Named `plan_task` — `task` is already the conversation-thread table.)
export const planTask = pgTable(
  "plan_task",
  {
    id: uuid().primaryKey().defaultRandom(),
    // The owning orchestrator run.
    runId: uuid()
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    // The child run executing this unit of work; set on spawn. SET NULL (not
    // cascade/no action) so deleting a child run never FK-fails and never
    // takes the plan row with it — the copied `result`/`status` survive.
    childRunId: uuid().references((): AnyPgColumn => run.id, {
      onDelete: "set null",
    }),
    // Ordering within the plan.
    seq: integer().notNull(),
    title: text().notNull(),
    agentType: text().notNull(),
    // Self-contained brief handed to the sub-agent as `run.input`.
    spec: jsonb().notNull(),
    // Plan-task IDs this unit depends on (DAG-ready).
    dependsOn: uuid().array().notNull().default([]),
    status: planTaskStatusEnum().notNull().default("pending"),
    // Copied from the child run's `result` on completion.
    result: jsonb(),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp({ precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("plan_task_runId_idx").on(t.runId),
    index("plan_task_childRunId_idx").on(t.childRunId),
  ],
);

// Append-only event log: observability, streaming, replay/debugging.
// Types: run.started, plan.created, plan.updated, task.spawned, tool.call,
// tool.result, run.yielded, run.resumed, run.finished, run.failed, ...
export const runEvent = pgTable(
  "run_event",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid()
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    rootRunId: uuid().notNull(),
    // Per-run monotonic sequence.
    seq: integer().notNull(),
    type: text().notNull(),
    payload: jsonb().notNull().default({}),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("run_event_runId_seq_idx").on(t.runId, t.seq),
    index("run_event_rootRunId_idx").on(t.rootRunId, t.id),
  ],
);

// Full ModelMessage transcript per run, kept out of `run.checkpoint` so the
// checkpoint can hold a compacted view while the raw transcript is preserved.
export const runMessage = pgTable(
  "run_message",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid()
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    // system | user | assistant | tool
    role: text().notNull(),
    // ai-sdk ModelMessage content shape.
    content: jsonb().notNull(),
    createdAt: timestamp({ precision: 3 }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("run_message_runId_seq_idx").on(t.runId, t.seq)],
);
