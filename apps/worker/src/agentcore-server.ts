import { createServer, type IncomingMessage } from "node:http";
import { getRun, runProjectHeartbeat, stopBrowserSession } from "@repo/agent";
import {
  dispatchOrchestratorRun,
  dispatchSubagentRun,
  type AgentCoreInvocationPayload,
} from "@repo/queue";
import {
  isTeamLeadRun,
  processOrchestratorRun,
  processSubagentRun,
  processTeamLeadRun,
} from "./processors";

/**
 * AgentCore Runtime invocation server (loaded by the agentcore.ts bootstrap).
 *
 * Implements the AgentCore Runtime HTTP contract on port 8080:
 * - POST /invocations — receives an {@link AgentCoreInvocationPayload},
 *   acks immediately, and executes the run segment in the background, so
 *   dispatch returns once the work is accepted.
 * - GET /ping — reports HealthyBusy while segments are in flight so
 *   AgentCore keeps the session alive until background work finishes.
 *
 * Retries: there is no queue redelivery, so when a processor crash rethrows
 * (after retryOrFail reset the row to `pending`), the crash handler
 * re-dispatches the run itself with a fresh invocation. Runs whose failed
 * execution budget is exhausted were already failed terminally by
 * retryOrFail, in which case the re-dispatch claim finds nothing and drops.
 */

const PORT = Number(process.env.PORT ?? 8080);

let inFlight = 0;
let nextInvocationId = 1;
let idleSince = Date.now();
let busySince = idleSince;
const activeInvocations = new Map<
  number,
  { label: string; startedAt: number }
>();

function activeInvocationSummary(now: number = Date.now()): string {
  if (activeInvocations.size === 0) return "none";
  return [...activeInvocations.entries()]
    .slice(0, 5)
    .map(
      ([id, invocation]) =>
        `${id}:${invocation.label}:ageMs=${now - invocation.startedAt}`,
    )
    .join("|");
}

function healthSnapshot(now: number = Date.now()): {
  status: "Healthy" | "HealthyBusy";
  idleEligibleMs: number;
  oldestBusyMs: number;
} {
  const oldestStartedAt =
    activeInvocations.size > 0
      ? Math.min(
          ...[...activeInvocations.values()].map(
            (invocation) => invocation.startedAt,
          ),
        )
      : now;
  return {
    status: inFlight > 0 ? "HealthyBusy" : "Healthy",
    // AgentCore's idle timeout can only accrue while this value increases.
    idleEligibleMs: inFlight === 0 ? now - idleSince : 0,
    oldestBusyMs: inFlight > 0 ? now - oldestStartedAt : 0,
  };
}

/**
 * Liveness watchdog (diagnostic).
 *
 * Sessions have been observed dying mid-segment with their stdout tail lost,
 * which makes the failure mode ambiguous: platform teardown, a blocked event
 * loop, or silent lease failures all look identical (a log stream that just
 * stops). A periodic heartbeat line disambiguates from whatever DOES get
 * delivered:
 * - lines keep appearing with lag≈0 and then stop cold → the platform tore
 *   the session down at that timestamp;
 * - lines show growing lagMs before stopping → our event loop was starved
 *   (sync-heavy tool / native call), which also starves the lease timer;
 * - lines keep appearing but [lease] renewals fail → the DB path is the
 *   problem, not the session.
 * Only logs while work is in flight (or after an anomalous stall) to stay
 * quiet on idle sessions.
 */
const WATCHDOG_INTERVAL_MS = 15_000;
let watchdogLastTickAt = Date.now();
const watchdog = setInterval(() => {
  const now = Date.now();
  const lagMs = Math.max(now - watchdogLastTickAt - WATCHDOG_INTERVAL_MS, 0);
  watchdogLastTickAt = now;
  if (inFlight > 0 || lagMs > 1_000) {
    const health = healthSnapshot(now);
    console.log(
      `[watchdog] health=${health.status} inFlight=${inFlight} ` +
        `idleEligibleMs=${health.idleEligibleMs} ` +
        `oldestBusyMs=${health.oldestBusyMs} lagMs=${lagMs} ` +
        `uptimeS=${Math.round(process.uptime())} ` +
        `active=${activeInvocationSummary(now)}`,
    );
  }
}, WATCHDOG_INTERVAL_MS);
watchdog.unref?.();

