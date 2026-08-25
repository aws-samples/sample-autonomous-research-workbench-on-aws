import type { Tool } from "ai";

/**
 * Generic per-tool execution deadline.
 *
 * Why this exists: the worker reports `HealthyBusy` to AgentCore while any
 * segment is executing, which (by design) exempts the session from the
 * 15-minute idle timeout. That means a hung tool call — e.g. a graph query
 * that never returns — keeps the session alive, the model loop parked on an
 * unresolved `execute` promise, and the UI tool chip spinning until the
 * session's MaxLifetime. Nothing platform-side will unstick it, so the
 * application must bound tool execution itself.
 *
 * On timeout the wrapper resolves the call with a structured
 * {@link ToolTimeoutResult} instead of throwing. A resolved value flows
 * through the AI SDK as a normal `tool-result` chunk, so:
 * - the model sees the timeout payload and can retry or route around it,
 * - the existing `tool-result` persistence/stream path closes the UI chip,
 * - the agent loop keeps running (a thrown error would abort the stream).
 *
 * The wrapped tool also receives an AbortSignal that fires on timeout, so
 * cooperative tools (fetch, SDK clients) can actually cancel the underlying
 * work rather than leaking it.
 */
export const DEFAULT_AGENT_TOOL_TIMEOUT_MS = 5 * 60_000;

/** Sentinel returned by the internal race when the deadline fires. */
const TOOL_TIMEOUT = Symbol("tool-timeout");

type ToolExecute = NonNullable<Tool["execute"]>;
type ToolExecutionOptions = Parameters<ToolExecute>[1];

/** Structured output the model receives when a tool call times out. */
export type ToolTimeoutResult = {
  type: "tool-timeout";
  error: string;
  toolName: string;
  timeoutMs: number;
  retryable: true;
};

/**
 * Resolve the configured timeout: `AGENT_TOOL_TIMEOUT_MS` when set to a
 * positive number, otherwise {@link DEFAULT_AGENT_TOOL_TIMEOUT_MS}.
 */
export function agentToolTimeoutMs(): number {
  const configured = Number(process.env.AGENT_TOOL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : DEFAULT_AGENT_TOOL_TIMEOUT_MS;
}

function toolTimeoutResult(
  toolName: string,
  timeoutMs: number,
): ToolTimeoutResult {
  return {
    type: "tool-timeout",
    error:
      `Tool "${toolName}" timed out after ${timeoutMs}ms and was cancelled. ` +
      `Do not wait for it. Retry it once if the result is essential, or ` +
      `continue with a different approach.`,
    toolName,
    timeoutMs,
    retryable: true,
  };
}

type ExecutionGuard = {
  /** Signal passed to the wrapped tool; aborts on timeout or parent abort. */
  signal: AbortSignal;
  /** Race a promise against the deadline and the parent abort. */
  wait<T>(promise: PromiseLike<T>): Promise<T | typeof TOOL_TIMEOUT>;
  /** Clear the timer and detach the parent-abort listener. */
  cleanup(): void;
};

function createExecutionGuard(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  onTimeout: () => void,
): ExecutionGuard {
  const controller = new AbortController();
  let resolveTimeout!: (value: typeof TOOL_TIMEOUT) => void;
  let rejectAbort!: (reason?: unknown) => void;

  const timeoutPromise = new Promise<typeof TOOL_TIMEOUT>((resolve) => {
    resolveTimeout = resolve;
  });
  // A parent abort (run cancelled/stopped) is NOT converted into a timeout
  // result — it propagates as a rejection so the loop's abort handling wins.
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  // The race may settle via the tool or the timeout instead; without a
  // handler the eventual abort rejection would be an unhandled rejection.
  abortPromise.catch(() => undefined);

  const onParentAbort = () => {
    const reason = parentSignal?.reason ?? new Error("Tool execution aborted");
    rejectAbort(reason);
    controller.abort(reason);
  };

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const timer = setTimeout(() => {
    // Settle the race BEFORE aborting the underlying work: some tools reject
    // synchronously from their abort listener, and the timeout must surface
    // as a normal result — not as a thrown tool-error.
    resolveTimeout(TOOL_TIMEOUT);
    onTimeout();
    controller.abort(
      new Error(`Tool execution timed out after ${timeoutMs}ms`),
    );
  }, timeoutMs);
  // Never keep the process alive for a deadline timer.
  timer.unref?.();

  return {
    signal: controller.signal,
    wait: <T>(promise: PromiseLike<T>) =>
      Promise.race([Promise.resolve(promise), timeoutPromise, abortPromise]),
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      "function"
  );
}

/**
 * Deadline for streaming tools: each `next()` must land within the budget.
 * On timeout the stream ends with the structured timeout payload as its
 * final value (the AI SDK uses the last yielded value as the tool output).
 */
async function* iterateWithDeadline(
  iterable: AsyncIterable<unknown>,
  guard: ExecutionGuard,
  timeoutResult: ToolTimeoutResult,
): AsyncGenerator<unknown> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await guard.wait(iterator.next());
      if (next === TOOL_TIMEOUT) {
        // Best-effort close only — never await return(): a stalled iterator
        // can hang in its cleanup too, and we'd be right back where we started.
        void Promise.resolve(iterator.return?.()).then(
          () => undefined,
          () => undefined,
        );
        yield timeoutResult;
        return;
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    guard.cleanup();
  }
}

/**
 * Wrap every executable tool in a tool set with the per-call deadline.
 * Schema, description, and all other tool properties pass through untouched,
 * so the model-facing contract is identical. Tools without `execute`
 * (provider-executed or schema-only) are returned as-is.
 */
export function withToolTimeout(
  tools: Record<string, Tool>,
  timeoutMs: number,
  onTimeout: (toolName: string) => void,
): Record<string, Tool> {
  return Object.fromEntries(
    Object.entries(tools).map(([toolName, original]) => {
      const execute = original.execute as ToolExecute | undefined;
      if (!execute) return [toolName, original];

      const wrapped = {
        ...original,
        execute: (input: unknown, options: ToolExecutionOptions) => {
          const timeoutResult = toolTimeoutResult(toolName, timeoutMs);
          const guard = createExecutionGuard(
            timeoutMs,
            options.abortSignal,
            () => onTimeout(toolName),
          );

          let execution: ReturnType<ToolExecute>;
          try {
            execution = execute(input, {
              ...options,
              abortSignal: guard.signal,
            });
          } catch (error) {
            // Synchronous throw: not a hang — let the SDK's tool-error path
            // handle it (the Agent converts that into a terminal result).
            guard.cleanup();
            throw error;
          }

          if (isAsyncIterable(execution)) {
            return iterateWithDeadline(execution, guard, timeoutResult);
          }

          return guard
            .wait(Promise.resolve(execution))
            .then((output) =>
              output === TOOL_TIMEOUT ? timeoutResult : output,
            )
            .finally(() => guard.cleanup());
        },
      } as Tool;

      return [toolName, wrapped];
    }),
  );
}
