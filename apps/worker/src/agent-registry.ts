import {
  DEFAULT_MODEL_ID,
  defaultTools,
  getRun,
  resolveTools,
  systemPrompt,
  toolRegistry,
  type ModelId,
  type RunRow,
} from "@repo/agent";
import { DEFAULT_TOOL_IDS } from "@repo/agent/tools/catalog";
import { agent as agentTable, db, eq } from "@repo/database";
import type { Tool } from "ai";

/**
 * Resolve an `agentType` (the registry key stored on a run row) to an agent
 * configuration. Resolution order:
 *
 * 1. Built-in types ("orchestrator" is handled by the orchestrator processor;
 *    "researcher" is the default sub-agent profile).
 * 2. A DB `agent` row matched by id — agents defined in the management UI
 *    become spawnable sub-agent types automatically.
 */
export type ResolvedAgentConfig = {
  modelId: ModelId;
  systemPrompt: string;
  tools: Record<string, Tool>;
  maxTokens?: number;
};

const RESEARCHER_PROMPT = `You are a specialist sub-agent executing one self-contained task for an orchestrator.

You receive a single brief. Complete it thoroughly using your tools, then produce a final message that stands alone: the orchestrator only sees your last message, so it must contain your complete findings — key facts, evidence, sources, and a clear bottom line. Do not ask questions; make reasonable assumptions and state them.

Ground your work in the project's own corpus before you reason from memory or reach for the web. Start with queryDocuments if you have it: it runs hybrid semantic (vector) + full-text search over every ingested document — text, tables, figure descriptions, full pages — so it surfaces relevant passages by meaning, not just keyword overlap. Issue several long, specific queries with different phrasings rather than one; filter by modality when it helps (modality: ["table"] for numeric data, ["figure"] for images) or scope to one document with file or documentId. Results are snippets — call getDocumentPage for a chunk's full text or getDocument to read a document in page order before you quote or rely on a number. The graph tools (graphSearch, graphNeighborhood, graphPaths) cover the SAME corpus from the structural side and both key on the same document id, so pair them: graph to find a connection, then queryDocuments on that documentId to quote the evidence; or queryDocuments to find material, then graphDocumentFacts on a hit to pivot into its extracted relationships. Graph facts are terse extractions — do not report a detail from the graph alone when the source text can confirm it. If a document search returns an error, say so in your final message rather than silently falling back to your own knowledge: a retrieval failure is a finding, and an unsourced answer that looks sourced is worse than no answer.

Record findings as you go, not only in your final message — a finding that lives only in your reply is lost to the rest of the team, and the research loop reacts ONLY to what you record to the graph. The graph has two complementary channels; use both:

1. Your REASONING drives the loop — record it with the epistemic tools (epistemicRecordObservation, epistemicProposeHypothesis, epistemicLinkEvidence, epistemicRecordDecision) if available. As you establish each substantive finding, call epistemicRecordObservation (with its source and your confidence); when the evidence forms a testable claim, call epistemicProposeHypothesis. Use epistemicListHypotheses to find the relevant hypotheses — including the project's SEED hypothesis, the root the whole project turns on — and call epistemicLinkEvidence to connect your observation to the hypothesis it supports or contradicts. Whenever a finding bears on the seed hypothesis, link it there. The Team Lead's sufficiency loop advances on these observations and hypotheses — a finding you keep only in prose is invisible to it.

2. The FACTS your reasoning cites — record concrete relationships with graphAddFact if available:
- Write each relationship as a subject-predicate-object triple. The graph is append-only: you cannot edit or delete a fact, so state it correctly the first time.
- Resolve exact entity names with graphSearch first so you extend existing entities instead of creating near-duplicates, and prefer predicates already in the ontology (graphOverview lists them). Any entity you name is created if it does not exist — there is no separate entity-creation step.
- Include the documentId when a fact comes from a corpus document.

Do all of this during the work, before you write your summary — the summary reports what you recorded, it does not replace it. If a graph write returns an error, note it and continue the research; do not abandon the rest of the task. Skip a channel only if you lack its tools or the brief says otherwise.

Before you start an expensive experiment or simulation, check what this project has already run: other agents work in parallel and cannot see your context or each other's, so submitting a duplicate job wastes real budget. Call listProjectExperiments if you have it (the shared experiment ledger), or look in the project's shared file directory. If an equivalent run already exists, poll it for results instead of launching another; only submit when nothing matches what you need. Record what you start so the next agent can see it.

When your brief calls for a calculation or simulation you hold a tool for (for example a computational-chemistry workflow tool), CALL THE TOOL and report the values it returns. Report only results a tool actually produced: never estimate, extrapolate, or fabricate numbers, tables, or files, and never describe a study as if it ran when it did not. Long-running jobs are expected — submit, then poll the status tool; a job still running is a valid finding, so report it as such. If a tool errors, report the error verbatim. If the brief needs a capability you have no tool for, say so plainly instead of substituting a plausible-looking answer.`;

