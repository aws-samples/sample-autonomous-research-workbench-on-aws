import { and, db, eq, inArray, planTask } from "@repo/database";
import { tool } from "ai";
import { z } from "zod";
import {
  appendRunEvent,
  cancelRun,
  createChildRun,
  getPlanTasks,
  getRun,
  getRuns,
  isTerminalRunStatus,
  type RunStatus,
} from "./store";
import {
  DEFAULT_LIMITS,
  type AgentResult,
  type ChildStatus,
  type OrchestrationLimits,
  type OrchestrationToolContext,
  type OrchestrationToolSet,
  type TaskDispatcher,
} from "./types";

/**
 * Orchestration tool group.
 *
 * These tools let an orchestrator agent decompose work into `plan_task` rows,
 * spawn child runs, and observe/await their completion. All durable state
 * lives in Postgres; the injected {@link TaskDispatcher} abstracts the
 * execution substrate (Bedrock AgentCore; a local agentcore server in dev).
 *
 * The orchestrator's runId/rootRunId flow in via `experimental_context`
 * (set by the Agent as `{ taskId, runId }` — the worker builds these tools
 * with the run identifiers bound instead, since context is fixed per Agent).
 */

export function createOrchestrationTools(
  context: OrchestrationToolContext,
  dispatcher: TaskDispatcher,
  limits: OrchestrationLimits = DEFAULT_LIMITS,
): OrchestrationToolSet {
  const { runId, rootRunId } = context;

  const createPlan = tool({
    description:
      "Create or extend your plan by adding tasks for sub-agents to execute. Each task must contain SELF-CONTAINED instructions (the sub-agent sees nothing else — no conversation history). Use dependsOnSeq to express ordering between tasks. Returns the created plan task ids.",
    inputSchema: z.object({
      tasks: z
        .array(
          z.object({
            title: z.string().min(1).max(200).describe("Short display title"),
            agentType: z
              .string()
              .min(1)
              .describe(
                'Agent to run this task. Use "researcher" unless told otherwise.',
              ),
            instructions: z
              .string()
              .min(1)
              .describe(
                "Complete, self-contained brief: goal, inputs, constraints, expected output format. If the sub-agent should persist what it finds (e.g. record observations, hypotheses, or decisions to the knowledge graph), say so explicitly here — the sub-agent only acts on this brief.",
              ),
            context: z
              .string()
              .optional()
              .describe("Optional extra context (upstream results, data)."),
            dependsOnSeq: z
              .array(z.number().int().min(1))
              .optional()
              .describe(
                "Seq numbers of previously-created plan tasks this one depends on.",
              ),
          }),
        )
        .min(1),
    }),
    execute: async ({ tasks }) => {
      const existing = await getPlanTasks(runId);
      if (existing.length + tasks.length > limits.maxPlanTasks) {
        return {
          error: `Plan limit exceeded: at most ${limits.maxPlanTasks} tasks per run (currently ${existing.length}).`,
        };
      }

      const seqBySeqNumber = new Map<number, string>(
        existing.map((t) => [t.seq, t.id]),
      );
      let nextSeq =
        existing.length > 0 ? Math.max(...existing.map((t) => t.seq)) + 1 : 1;

      const created: { planTaskId: string; seq: number; title: string }[] = [];
      for (const t of tasks) {
        const dependsOn = (t.dependsOnSeq ?? []).map((s) => {
          const id = seqBySeqNumber.get(s);
          if (!id) throw new Error(`dependsOnSeq ${s} does not exist`);
          return id;
        });
        const [row] = await db
          .insert(planTask)
          .values({
            runId,
            seq: nextSeq,
            title: t.title,
            agentType: t.agentType,
            spec: {
              title: t.title,
              instructions: t.instructions,
              context: t.context,
            },
            dependsOn,
          })
          .returning();
        if (!row) throw new Error("Failed to create plan task");
        seqBySeqNumber.set(nextSeq, row.id);
        created.push({ planTaskId: row.id, seq: nextSeq, title: t.title });
        nextSeq++;
      }

      await appendRunEvent({
        runId,
        rootRunId,
        type: "plan.created",
        payload: { tasks: created },
      });

      return { created };
    },
  });

  const spawnSubagents = tool({
    description:
      "Spawn sub-agent runs for pending plan tasks whose dependencies are satisfied. Sub-agents run asynchronously; this returns immediately with the child run ids. After spawning, either await_subagents (short tasks) or finish your turn — you will be resumed automatically when children complete.",
    inputSchema: z.object({
      planTaskIds: z
        .array(z.string().uuid())
        .min(1)
        .describe("Plan task ids to spawn (from create_plan)."),
    }),
    execute: async ({ planTaskIds }) => {
      if (context.depth >= limits.maxDepth) {
        return {
          error: `Max orchestration depth (${limits.maxDepth}) reached; complete the work yourself instead of spawning.`,
        };
      }
      if (planTaskIds.length > limits.maxSpawnBatch) {
        return {
          error: `At most ${limits.maxSpawnBatch} tasks can be spawned at once.`,
        };
      }

      // A cancelled/finished parent must not create new work: this run may
      // still be executing its LLM turn when the user stops the tree, and
      // children created after cancelRunTree would be unstoppable orphans.
      const parent = await getRun(runId);
      if (!parent || isTerminalRunStatus(parent.status)) {
        return {
          error:
            "This run has been stopped; no new sub-agents can be spawned.",
        };
      }

      const rows = await db.query.planTask.findMany({
        where: and(
          inArray(planTask.id, planTaskIds),
          eq(planTask.runId, runId),
        ),
      });
      const byId = new Map(rows.map((r) => [r.id, r]));

      const all = await getPlanTasks(runId);
      const statusById = new Map(all.map((t) => [t.id, t.status]));

      const spawned: { planTaskId: string; childRunId: string }[] = [];
      const skipped: { planTaskId: string; reason: string }[] = [];

      for (const id of planTaskIds) {
        const row = byId.get(id);
        if (!row) {
          skipped.push({ planTaskId: id, reason: "not found in this plan" });
          continue;
        }
        if (row.status !== "pending") {
          skipped.push({ planTaskId: id, reason: `already ${row.status}` });
          continue;
        }
        const unmetDep = row.dependsOn.find(
          (dep) => statusById.get(dep) !== "succeeded",
        );
        if (unmetDep) {
          skipped.push({
            planTaskId: id,
            reason: `dependency ${unmetDep} not succeeded yet`,
          });
          continue;
        }

        const child = await createChildRun({
          parentRunId: runId,
          rootRunId,
          agentType: row.agentType,
          input: row.spec as { instructions: string },
          projectId: context.projectId,
        });

        await db
          .update(planTask)
          .set({ childRunId: child.id, status: "spawned" })
          .where(eq(planTask.id, id));

        await dispatcher.dispatch(child.id);

        await appendRunEvent({
          runId,
          rootRunId,
          type: "task.spawned",
          payload: { planTaskId: id, childRunId: child.id, title: row.title },
        });

        spawned.push({ planTaskId: id, childRunId: child.id });
      }

      return { spawned, skipped };
    },
  });

  const getSubagentStatus = tool({
    description:
      "Check the status (and results, when finished) of your plan tasks and their sub-agent runs. Omit planTaskIds to list everything.",
    inputSchema: z.object({
      planTaskIds: z.array(z.string().uuid()).optional(),
    }),
    execute: async ({ planTaskIds }) => {
      let rows = await getPlanTasks(runId);
      if (planTaskIds && planTaskIds.length > 0) {
        const wanted = new Set(planTaskIds);
        rows = rows.filter((r) => wanted.has(r.id));
      }

      const childIds = rows
        .map((r) => r.childRunId)
        .filter((id): id is string => id !== null);
      const children = await getRuns(childIds);
      const childById = new Map(children.map((c) => [c.id, c]));

      const statuses: ChildStatus[] = rows.map((r) => {
        const child = r.childRunId ? childById.get(r.childRunId) : undefined;
        return {
          planTaskId: r.id,
          childRunId: r.childRunId,
          title: r.title,
          status: child?.status ?? r.status,
          result: (child?.result ?? r.result) as AgentResult | null,
        };
      });

      return { tasks: statuses };
    },
  });

  const awaitSubagents = tool({
    description:
      "Block until the given sub-agent runs finish (or the timeout elapses), then return their statuses/results. Only use for SHORT waits (under ~2 minutes of expected work). For longer work, finish your turn instead — you will be resumed automatically when children complete.",
    inputSchema: z.object({
      childRunIds: z.array(z.string().uuid()).min(1),
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(limits.maxAwaitMs)
        .default(60_000),
    }),
    execute: async ({ childRunIds, timeoutMs }) => {
      await dispatcher.waitForRuns(
        childRunIds,
        Math.min(timeoutMs, limits.maxAwaitMs),
      );

      const children = await getRuns(childRunIds);
      const results = children.map((c) => ({
        childRunId: c.id,
        status: c.status,
        result: c.result as AgentResult | null,
      }));
      const stillRunning = results.filter(
        (r) => !isTerminalRunStatus(r.status as RunStatus),
      );

      return {
        results,
        timedOut: stillRunning.length > 0,
        hint:
          stillRunning.length > 0
            ? "Some runs are still going. Finish your turn now; you will be resumed when they complete."
            : undefined,
      };
    },
  });

  const cancelSubagent = tool({
    description:
      "Cancel a sub-agent run that is no longer needed. Cooperative: a run that is mid-execution finishes its current step before stopping.",
    inputSchema: z.object({
      childRunId: z.string().uuid(),
    }),
    execute: async ({ childRunId }) => {
      const cancelled = await cancelRun(childRunId);
      if (cancelled) {
        await db
          .update(planTask)
          .set({ status: "cancelled" })
          .where(
            and(
              eq(planTask.childRunId, childRunId),
              eq(planTask.runId, runId),
            ),
          );
        await appendRunEvent({
          runId,
          rootRunId,
          type: "task.cancelled",
          payload: { childRunId },
        });
      }
      return { cancelled };
    },
  });

  return {
    createPlan,
    spawnSubagents,
    getSubagentStatus,
    awaitSubagents,
    cancelSubagent,
  };
}
