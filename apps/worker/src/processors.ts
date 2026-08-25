import {
  Agent,
  claimRun,
  closeRunStream,
  finishRun,
  getPlanTasks,
  getRun,
  isTerminalRunStatus,
  loadRunMessages,
  yieldRun,
  appendRunEvent,
  createLeadTools,
  createOrchestrationTools,
  orchestratorSystemPrompt,
  teamLeadSystemPrompt,
  SlidingWindowConversationManager,
  StreamRuntime,
  DEFAULT_MODEL_ID,
  TEAM_LEAD_DEFAULT_MODEL_ID,
  getAvailableModelIds,
  resolveTools,
  type AgentResult,
  type ModelId,
  type RunRow,
  type TaskSpec,
} from "@repo/agent";
import {
  and,
  db,
  eq,
  inArray,
  ne,
  project,
  projectAgent,
  run as runTable,
  sql,
  task as taskTable,
  taskMessage,
} from "@repo/database";
import {
  disableProjectHeartbeatSchedule,
  dispatchOrchestratorRun,
  enableProjectHeartbeatSchedule,
} from "@repo/queue";
import { RunDispatcher } from "./dispatcher";
import { enforceProjectBudget } from "./budget";
import { resolveAgentType, resolveInheritedToolIds } from "./agent-registry";
import { startRunLease } from "./run-lease";
import { RunRuntime } from "./run-runtime";
import {
  isTeamLeadRun,
  onChildTerminal,
  resolveRunAuthor,
} from "./run-terminal";

// Re-exported for the agentcore server's orchestrator/team-lead routing.
export { isTeamLeadRun, onChildTerminal } from "./run-terminal";

const dispatcher = new RunDispatcher();

/**
 * Cooperative stop: the agent's background poller watches the run row and
 * aborts the LLM stream as soon as the status goes terminal (cancelRunTree
 * flips the whole tree to `cancelled`), instead of letting the segment run
 * to completion after the user pressed Stop.
 */
function runCancellationSignal(runId: string) {
  return {
    check: async () => {
      const row = await getRun(runId);
      return row === null || isTerminalRunStatus(row.status);
    },
  };
}

/** Compose the user message for a run segment from its TaskSpec. */
function briefToMessage(spec: TaskSpec): string {
  const parts = [spec.instructions];
  if (spec.context) {
    parts.push(`\n\n<context>\n${spec.context}\n</context>`);
  }
  return parts.join("");
}

/** Depth of a run in the orchestration tree (root = 0). */
async function computeDepth(row: RunRow): Promise<number> {
  let depth = 0;
  let parentId = row.parentRunId;
  while (parentId && depth < 10) {
    depth++;
    const parent = await getRun(parentId);
    parentId = parent?.parentRunId ?? null;
  }
  return depth;
}

/** Extract the last assistant text from the agent's collected messages. */
function finalTextOf(agent: Agent): string {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const msg = agent.messages[i];
    if (
      msg &&
      msg.role === "assistant" &&
      typeof msg.content === "object" &&
      "type" in msg.content &&
      msg.content.type === "text"
    ) {
      return msg.content.text;
    }
  }
  return "";
}

/**
 * Execute a sub-agent run to completion.
 *
 * Duplicate deliveries are dropped by the guarded claim. On success the
 * structured result is copied onto the owning plan_task row, and the parent
 * orchestrator is resumed if it is waiting.
 */
