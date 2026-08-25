/**
 * Execution lease for a claimed run.
 *
 * The stalled-run sweeper decides an executor is dead when the `run` row has
 * not been touched for a while. Nothing in a working segment touches that row
 * — findings go to the knowledge graph, the transcript to `run_message`,
 * progress to `run_event`, and usage counters only land when the segment ends
 * — so liveness has to be asserted on a timer. A run that stops renewing has
 * really lost its executor, which is what makes the sweeper's verdict
 * trustworthy (and lets its window be much tighter than the longest segment).
 *
 * Narrow subpath import: this module is reachable from the sweep Lambda
 * bundle, which must not pull in the @repo/agent barrel (native deps).
 */
import { renewRunLease } from "@repo/agent/orchestration/store";

/** How often an executing run renews its lease. */
export const LEASE_RENEW_INTERVAL_MS = 60_000;

export type RunLease = {
  /** Stop renewing. Safe to call more than once. */
  stop: () => void;
};

/**
 * Start renewing `runId`'s lease until `stop()` is called or the run leaves
 * the executing statuses (terminal, or yielded to `waiting_on_children`).
 *
 * Renewal failures are swallowed: the next tick retries, and the sweeper only
 * acts after several consecutive misses, so a transient database blip cannot
 * kill a healthy run.
 */
export function startRunLease(
  runId: string,
  intervalMs: number = LEASE_RENEW_INTERVAL_MS,
): RunLease {
  const label = runId.slice(0, 8);
  let stopped = false;
  // Guards against overlapping renewals if a round-trip outlives the interval.
  let renewing = false;
  // Diagnostic: when the previous tick fired. A tick arriving much later than
  // `intervalMs` after the last one means the event loop was starved — the
  // prime suspect when the sweeper declares an executor dead while its
  // container is still up (lease misses without a crash).
  let lastTickAt = Date.now();

  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
  };

  const timer = setInterval(() => {
    if (stopped || renewing) return;
    const now = Date.now();
    const driftMs = now - lastTickAt - intervalMs;
    lastTickAt = now;
    if (driftMs > 5_000) {
      console.warn(
        `[lease] run ${label} tick fired ${driftMs}ms late — event loop was blocked`,
      );
    }
    renewing = true;
    const startedAt = Date.now();
    void renewRunLease(runId)
      .then((held) => {
        // Log every outcome: the sweeper's verdict is built on these renewals,
        // so the trail of "renewed" lines is the executor's liveness record —
        // the last one delivered timestamps when this process really stopped.
        console.log(
          `[lease] run ${label} renewed held=${held} inMs=${Date.now() - startedAt}`,
        );
        if (held || stopped) return;
        // The row is no longer ours to keep alive. Aborting the in-flight
        // work is the cooperative stop signal's job, not the lease's.
        console.warn(
          `[lease] run ${label} is no longer executing — stopping renewal`,
        );
        stop();
      })
      .catch((error) => {
        console.warn(
          `[lease] renewal FAILED for run ${label} afterMs=${Date.now() - startedAt}:`,
          error,
        );
      })
      .finally(() => {
        renewing = false;
      });
  }, intervalMs);
  // Never keep the process (or an AgentCore session) alive for a lease.
  timer.unref?.();

  return { stop };
}
