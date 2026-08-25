/**
 * Scheduled stalled-run sweep — Lambda entrypoint.
 *
 * Runs sweepStalledRuns() directly against Postgres instead of invoking the
 * AgentCore runtime with a `sweep` payload. Two reasons this lives OUTSIDE
 * the run substrate it recovers:
 *
 * - Independence: crash recovery must not share a failure domain with the
 *   thing it monitors. A runtime that cannot boot (bad image pull) or hangs
 *   (wedged DB pool) previously took its own sweeper down with it.
 * - Cost: each sweep invocation used to mint a fresh AgentCore session (a
 *   warm microVM billed for memory until reaped — or until the 8h max
 *   lifetime when the sweep hung and kept /ping reporting HealthyBusy).
 *   A Lambda tick is a few hundred milliseconds of compute, and its timeout
 *   doubles as the watchdog the runtime path never had.
 *
 * Bundling: this file is the esbuild entry for the infra NodejsFunction. It
 * must only (transitively) import the narrow @repo/agent subpaths — the
 * barrel pulls in @lancedb/lancedb, a native module that cannot ship in a
 * Lambda bundle. The dynamic import below also keeps module-load order
 * correct: the pg Pool reads its connection string when @repo/database
 * loads, so the Secrets Manager credentials must land in process.env first.
 */
import { resolveDbCredentials } from "./bootstrap";

export async function handler(): Promise<void> {
  await resolveDbCredentials();

  const { sweepStalledRuns } = await import("./sweeper");
  await sweepStalledRuns();
}