export async function processSubagentRun(runId: string): Promise<void> {
  const claimed = await claimRun(runId);
  if (!claimed) {
    console.log(`[subagent ${runId.slice(0, 8)}] not claimable, dropping`);
    return;
  }

  if (claimed.deadlineAt && claimed.deadlineAt.getTime() < Date.now()) {
    await finishRun(runId, {
      status: "failed",
      summary: "Run deadline exceeded before execution started.",
    });
    await onChildTerminal(claimed);
    return;
  }

  // Budget gate: don't start a segment on an over-budget project. The
  // enforcement cancels this run's tree, so just propagate the terminal.
  if (await enforceProjectBudget(claimed.projectId)) {
    const cancelled = await getRun(runId);
    if (cancelled) await onChildTerminal(cancelled);
    return;
  }

  const spec = claimed.input as TaskSpec;
  const startedAt = Date.now();
  // Assert liveness to the sweeper for as long as this segment executes.
  const lease = startRunLease(runId);

  try {
    const config = await resolveAgentType(
      claimed.agentType,
      await resolveInheritedToolIds(claimed),
    );
    const history = await loadRunMessages(runId);
    const runtime = new RunRuntime(
      { runId, rootRunId: claimed.rootRunId },
      history,
    );

    const agent = new Agent({
      modelId: config.modelId,
      systemPrompt: config.systemPrompt,
      tools: config.tools,
      maxTokens: config.maxTokens,
      taskId: claimed.rootRunId,
      runtime,
      conversationManager: new SlidingWindowConversationManager(40, true),
      stopSignal: runCancellationSignal(runId),
      // Provenance for knowledge-graph writes: the graph-write tools read
      // this off experimental_context and stamp it onto the facts they
      // create (see tools/graph/write.ts) — project scoping plus the
      // author/run attribution the research loop's knowledge pulses query.
      experimentalContext: {
        projectId: claimed.projectId,
        runId,
        rootRunId: claimed.rootRunId,
        ...(await resolveRunAuthor(claimed)),
      },
    });

    const { stopReason } = await agent.run({
      message: briefToMessage(spec),
      runId,
    });

    // "stopped" means the run row is already cancelled (that's what tripped
    // the signal) — skip finishRun (guarded no-op) and fall through so the
    // terminal hook still propagates to the plan_task row.
    if (stopReason.type !== "stopped") {
      const summary = finalTextOf(agent);
      const result: AgentResult =
        stopReason.type === "completed"
          ? {
              status: "succeeded",
              summary: summary || "(no final message produced)",
              metrics: {
                costUSD: agent.totalCost,
                durationMs: Date.now() - startedAt,
                inputTokens: 0,
                outputTokens: 0,
              },
            }
          : {
              status: "failed",
              summary: `Sub-agent failed: ${stopReason.error.message}`,
            };

      await finishRun(
        runId,
        result,
        stopReason.type === "error" ? stopReason.error.message : undefined,
      );
    }
  } catch (error) {
    // Retry through re-dispatch while failed execution attempts remain;
    // successful resume segments do not consume this budget.
    await retryOrFail(runId, error, "Sub-agent crashed");
  } finally {
    lease.stop();
  }

  const finished = await getRun(runId);
  if (finished) {
    await onChildTerminal(finished);
  }
}

/**
 * Execute one orchestrator segment: claim, run the LLM loop with
 * orchestration tools, then either yield (children still active) or finish.
 */
