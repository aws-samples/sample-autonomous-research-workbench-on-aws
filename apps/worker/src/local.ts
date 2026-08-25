import "dotenv/config";
import {
  Agent,
  ConsoleRuntime,
  DEFAULT_MODEL_ID,
  SlidingWindowConversationManager,
  claimRun,
  createOrchestrationTools,
  createRootRun,
  finishRun,
  getPlanTasks,
  getRun,
  getRuns,
  isTerminalRunStatus,
  loadRunMessages,
  markRunResumable,
  orchestratorSystemPrompt,
  saveRunMessages,
  yieldRun,
  type AgentResult,
  type TaskDispatcher,
  type TaskSpec,
} from "@repo/agent";
import { resolveAgentType, resolveInheritedToolIds } from "./agent-registry";

/**
 * Queue-less local run path for debugging the orchestration loop.
 *
 * Same Postgres-backed run/plan_task state as the worker, but:
 * - no dispatch layer — children execute as in-process promises
 * - ConsoleRuntime — everything streams to your terminal
 * - the yield/resume loop is driven synchronously in this process
 *
 * Usage: pnpm --filter @workbench/worker local "Compare CRISPR base editors ..."
 */

function briefToMessage(spec: TaskSpec): string {
  return spec.context
    ? `${spec.instructions}\n\n<context>\n${spec.context}\n</context>`
    : spec.instructions;
}

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

/** Executes children immediately as tracked in-process promises. */
class InProcessDispatcher implements TaskDispatcher {
  private inFlight = new Map<string, Promise<void>>();

  async dispatch(childRunId: string): Promise<void> {
    const promise = runSubagentLocally(childRunId)
      .catch((err) => {
        console.error(`[local] subagent ${childRunId.slice(0, 8)} crashed:`, err);
      })
      .finally(() => {
        this.inFlight.delete(childRunId);
      });
    this.inFlight.set(childRunId, promise);
  }

  async waitForRuns(childRunIds: string[], timeoutMs: number): Promise<void> {
    const promises = childRunIds
      .map((id) => this.inFlight.get(id))
      .filter((p): p is Promise<void> => p !== undefined);
    await Promise.race([
      Promise.allSettled(promises),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }
}

const dispatcher = new InProcessDispatcher();

async function runSubagentLocally(runId: string): Promise<void> {
  const claimed = await claimRun(runId);
  if (!claimed) return;

  const spec = claimed.input as TaskSpec;
  console.log(`\n[local] ▶ subagent "${spec.title ?? runId.slice(0, 8)}"`);

  try {
    const config = await resolveAgentType(
      claimed.agentType,
      await resolveInheritedToolIds(claimed),
    );
    const runtime = new ConsoleRuntime(await loadRunMessages(runId));

    const agent = new Agent({
      modelId: config.modelId,
      systemPrompt: config.systemPrompt,
      tools: config.tools,
      maxTokens: config.maxTokens,
      taskId: claimed.rootRunId,
      runtime,
      conversationManager: new SlidingWindowConversationManager(40, true),
      // Scope knowledge-graph writes to this run's project (see processors.ts).
      experimentalContext: { projectId: claimed.projectId },
    });

    const { stopReason } = await agent.run({
      message: briefToMessage(spec),
      runId,
    });

    await saveRunMessages(runId, runtime.getMessages());

    const result: AgentResult =
      stopReason.type === "error"
        ? { status: "failed", summary: stopReason.error.message }
        : {
            status: "succeeded",
            summary: finalTextOf(agent) || "(no final message)",
          };
    await finishRun(runId, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(
      runId,
      { status: "failed", summary: `Crashed: ${message}` },
      message,
    );
  }

  // Propagate the terminal result onto the plan_task row so the orchestrator
  // sees it via getSubagentStatus / the resume digest.
  const finished = await getRun(runId);
  if (finished && isTerminalRunStatus(finished.status)) {
    const { db, eq, planTask } = await import("@repo/database");
    await db
      .update(planTask)
      .set({
        status:
          finished.status === "succeeded"
            ? "succeeded"
            : finished.status === "cancelled"
              ? "cancelled"
              : "failed",
        result: finished.result,
      })
      .where(eq(planTask.childRunId, runId));
  }
}

async function buildResumeMessage(runId: string): Promise<string> {
  const tasks = await getPlanTasks(runId);
  const lines = [
    "[system notification] You have been resumed because sub-agent work completed. Current plan state:",
    "",
  ];
  for (const t of tasks) {
    const result = t.result as AgentResult | null;
    lines.push(`- [${t.status}] "${t.title}" (planTaskId ${t.id}):`);
    if (result?.summary) {
      const s =
        result.summary.length > 2_000
          ? `${result.summary.slice(0, 2_000)}…`
          : result.summary;
      lines.push(`  ${s.replaceAll("\n", "\n  ")}`);
    }
  }
  lines.push("");
  lines.push(
    "Continue: integrate these results, spawn the next wave if dependencies are now satisfied, or produce your final answer if everything needed is done.",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const message = process.argv.slice(2).join(" ").trim();
  if (!message) {
    console.error('Usage: pnpm --filter @workbench/worker local "<your request>"');
    process.exit(1);
  }

  const root = await createRootRun({
    agentType: "orchestrator",
    input: { instructions: message } satisfies TaskSpec,
  });
  console.log(`[local] root run ${root.id}`);

  // Drive the yield/resume loop synchronously.
  for (let segment = 1; segment <= 20; segment++) {
    const claimed = await claimRun(root.id);
    if (!claimed) {
      const current = await getRun(root.id);
      if (current && isTerminalRunStatus(current.status)) break;
      throw new Error(`Could not claim root run (status ${current?.status})`);
    }

    console.log(`\n[local] ── orchestrator segment ${segment} ──`);

    const history = await loadRunMessages(root.id);
    const runtime = new ConsoleRuntime(history);
    const tools = createOrchestrationTools(
      { runId: root.id, rootRunId: root.id, depth: 0 },
      dispatcher,
    );

    const agent = new Agent({
      modelId: DEFAULT_MODEL_ID,
      systemPrompt: orchestratorSystemPrompt(),
      tools,
      taskId: root.id,
      runtime,
      conversationManager: new SlidingWindowConversationManager(60, true),
    });

    const { stopReason } = await agent.run({
      message:
        history.length === 0 ? message : await buildResumeMessage(root.id),
      runId: root.id,
    });

    await saveRunMessages(root.id, runtime.getMessages());

    if (stopReason.type === "error") {
      await finishRun(root.id, {
        status: "failed",
        summary: stopReason.error.message,
      });
      break;
    }

    const tasks = await getPlanTasks(root.id);
    const inFlight = tasks.filter((t) => t.status === "spawned");

    if (inFlight.length === 0) {
      await finishRun(root.id, {
        status: "succeeded",
        summary: finalTextOf(agent) || "(no final message)",
      });
      break;
    }

    // Yield, wait for all in-process children, then resume.
    await yieldRun(root.id, { inFlight: inFlight.map((t) => t.id) });
    console.log(
      `\n[local] orchestrator yielded — waiting on ${inFlight.length} sub-agent(s)…`,
    );
    await dispatcher.drain();
    await markRunResumable(root.id);
  }

  const final = await getRun(root.id);
  console.log(`\n[local] done — root run status: ${final?.status}`);
  const result = final?.result as AgentResult | null;
  if (result?.summary) {
    console.log(`\n${result.summary}`);
  }
  process.exit(final?.status === "succeeded" ? 0 : 1);
}

main().catch((err) => {
  console.error("[local] fatal:", err);
  process.exit(1);
});
