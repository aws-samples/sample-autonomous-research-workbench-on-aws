/**
 * Cooperative stop signal for agent runs.
 *
 * A background poller invokes `check()` on an interval and aborts the run's
 * AbortController when it reports true, halting the LLM stream mid-turn
 * instead of letting the segment run to completion. The check is injected so
 * this stays storage-agnostic — the worker wires it to the `run` row's
 * status (`cancelled` = stop), which `cancelRunTree` already flips.
 */

export type StopSignalConfig = {
  /** Returns true when the run should stop. Polled in the background. */
  check: () => Promise<boolean>;
  /** Polling interval in milliseconds (default: 2000). */
  pollIntervalMs?: number;
};

export type StopSignalPoller = {
  /** Stop the background poller (call when the run ends). */
  cleanup: () => void;
};

export function createStopSignalPoller(options: {
  config: StopSignalConfig;
  abortController: AbortController;
  onStop?: () => void;
}): StopSignalPoller {
  const { config, abortController, onStop } = options;
  const pollIntervalMs = config.pollIntervalMs ?? 2_000;

  let isPolling = true;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const poll = async () => {
    while (isPolling && !abortController.signal.aborted) {
      try {
        if (await config.check()) {
          onStop?.();
          abortController.abort(new Error("Run stopped by user"));
          break;
        }
      } catch {
        // A failing check must never kill the run; try again next tick.
      }
      await new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, pollIntervalMs);
      });
    }
  };

  void poll();

  return {
    cleanup: () => {
      isPolling = false;
      if (timeoutId) clearTimeout(timeoutId);
    },
  };
}