export async function processOrchestratorRun(runId: string): Promise<void> {
  const claimed = await claimRun(runId);
  if (!claimed) {
    console.log(`[orchestrator ${runId.slice(0, 8)}] not claimable, dropping`);
    return;
  }

  if (claimed.deadlineAt && claimed.deadlineAt.getTime() < Date.now()) {
    await finishRun(runId, {
      status: "failed",
      summary: "Orchestrator deadline exceeded.",
    });
    await onChildTerminal((await getRun(runId))!);
    return;
  }

  // Budget gate: an over-budget project stops spawning/continuing work.
  if (await enforceProjectBudget(claimed.projectId)) {
    const cancelled = await getRun(runId);
    if (cancelled) await onChildTerminal(cancelled);
    return;
  }

  const spec = claimed.input as TaskSpec;
  const isResume = claimed.attempt > 1 || claimed.checkpoint !== null;
  const startedAt = Date.now();
  // Assert liveness to the sweeper for as long as this segment executes. An
  // orchestrator segment can spend a long time in one LLM turn (or in a slow
  // specialist tool) without writing its own run row.
  const lease = startRunLease(runId);

  // Persona root run: assert the roster flag. The API flips it on start, but
  // sweeper retries re-enter here without going through the API. Guarded on
  // state so steady-state resumes don't rewrite (and Electric-broadcast) it.
  if (!claimed.parentRunId && claimed.projectId) {
    await db
      .update(projectAgent)
      .set({ state: "working", stateUpdatedAt: new Date() })
      .where(
        and(
          eq(projectAgent.activeRunId, claimed.id),
          ne(projectAgent.state, "working"),
        ),
      );
  }

  try {
    const depth = await computeDepth(claimed);
    const history = await loadRunMessages(runId);
    const runtime = new RunRuntime(
      { runId, rootRunId: claimed.rootRunId },
      history,
    );

    const orchestrationTools = createOrchestrationTools(
      {
        runId,
        rootRunId: claimed.rootRunId,
        depth,
        projectId: claimed.projectId,
      },
      dispatcher,
    );

    // A persona's root run is an orchestrator, but it also gets the specialist
    // tools the persona was granted, so it can do the work
    // itself instead of being forced to delegate everything. Without this the
    // root run sees ONLY the orchestration tools and reports its own specialist
    // tools as unavailable, even though they are configured on the persona.
    // Orchestration tools win on a name collision.
    const personaToolIds = await resolveInheritedToolIds(claimed);
    const personaTools =
      personaToolIds.length > 0 ? resolveTools(personaToolIds) : {};

    const agent = new Agent({
      modelId: DEFAULT_MODEL_ID,
      systemPrompt: orchestratorSystemPrompt(),
      tools: { ...personaTools, ...orchestrationTools },
      taskId: claimed.taskId ?? claimed.rootRunId,
      runtime,
      conversationManager: new SlidingWindowConversationManager(60, true),
      stopSignal: runCancellationSignal(runId),
      experimentalContext: {
        projectId: claimed.projectId,
        runId,
        rootRunId: claimed.rootRunId,
        ...(await resolveRunAuthor(claimed)),
      },
    });

    const message =
      history.length === 0
        ? briefToMessage(spec)
        : await buildResumeMessage(runId);

    const { stopReason } = await agent.run({ message, runId });

    if (stopReason.type === "error") {
      throw stopReason.error;
    }
    if (stopReason.type === "stopped") {
      // Run row already cancelled by stopProjectAgent; the roster flag was
      // reset there too. Nothing further to transition — just EOF the live
      // stream (this path skips onChildTerminal).
      await closeRunStream(runId);
      return;
    }

    // Decide: yield if any children are still in flight, otherwise finish.
    const tasks = await getPlanTasks(runId);
    const inFlight = tasks.filter((t) => t.status === "spawned");

    if (inFlight.length > 0) {
      const yielded = await yieldRun(runId, {
        planTaskCount: tasks.length,
        inFlight: inFlight.map((t) => t.id),
        yieldedAt: new Date().toISOString(),
      });
      if (yielded) {
        await appendRunEvent({
          runId,
          rootRunId: claimed.rootRunId,
          type: "run.yielded",
          payload: { inFlight: inFlight.map((t) => t.id) },
        });
        return;
      }
      // yield lost the race (a child finished during the LLM turn and moved
      // us back to pending) — the resume job will pick the run up again.
      return;
    }

    const summary = finalTextOf(agent);
    await finishRun(runId, {
      status: "succeeded",
      summary: summary || "(orchestrator finished without a final message)",
      metrics: {
        costUSD: agent.totalCost,
        durationMs: Date.now() - startedAt,
        inputTokens: 0,
        outputTokens: 0,
      },
    });
    await appendRunEvent({
      runId,
      rootRunId: claimed.rootRunId,
      type: "run.finished",
      payload: { isResume },
    });

    const finished = await getRun(runId);
    if (finished) {
      await onChildTerminal(finished);
    }
  } catch (error) {
    await retryOrFail(runId, error, "Orchestrator crashed");
    const finished = await getRun(runId);
    if (finished) {
      await onChildTerminal(finished);
    }
  } finally {
    lease.stop();
  }
}

/**
 * Synthetic user message injected when an orchestrator resumes: a compact
 * digest of what changed since it yielded. Full results stay in plan_task
 * rows (fetchable via getSubagentStatus) — only summaries enter the context.
 */
