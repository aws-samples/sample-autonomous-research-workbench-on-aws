/**
 * Shared helpers for the Code Interpreter sandbox tools.
 *
 * The sandbox tools operate against a task's active session. The task ID is not
 * part of any tool's input schema — instead it flows through the agent's
 * `experimental_context` (set in `core/agent.ts` as `{ taskId, runId }`), which
 * the AI SDK passes to each tool's `execute` as `options.experimental_context`.
 */

export type SandboxToolContext = {
  taskId: string;
  runId?: string;
};

/**
 * Extract the task ID from a tool's `experimental_context`. Returns null when it
 * is missing or empty so callers can return a structured error rather than throw.
 */
export function getTaskId(experimentalContext: unknown): string | null {
  if (
    experimentalContext &&
    typeof experimentalContext === "object" &&
    "taskId" in experimentalContext
  ) {
    const { taskId } = experimentalContext as { taskId?: unknown };
    if (typeof taskId === "string" && taskId.length > 0) {
      return taskId;
    }
  }
  return null;
}