/**
 * Ping visibility (diagnostic): log the platform's health polling — on every
 * reported status change, and at most once a minute while busy. If /ping
 * lines show us answering HealthyBusy and the session dies anyway, the
 * platform is not honoring busy; if /ping lines stop arriving while the
 * watchdog keeps ticking, the platform stopped polling this session.
 */
let lastPingStatus = "";
let lastPingLogAt = 0;
function logPing(status: string): void {
  const now = Date.now();
  if (status === lastPingStatus && now - lastPingLogAt < 60_000) return;
  lastPingStatus = status;
  lastPingLogAt = now;
  const health = healthSnapshot(now);
  console.log(
    `[ping] responded status=${status} inFlight=${inFlight} ` +
      `idleEligibleMs=${health.idleEligibleMs} ` +
      `oldestBusyMs=${health.oldestBusyMs} ` +
      `active=${activeInvocationSummary(now)}`,
  );
}

async function executeInvocation(
  payload: AgentCoreInvocationPayload,
): Promise<void> {
  if (payload.kind === "heartbeat") {
    // A project's schedule fired: start the Team Lead pulse-check turn.
    // Skips (busy lead, inactive project) are normal — the next pulse
    // catches up.
    const result = await runProjectHeartbeat(payload.projectId, (runId) =>
      dispatchOrchestratorRun({ runId, reason: "start" }),
    );
    console.log(
      `[agentcore] heartbeat project=${payload.projectId} ` +
        (result.started
          ? `started run=${result.runId}`
          : `skipped: ${result.reason}`),
    );
    return;
  }

  const { runId, reason } = payload;
  console.log(`[agentcore] ${payload.kind} run=${runId} reason=${reason}`);

  try {
    if (payload.kind === "subagent") {
      await processSubagentRun(runId);
    } else {
      // Team-lead chat turns share the orchestrator path but are plain
      // single-segment chat runs, routed by agentType.
      const row = await getRun(runId);
      if (row && isTeamLeadRun(row)) {
        await processTeamLeadRun(runId);
      } else {
        await processOrchestratorRun(runId);
      }
    }
  } catch (error) {
    // retryOrFail already reset the row to `pending` (failure budget
    // remaining) or finished it as failed (failure budget exhausted) before
    // rethrowing. Re-invoke to substitute for queue redelivery; the guarded
    // claim makes a redundant re-dispatch of a terminal run a no-op.
    console.error(
      `[agentcore] ${payload.kind} run=${runId} crashed, re-dispatching:`,
      error,
    );
    const redispatch =
      payload.kind === "subagent"
        ? dispatchSubagentRun
        : dispatchOrchestratorRun;
    await redispatch({ runId, reason: "retry" }).catch((err) => {
      console.error(`[agentcore] re-dispatch of run ${runId} failed:`, err);
    });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parsePayload(body: string): AgentCoreInvocationPayload | null {
  try {
    const parsed = JSON.parse(body) as Partial<AgentCoreInvocationPayload>;
    if (parsed.kind === "heartbeat" && typeof parsed.projectId === "string") {
      return { kind: "heartbeat", projectId: parsed.projectId };
    }
    if (
      (parsed.kind === "orchestrator" || parsed.kind === "subagent") &&
      typeof parsed.runId === "string" &&
      (parsed.reason === "start" ||
        parsed.reason === "resume" ||
        parsed.reason === "retry")
    ) {
      return { kind: parsed.kind, runId: parsed.runId, reason: parsed.reason };
    }
    return null;
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === "GET" && req.url?.startsWith("/ping")) {
      const status = inFlight > 0 ? "HealthyBusy" : "Healthy";
      const timeOfLastUpdate = inFlight > 0 ? busySince : idleSince;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status,
          time_of_last_update: Math.floor(timeOfLastUpdate / 1_000),
        }),
      );
      logPing(status);
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/invocations")) {
      const payload = parsePayload(await readBody(req));
      if (!payload) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid invocation payload" }));
        return;
      }

      // Ack immediately; the segment runs in the background while /ping
      // reports HealthyBusy. This keeps InvokeAgentRuntime callers fast (the
      // parent's spawn tool, the API) instead of holding their connection
      // open for the whole segment.
      const startedAt = Date.now();
      const invocationLabel =
        payload.kind === "heartbeat"
          ? `heartbeat project=${payload.projectId}`
          : `${payload.kind} run=${payload.runId} reason=${payload.reason}`;
      const invocationId = nextInvocationId++;
      const idleEligibleBeforeAcceptMs =
        inFlight === 0 ? startedAt - idleSince : 0;
      if (inFlight === 0) {
        busySince = startedAt;
      }
      inFlight += 1;
      activeInvocations.set(invocationId, {
        label: invocationLabel,
        startedAt,
      });
      console.log(
        `[agentcore] invocation accepted id=${invocationId} ` +
          `${invocationLabel} health=HealthyBusy inFlight=${inFlight} ` +
          `idleEligibleMs=0 ` +
          `idleEligibleBeforeAcceptMs=${idleEligibleBeforeAcceptMs} ` +
          `active=${activeInvocationSummary(startedAt)}`,
      );
      void executeInvocation(payload)
        .catch((error) => {
          console.error("[agentcore] invocation execution failed:", error);
        })
        .finally(() => {
          activeInvocations.delete(invocationId);
          inFlight -= 1;
          const settledAt = Date.now();
          if (inFlight === 0) {
            idleSince = settledAt;
          }
          const health = healthSnapshot(settledAt);
          console.log(
            `[agentcore] invocation settled id=${invocationId} ` +
              `${invocationLabel} durationMs=${settledAt - startedAt} ` +
              `health=${health.status} inFlight=${inFlight} ` +
              `idleEligibleMs=${health.idleEligibleMs} ` +
              `active=${activeInvocationSummary(settledAt)}`,
          );
          // The web-search tool's AgentCore Browser session is billed per
          // second for its whole lifetime, idle time included. Once no segment
          // is in flight nothing needs it, so release it rather than waiting
          // for its idle timer / server-side timeout.
          if (inFlight === 0) {
            void stopBrowserSession().catch(() => {});
          }
        });

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "accepted",
          ...((payload.kind === "orchestrator" ||
            payload.kind === "subagent") && { runId: payload.runId }),
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  })().catch((error) => {
    console.error("[agentcore] request handling failed:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: "Internal Server Error" }));
  });
});

server.listen(PORT, () => {
  console.log(`[agentcore] runtime server listening on :${PORT}`);
});

// AgentCore stops sessions with SIGTERM. In-flight segments that don't finish
// are recovered by the scheduled sweeper (stalled `running` rows reset to
// pending and re-dispatched), so a fast exit here is safe.
process.on("SIGTERM", () => {
  const now = Date.now();
  const health = healthSnapshot(now);
  console.log(
    `[agentcore] SIGTERM — shutting down health=${health.status} ` +
      `inFlight=${inFlight} idleEligibleMs=${health.idleEligibleMs} ` +
      `oldestBusyMs=${health.oldestBusyMs} ` +
      `lastPingStatus=${lastPingStatus || "none"} ` +
      `lastPingAgeMs=${lastPingLogAt > 0 ? now - lastPingLogAt : -1} ` +
      `active=${activeInvocationSummary(now)}`,
  );
  // Best-effort release of the shared browser session (billed while alive).
  // Its server-side timeout is the backstop if we exit first.
  void stopBrowserSession().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
});