async function buildResumeMessage(runId: string): Promise<string> {
  const tasks = await getPlanTasks(runId);
  const terminal = tasks.filter((t) =>
    ["succeeded", "failed", "cancelled"].includes(t.status),
  );
  const inFlight = tasks.filter((t) => t.status === "spawned");
  const pending = tasks.filter((t) => t.status === "pending");

  const lines: string[] = [
    "[system notification] You have been resumed because sub-agent work completed. Current plan state:",
    "",
  ];

  for (const t of terminal) {
    const result = t.result as AgentResult | null;
    const summary = result?.summary
      ? result.summary.length > 2_000
        ? `${result.summary.slice(0, 2_000)}…`
        : result.summary
      : "(no summary)";
    lines.push(`- [${t.status}] "${t.title}" (planTaskId ${t.id}):`);
    lines.push(`  ${summary.replaceAll("\n", "\n  ")}`);
  }
  if (inFlight.length > 0) {
    lines.push("");
    lines.push(
      `Still running: ${inFlight.map((t) => `"${t.title}"`).join(", ")}.`,
    );
  }
  if (pending.length > 0) {
    lines.push(
      `Not yet spawned: ${pending.map((t) => `"${t.title}"`).join(", ")}.`,
    );
  }

  lines.push("");
  lines.push(
    "Continue: integrate these results, spawn the next wave if dependencies are now satisfied, or produce your final answer if everything needed is done.",
  );

  return lines.join("\n");
}

/**
 * Shared crash path: reset to pending and rethrow (the agentcore server
 * catches and re-dispatches) while failed execution segments remain;
 * otherwise fail the run terminally. `run.attempt` counts every claimed
 * segment, including successful resumes; only `failedAttempts` belongs to
 * this crash budget. Returns true when this call made the failure terminal.
 */
async function retryOrFail(
  runId: string,
  error: unknown,
  label: string,
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);

  // Increment the failure counter and release the run in one guarded update.
  // A concurrent cancellation/terminal transition wins by making this a
  // zero-row update, so a late catch never resurrects it.
  const [retryable] = await db
    .update(runTable)
    .set({
      status: "pending",
      error: message,
      failedAttempts: sql`${runTable.failedAttempts} + 1`,
    })
    .where(
      and(
        eq(runTable.id, runId),
        inArray(runTable.status, ["planning", "running"]),
        sql`${runTable.failedAttempts} + 1 < ${runTable.maxAttempts}`,
      ),
    )
    .returning({
      failedAttempts: runTable.failedAttempts,
      maxAttempts: runTable.maxAttempts,
    });
  if (retryable) {
    console.warn(
      `[retry] run ${runId.slice(0, 8)} ${label.toLowerCase()} ` +
        `(failure ${retryable.failedAttempts}/${retryable.maxAttempts})`,
    );
    throw error;
  }

  // The same guarded comparison makes the terminal transition atomic with
  // consuming the final failure. If another owner already moved the row,
  // this is a no-op and the caller must not surface a second failure.
  const [terminal] = await db
    .update(runTable)
    .set({
      status: "failed",
      error: message,
      failedAttempts: sql`${runTable.failedAttempts} + 1`,
      finishedAt: new Date(),
      result: { status: "failed", summary: `${label}: ${message}` },
    })
    .where(
      and(
        eq(runTable.id, runId),
        inArray(runTable.status, ["planning", "running"]),
        sql`${runTable.failedAttempts} + 1 >= ${runTable.maxAttempts}`,
      ),
    )
    .returning({
      failedAttempts: runTable.failedAttempts,
      maxAttempts: runTable.maxAttempts,
    });
  if (terminal) {
    console.error(
      `[retry] run ${runId.slice(0, 8)} exhausted failure budget ` +
        `(${terminal.failedAttempts}/${terminal.maxAttempts})`,
    );
  }
  return terminal !== undefined;
}

/**
 * A team-lead run failed without ever reaching StreamRuntime.onRunError
 * (which normally writes the platform error row): surface the failure to the
 * chat and release the task so the UI's thinking indicator stops.
 */
async function failLeadTask(taskId: string): Promise<void> {
  await db.insert(taskMessage).values({
    role: "platform",
    content: {
      type: "error",
      message: "The Team Lead could not process this message. Please try again.",
    },
    taskId,
  });
  await db
    .update(taskTable)
    .set({ status: "failed" })
    .where(eq(taskTable.id, taskId));
}