/**
 * Log the tools an agent actually resolved to at creation time. The DB `tools`
 * column is only the *request*: resolveTools silently drops any id not in the
 * running image's toolRegistry (typo, or a group added after this image was
 * built), so the granted set can differ from what the DB shows. `source`
 * distinguishes the resolution branch; `requestedIds` is the DB column when
 * that path used it (undefined for the defaultTools() paths).
 */
function logResolvedTools(
  agentType: string,
  source: "researcher" | "db-row" | "fallback",
  tools: Record<string, Tool>,
  requestedIds?: string[],
): void {
  const granted = Object.keys(tools).sort();
  const dropped =
    requestedIds
      ?.flatMap((id) => (toolRegistry[id] ? [] : [id]))
      .sort() ?? [];
  console.log(
    `[agent-registry] resolved tools agentType=${agentType} source=${source} ` +
      `granted=[${granted.join(",")}]` +
      (requestedIds ? ` requestedGroups=[${[...requestedIds].sort().join(",")}]` : "") +
      (dropped.length ? ` DROPPED_UNKNOWN=[${dropped.join(",")}]` : ""),
  );
}

/**
 * Merge the default researcher tool set with tool ids inherited from the run
 * tree's owning persona. A project persona's root run is processed as a
 * generic orchestrator and delegates to "researcher" children (see
 * processors.ts / orchestration/tools.ts), so without this the specialist
 * tools granted to the persona (e.g. "code-interpreter" on a specialist)
 * would never reach the sub-agent that does the work. Union, deduped —
 * inherited groups are added on top of the defaults, never subtracted.
 */
function inheritedResearcherTools(
  inheritToolIds: string[] | undefined,
): Record<string, Tool> {
  if (!inheritToolIds || inheritToolIds.length === 0) return defaultTools();
  const ids = [...new Set([...DEFAULT_TOOL_IDS, ...inheritToolIds])];
  return resolveTools(ids);
}

export async function resolveAgentType(
  agentType: string,
  /**
   * Tool config ids inherited from the owning persona for generic
   * ("researcher"/unknown) children — unioned with DEFAULT_TOOL_IDS. Ignored
   * when the agentType resolves to a persona row of its own (that row's tools
   * already win).
   */
  inheritToolIds?: string[],
): Promise<ResolvedAgentConfig> {
  if (agentType === "researcher" || agentType === "subagent") {
    const tools = inheritedResearcherTools(inheritToolIds);
    logResolvedTools(agentType, "researcher", tools, inheritToolIds);
    return {
      modelId: DEFAULT_MODEL_ID,
      systemPrompt: `${RESEARCHER_PROMPT}\n\n${systemPrompt()}`,
      tools,
    };
  }

  // agent.id is a uuid column; non-uuid agentTypes (e.g. "orchestrator")
  // can't be queried against it without Postgres throwing.
  const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const row = UUID_RE.test(agentType)
    ? await db.query.agent.findFirst({
        where: eq(agentTable.id, agentType),
      })
    : undefined;

  if (row) {
    const usingStored = row.tools.length > 0;
    const tools = usingStored ? resolveTools(row.tools) : defaultTools();
    logResolvedTools(
      agentType,
      "db-row",
      tools,
      usingStored ? row.tools : undefined,
    );
    return {
      modelId: (row.preferredModel ?? DEFAULT_MODEL_ID) as ModelId,
      systemPrompt: row.systemPrompt
        ? `${RESEARCHER_PROMPT}\n\n${row.systemPrompt}`
        : `${RESEARCHER_PROMPT}\n\n${systemPrompt()}`,
      tools,
      maxTokens: row.maxTokens ?? undefined,
    };
  }

  // Unknown type: fall back to the generic researcher so a typo in a plan
  // degrades gracefully instead of dead-lettering the run. Still inherits the
  // owning persona's tools, same as an explicit "researcher".
  const tools = inheritedResearcherTools(inheritToolIds);
  logResolvedTools(agentType, "fallback", tools, inheritToolIds);
  return {
    modelId: DEFAULT_MODEL_ID,
    systemPrompt: `${RESEARCHER_PROMPT}\n\n${systemPrompt()}`,
    tools,
  };
}

/**
 * Tool config ids the run tree's owning persona was granted, to pass as
 * `inheritToolIds` to resolveAgentType for a generic child. A project persona
 * tree's ROOT run has the persona agent's uuid as its agentType; that persona
 * row carries the `tools` the user configured. Without this,
 * a persona's specialist tools never reach the "researcher" sub-agents it
 * delegates the actual work to (the persona root runs as a generic
 * orchestrator). Best-effort: any failure (or a non-persona root) yields no
 * inheritance, i.e. plain defaults.
 */
export async function resolveInheritedToolIds(row: RunRow): Promise<string[]> {
  try {
    const root = row.rootRunId === row.id ? row : await getRun(row.rootRunId);
    const agentType = root?.agentType ?? row.agentType;
    const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(agentType)) return [];
    const persona = await db.query.agent.findFirst({
      where: eq(agentTable.id, agentType),
      columns: { tools: true },
    });
    return persona?.tools ?? [];
  } catch {
    return [];
  }
}
