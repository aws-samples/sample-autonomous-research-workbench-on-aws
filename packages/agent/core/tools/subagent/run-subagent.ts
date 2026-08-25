import { tool } from "ai";
import { z } from "zod";
import { getSpawnSubAgent } from "./context";

const NAME = "run_subagent" as const;

/**
 * Delegate a self-contained subtask to a nested agent running as a chosen
 * persona.
 *
 * The sub-agent runs its own full agent loop (its own system prompt, tools, and
 * model, resolved from the persona) and returns its final answer as this tool's
 * result. Its live text/reasoning/tool activity streams into the same run stream
 * tagged with the sub-agent id, so the UI can render it as nested progress under
 * this step.
 *
 * The actual spawning is delegated to a `spawnSubAgent` function injected via
 * `experimental_context` (wired up by the run executor), so this package needs
 * no knowledge of persona storage.
 */
export const runSubagent = tool({
  description:
    "Delegate a focused, self-contained subtask to a specialist sub-agent running as a chosen persona. The sub-agent has its own tools and expertise and returns a written answer. Use this to parallelize or to bring in domain expertise (e.g. hand a chemistry question to the Medicinal Chemist). Give the sub-agent a complete, standalone instruction — it does not see this conversation. Prefer one sub-agent per distinct subtask.",
  inputSchema: z.object({
    persona: z
      .string()
      .describe(
        "The persona to run the sub-agent as (a persona key or display name, e.g. 'medicinal-chemist').",
      ),
    task: z
      .string()
      .min(1)
      .describe(
        "A complete, self-contained instruction for the sub-agent. Include all context it needs — it cannot see the parent conversation.",
      ),
  }),
  execute: async ({ persona, task }, options) => {
    const spawn = getSpawnSubAgent(options?.experimental_context);
    if (!spawn) {
      return {
        type: NAME,
        error:
          "Sub-agents are not available in this run. Answer directly instead.",
      };
    }

    const toolCallId = options?.toolCallId ?? `subagent_${Date.now()}`;

    try {
      const result = await spawn({ persona, task, toolCallId });
      return {
        type: NAME,
        persona: result.name,
        result: result.text,
      };
    } catch (error) {
      return {
        type: NAME,
        error:
          error instanceof Error
            ? error.message
            : `Failed to run sub-agent: ${String(error)}`,
      };
    }
  },
});