/**
 * Execute one Team Lead chat turn. *
 * The lead is a plain chat agent, not an orchestrator: it never yields — each
 * run is one user message answered with lead tools (list/start/stop/progress
 * of the project's persona agents). It uses StreamRuntime so replies persist
 * to `taskMessage` (Electric-synced for the chat UI) and history lives on
 * `task.agentHistory`, exactly like regular task threads.
 */
export async function processTeamLeadRun(runId: string): Promise<void> {
  const claimed = await claimRun(runId);
  if (!claimed) {
    console.log(`[team-lead ${runId.slice(0, 8)}] not claimable, dropping`);
    return;
  }
  if (!claimed.taskId || !claimed.projectId) {
    await finishRun(runId, {
      status: "failed",
      summary: "Team-lead run is missing taskId or projectId.",
    });
    if (claimed.taskId) await failLeadTask(claimed.taskId);
    return;
  }

  const spec = claimed.input as TaskSpec;
  const startedAt = Date.now();
  // True once StreamRuntime is driving the run: from then on Agent.run
  // handles its own error surfacing (platform row + task status).
  let agentStarted = false;
  // Assert liveness to the sweeper: a lead turn that reads the whole
  // knowledge pool can outlast the stall window on its own.
  const lease = startRunLease(runId);

  try {
    const projectRow = await db.query.project.findFirst({
      where: eq(project.id, claimed.projectId),
    });
    if (!projectRow) throw new Error("Project not found for team-lead run");

    const leadTools = createLeadTools({
      projectId: claimed.projectId,
      enqueue: async (rootRunId) => {
        await dispatchOrchestratorRun({ runId: rootRunId, reason: "start" });
      },
      // stopHeartbeat: disables the project's EventBridge Scheduler schedule
      // (never deletes it — the user can re-enable from settings).
      disableHeartbeatSchedule: disableProjectHeartbeatSchedule,
      // Starting an agent resumes a paused/completed project. Reopening a
      // completed project also resumes the daily pulse disabled at conclusion.
      enableHeartbeatSchedule: enableProjectHeartbeatSchedule,
    });

    // Use the project's configured lead model when it's one the runtime can
    // serve; otherwise use the Team Lead-specific Sonnet default.
    const leadModelId: ModelId =
      projectRow.leadModel &&
      getAvailableModelIds().includes(projectRow.leadModel as ModelId)
        ? (projectRow.leadModel as ModelId)
        : TEAM_LEAD_DEFAULT_MODEL_ID;

    const agent = new Agent({
      modelId: leadModelId,
      // A project-level override replaces the default Team Lead template
      // entirely; blank/whitespace overrides fall back to the default.
      systemPrompt:
        projectRow.leadSystemPrompt?.trim() ||
        teamLeadSystemPrompt({
          projectName: projectRow.name,
          seedHypothesis: projectRow.seedHypothesis,
        }),
      tools: leadTools,
      taskId: claimed.taskId,
      runtime: new StreamRuntime(claimed.taskId, runId),
      conversationManager: new SlidingWindowConversationManager(40, true),
      stopSignal: runCancellationSignal(runId),
      experimentalContext: {
        projectId: claimed.projectId,
        runId,
        rootRunId: claimed.rootRunId,
        ...(await resolveRunAuthor(claimed)),
      },
    });

    agentStarted = true;
    const { stopReason } = await agent.run({
      message: spec.instructions,
      runId,
    });

    if (stopReason.type === "error") throw stopReason.error;
    if (stopReason.type === "stopped") return;

    await finishRun(runId, {
      status: "succeeded",
      summary: finalTextOf(agent) || "(no reply produced)",
      metrics: {
        costUSD: agent.totalCost,
        durationMs: Date.now() - startedAt,
        inputTokens: 0,
        outputTokens: 0,
      },
    });
  } catch (error) {
    const terminal = await retryOrFail(runId, error, "Team lead crashed");
    // Pre-agent terminal failures never reach StreamRuntime.onRunError, so
    // the chat would spin forever without this.
    if (terminal && !agentStarted) {
      await failLeadTask(claimed.taskId);
    }
  } finally {
    lease.stop();
  }
}
