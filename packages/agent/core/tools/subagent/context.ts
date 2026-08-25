/**
 * Sub-agent spawning context.
 *
 * The `run_subagent` tool lets a parent agent delegate a self-contained piece of
 * work to a nested agent that runs with a chosen persona (its own system prompt,
 * tools, and model). The tool itself lives in `@repo/agent`, but resolving a
 * persona to a concrete agent configuration is the caller's responsibility (the
 * run executor looks personas up in the database). So instead of taking a
 * dependency on the DB here, the runner injects a `spawnSubAgent` function into
 * the agent loop's `experimental_context`; the tool calls it and streams the
 * result back to the model.
 */

export type SubAgentRequest = {
  /** Persona key or display name to run the sub-agent as. */
  persona: string;
  /** The self-contained instruction for the sub-agent. */
  task: string;
  /** The tool call id of this `run_subagent` invocation (for stream grouping). */
  toolCallId: string;
};

export type SubAgentResult = {
  /** The sub-agent's final assistant text. */
  text: string;
  /** The persona/display name the sub-agent actually ran as. */
  name: string;
};

export type SpawnSubAgent = (request: SubAgentRequest) => Promise<SubAgentResult>;

/** The list of persona keys the parent is allowed to delegate to. */
export type SubAgentContext = {
  taskId: string;
  runId?: string;
  spawnSubAgent?: SpawnSubAgent;
  /** Persona keys available to delegate to, surfaced in the tool description. */
  availablePersonas?: Array<{ persona: string; description: string }>;
};

export function getSpawnSubAgent(
  experimentalContext: unknown,
): SpawnSubAgent | null {
  if (
    experimentalContext &&
    typeof experimentalContext === "object" &&
    "spawnSubAgent" in experimentalContext
  ) {
    const { spawnSubAgent } = experimentalContext as {
      spawnSubAgent?: unknown;
    };
    if (typeof spawnSubAgent === "function") {
      return spawnSubAgent as SpawnSubAgent;
    }
  }
  return null;
}
