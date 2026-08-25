/**
 * Bedrock AgentCore invoke client.
 *
 * On the `agentcore` substrate, "enqueueing" a run means calling
 * InvokeAgentRuntime on the platform's AgentCore Runtime with a small JSON
 * payload pointing at the `run` row. The runtime container (the worker's
 * agentcore entrypoint) acks immediately and executes the run segment in the
 * background — dispatch returns once the
 * work is accepted, and Postgres remains the source of truth.
 */
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type { AgentCoreInvocationPayload } from "./jobs";

let cachedClient: BedrockAgentCoreClient | null = null;

function getClient(): BedrockAgentCoreClient {
  cachedClient ??= new BedrockAgentCoreClient({
    customUserAgent: process.env.USER_AGENT_STRING,
  });
  return cachedClient;
}

/**
 * ARN of the shared AgentCore Runtime that executes run segments not owned
 * by a project runtime. Set directly on the API service; inside the runtime
 * container itself it is resolved from SSM at boot (the runtime cannot
 * reference its own ARN in its env vars).
 */
export function getAgentCoreRuntimeArn(): string {
  const arn = process.env.AGENTCORE_RUNTIME_ARN;
  if (!arn) {
    throw new Error(
      "AGENTCORE_RUNTIME_ARN must be set (or AGENTCORE_LOCAL_URL for local dev).",
    );
  }
  return arn;
}

/**
 * Resolve the runtime a run executes on: the run's project runtime (the
 * worker image with the project's S3 Files access point mounted) when the
 * project has one, otherwise the shared platform runtime.
 *
 * The DB import is dynamic so this module stays side-effect-free at load —
 * the worker's boot sequence resolves DB credentials into process.env
 * before anything touching @repo/database is allowed to load.
 */
async function resolveRuntimeArn(runId: string): Promise<string> {
  const { db, eq, run } = await import("@repo/database");
  const row = await db.query.run.findFirst({
    where: eq(run.id, runId),
    columns: { id: true },
    with: { project: { columns: { agentRuntimeArn: true } } },
  });
  return row?.project?.agentRuntimeArn ?? getAgentCoreRuntimeArn();
}

/**
 * Local dev: POST the payload straight to a locally running agentcore server
 * (apps/worker `pnpm dev`) — same invocation contract, no AWS involved.
 */
async function invokeLocal(
  baseUrl: string,
  payload: AgentCoreInvocationPayload,
): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/invocations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(
      `Local agentcore dispatch failed (${response.status}): ${await response
        .text()
        .catch(() => "")}`,
    );
  }
}

/**
 * Send InvokeAgentRuntime, retrying the brief provisioning/teardown window.
 *
 * Reusing a session ID across a run's segments makes a documented race
 * reachable: while AgentCore provisions or tears down the session's compute,
 * a second operation on that session returns a retryable 409
 * (RetryableConflictException, surfaced by the SDK as ConflictException).
 * The window is short, so a few short exponential backoffs cover it; anything
 * still failing after that propagates to the caller's normal retry path.
 */
async function invokeWithConflictRetry(args: {
  agentRuntimeArn: string;
  runtimeSessionId: string;
  payload: AgentCoreInvocationPayload;
}) {
  const delaysMs = [250, 1_000, 3_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await getClient().send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: args.agentRuntimeArn,
          runtimeSessionId: args.runtimeSessionId,
          contentType: "application/json",
          accept: "application/json",
          payload: new TextEncoder().encode(JSON.stringify(args.payload)),
        }),
      );
    } catch (error) {
      const isRetryableConflict =
        error instanceof Error && error.name === "ConflictException";
      if (!isRetryableConflict || attempt >= delaysMs.length) throw error;
      const delayMs = delaysMs[attempt] ?? 3_000;
      console.log(
        `[dispatch] session ${args.runtimeSessionId} busy provisioning ` +
          `(409), retrying in ${delayMs}ms (attempt ${attempt + 1})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Invoke the AgentCore Runtime with a run pointer.
 *
 * Run payloads execute on their project's runtime when the project has one
 * (project-scoped S3 Files mount); everything else — projectless runs,
 * heartbeats — goes to the shared platform runtime.
 *
 * Session identity: only "start" payloads key their runtimeSessionId on the
 * runId; every other invocation gets a fresh random session. Distinct runs
 * (including each spawned subagent) get distinct sessions, which is what
 * lets them execute in parallel: AgentCore serializes invocations that share
 * a session onto one microVM. A run's session carries no state we depend on
 * (checkpoint + transcript live in Postgres), so any segment can run on
 * fresh compute.
 *
 * Resumes deliberately do NOT reuse the run's session ID. A resume fires
 * when the last in-flight child settles, i.e. an unpredictable time after
 * the parent's previous segment went idle — which races the session's idle
 * teardown. Observed on 2026-08-06: a resume dispatched 13s after the
 * session's 300s idle boundary got a 202 from the platform but was never
 * delivered to a container, and the run sat pending until the sweeper's
 * retry ~14 minutes later. A fresh session ID always provisions clean
 * compute (a few seconds of cold start) instead of racing teardown; the
 * marginal cost is at most one extra idle tail per resume.
 *
 * Retries also use a random session: a sweeper retry means the lease
 * expired, so the run's previous container may be wedged but still alive —
 * re-keying on runId would route the retry straight back onto the wedged
 * microVM. Heartbeats carry no runId.
 */
export async function invokeAgentCoreRuntime(
  payload: AgentCoreInvocationPayload,
): Promise<void> {
  const localUrl = process.env.AGENTCORE_LOCAL_URL;
  if (localUrl) {
    await invokeLocal(localUrl, payload);
    return;
  }

  // Heartbeats carry no run yet — they execute on the shared platform
  // runtime (the lead run a heartbeat creates is then dispatched normally,
  // landing on the project's runtime when it has one).
  const agentRuntimeArn =
    payload.kind === "heartbeat"
      ? getAgentCoreRuntimeArn()
      : await resolveRuntimeArn(payload.runId);

  // runId is a 36-char UUID, satisfying AgentCore's 33-char session ID
  // minimum.
  const runtimeSessionId =
    payload.kind !== "heartbeat" && payload.reason === "start"
      ? payload.runId
      : crypto.randomUUID();
  const response = await invokeWithConflictRetry({
    agentRuntimeArn,
    runtimeSessionId,
    payload,
  });

  // The runtime replies with a small JSON ack and keeps working in the
  // background. Drain the body so the HTTP connection is released.
  const body = response.response
    ? await response.response.transformToString()
    : "";

  const label =
    payload.kind === "heartbeat"
      ? `heartbeat project=${payload.projectId}`
      : `${payload.kind} run=${payload.runId} reason=${payload.reason}`;

  // A non-2xx here means the runtime rejected or failed the invocation —
  // previously discarded, which made a dead dispatch indistinguishable from
  // a successful one (the run just sat in `pending` until the sweeper's
  // patient window). Throw so callers' retry paths see it.
  if (response.statusCode !== undefined && response.statusCode >= 300) {
    throw new Error(
      `InvokeAgentRuntime returned ${response.statusCode} for ${label} ` +
        `(session ${runtimeSessionId}): ${body.slice(0, 500)}`,
    );
  }

  // Correlate the dispatch with the AgentCore session so a run's death can be
  // traced to its session's log stream and platform-side session lifecycle.
  console.log(
    `[dispatch] ${label} accepted status=${response.statusCode ?? "?"} ` +
      `session=${runtimeSessionId} runtime=${agentRuntimeArn.split("/").pop()}`,
  );
}
