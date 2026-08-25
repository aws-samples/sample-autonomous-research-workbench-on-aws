import { auth } from "@repo/auth";
import {
  and,
  db,
  eq,
  project as projectTable,
  run as runTable,
  task as taskTable,
} from "@repo/database";
import { isAbortError, passthroughStream } from "./electric";

/**
 * Durable-streams read proxy.
 *
 * The browser cannot reach the durable-streams server directly: it lives in
 * the private network (`STREAMS_URL`, :4437 in dev) and its CORS is
 * incompatible with credentialed requests. So — exactly like the Electric
 * proxy in `./electric.ts` — the browser calls this authenticated route and
 * we forward to the streams server, streaming the (long-poll or SSE)
 * response body straight back.
 *
 * Only the READ path is proxied. Producers (the worker's StreamRuntime)
 * write directly to the streams server and never go through here.
 *
 * Auth model: the caller supplies `?taskId=` or `?projectId=`. Projects are
 * platform-visible — any authenticated user may watch any project's runs.
 * - `taskId`: the task must be the caller's own thread OR a project's Team
 *   Lead thread (project lead chats are readable by everyone), AND the
 *   requested run row must actually belong to it — otherwise a user could
 *   read a foreign run by pairing an accessible task id with a foreign run id.
 * - `projectId`: prospect intake runs stream against a project rather than a
 *   task and have no run row (the run id is minted per chat turn); the
 *   project only needs to exist.
 */

/** Stream protocol headers the browser client reads; must be CORS-exposed. */
export const STREAMS_EXPOSE_HEADERS = [
  "stream-next-offset",
  "stream-cursor",
  "stream-up-to-date",
  "stream-closed",
  "etag",
];

function getStreamsBaseUrl(): string {
  const url = process.env.STREAMS_URL;
  if (!url) {
    throw new Error("STREAMS_URL is not configured");
  }
  return url.replace(/\/$/, "");
}

const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * Proxy a single run's durable stream read. `streamId` is the full last path
 * segment, i.e. `run-{runId}`; we strip the `run-` prefix to recover the run
 * id for the ownership check and forward the segment verbatim upstream. The
 * incoming query string (`offset`, `live`, `cursor`) is forwarded as-is.
 */
export async function proxyStream(
  request: Request,
  streamId: string,
): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Only run streams are proxied; the path is `/v1/stream/run-{runId}`.
  if (!streamId.startsWith("run-")) {
    return new Response("Not found", { status: 404 });
  }
  const runId = streamId.slice("run-".length);

  const requestUrl = new URL(request.url);
  const taskId = requestUrl.searchParams.get("taskId");
  const projectId = requestUrl.searchParams.get("projectId");

  if (taskId) {
    if (!UUID_RE.test(taskId)) {
      return new Response("Missing taskId", { status: 400 });
    }
    const taskRow = await db.query.task.findFirst({
      where: eq(taskTable.id, taskId),
      columns: { id: true, userId: true },
    });
    if (!taskRow) {
      return new Response("Forbidden", { status: 403 });
    }
    // Personal task threads stay private to their creator; a project's Team
    // Lead thread is readable by anyone (projects are platform-visible).
    if (taskRow.userId !== session.user.id) {
      const leadProject = await db.query.project.findFirst({
        where: eq(projectTable.leadTaskId, taskId),
        columns: { id: true },
      });
      if (!leadProject) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    // Verify the run belongs to this task. Task runs live in `run`
    // (orchestrator runs; uuid ids) — a malformed uuid must not reach the
    // uuid column or Postgres throws. Closes the cross-task IDOR where a
    // user pairs their own task id with someone else's run id.
    if (!UUID_RE.test(runId)) {
      return new Response("Forbidden", { status: 403 });
    }
    const runRow = await db.query.run.findFirst({
      where: and(eq(runTable.id, runId), eq(runTable.taskId, taskId)),
      columns: { id: true },
    });
    if (!runRow) {
      return new Response("Forbidden", { status: 403 });
    }
  } else if (projectId) {
    // Project-scoped runs: persona-agent orchestrator runs (run rows with a
    // projectId and no taskId) and prospect intake runs (no run row at all —
    // the run id is minted per chat turn). Projects are platform-visible, so
    // the project only needs to exist.
    if (!UUID_RE.test(projectId)) {
      return new Response("Missing projectId", { status: 400 });
    }
    const exists = await db.query.project.findFirst({
      where: eq(projectTable.id, projectId),
      columns: { id: true },
    });
    if (!exists) {
      return new Response("Forbidden", { status: 403 });
    }

    // If a run row exists it must belong to this project — otherwise anyone
    // could read an unrelated run by pairing a valid project id with a
    // foreign run id (same IDOR the taskId branch closes). Runs
    // without a row (prospect chat turns) pass on project ownership alone.
    if (UUID_RE.test(runId)) {
      const runRow = await db.query.run.findFirst({
        where: eq(runTable.id, runId),
        columns: { projectId: true },
      });
      if (runRow && runRow.projectId !== projectId) {
        return new Response("Forbidden", { status: 403 });
      }
    } else {
      // Non-uuid run ids never have project-scoped run rows; reject them.
      return new Response("Forbidden", { status: 403 });
    }
  } else {
    return new Response("Missing taskId or projectId", { status: 400 });
  }

  const originUrl = new URL(`${getStreamsBaseUrl()}/v1/stream/${streamId}`);
  // Forward the stream protocol params (offset/live/cursor). `taskId` and
  // `projectId` are ours for authorization and are not part of the streams
  // protocol, so drop them.
  requestUrl.searchParams.forEach((value, key) => {
    if (key !== "taskId" && key !== "projectId") {
      originUrl.searchParams.set(key, value);
    }
  });

  let response: Response;
  try {
    response = await fetch(originUrl, {
      method: request.method,
      // Propagate cancellation so closing the browser tab / unmounting tears
      // down the upstream long-poll or SSE connection instead of leaking it.
      signal: request.signal,
    });
  } catch (error) {
    // The client closing a long-poll/SSE connection aborts the upstream
    // fetch. Expected for streaming proxies — swallow it instead of logging.
    if (request.signal.aborted || isAbortError(error)) {
      return new Response(null, { status: 499 });
    }
    throw error;
  }

  const origin = request.headers.get("origin") ?? "http://localhost:3000";

  const headers = new Headers(response.headers);
  headers.set(
    "access-control-expose-headers",
    STREAMS_EXPOSE_HEADERS.join(", "),
  );
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  // Strip hop-by-hop encoding headers so the re-streamed body isn't
  // mis-decoded.
  headers.delete("content-encoding");
  headers.delete("content-length");

  return new Response(passthroughStream(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
