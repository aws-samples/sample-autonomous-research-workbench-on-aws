import { ELECTRIC_PROTOCOL_QUERY_PARAMS } from "@electric-sql/client";
import { auth } from "@repo/auth";
import {
  db,
  eq,
  project as projectTable,
  task as taskTable,
} from "@repo/database";

/**
 * Electric shape proxy.
 *
 * Electric runs behind this authenticated proxy: the browser's TanStack DB
 * collection requests `GET /sync/:shape`, we authenticate the session and
 * scope the shape server-side, then forward to Electric's
 * `GET {ELECTRIC_URL}/v1/shape` HTTP API and stream the response back.
 *
 * Writes do NOT go through here; they use oRPC and sync back via Electric.
 */

/** Headers Electric uses for its streaming protocol; must be CORS-exposed. */
export const ELECTRIC_EXPOSE_HEADERS = [
  "electric-offset",
  "electric-handle",
  "electric-schema",
  "electric-cursor",
];

/**
 * How a shape is scoped. Projects are platform-visible: any authenticated
 * user may view any project, so scoping only picks the rows, not the viewer.
 * - `global` shapes expose all rows to any authenticated user (no params).
 * - `project` shapes filter to a client-supplied projectId (existence-checked).
 * - `task` shapes filter to a client-supplied taskId (owner or project lead
 *   thread — personal task threads stay private to their creator).
 */
type ScopeType = "global" | "project" | "task";

interface ShapeDefinition {
  table: string;
  columns: string[];
  scope: ScopeType;
  /** Optional server-pinned filter; omitted for unfiltered global shapes. */
  where?: string;
}

export type ShapeKey =
  | "projects"
  | "projectAgents"
  | "projectRuns"
  | "taskMessages";

/** Quote a Postgres identifier so camelCase column names survive. */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

const SHAPES: Record<ShapeKey, ShapeDefinition> = {
  // All projects, for the sidebar list — visible to every signed-in user.
  projects: {
    table: quoteIdentifier("project"),
    columns: [
      "id",
      "name",
      "status",
      quoteIdentifier("ownerId"),
      quoteIdentifier("createdAt"),
      quoteIdentifier("updatedAt"),
    ],
    scope: "global",
  },
  // Live roster state: one row per persona agent on the project.
  projectAgents: {
    table: quoteIdentifier("project_agent"),
    columns: [
      "id",
      quoteIdentifier("projectId"),
      quoteIdentifier("agentId"),
      "state",
      quoteIdentifier("activeRunId"),
      quoteIdentifier("lastResult"),
      quoteIdentifier("stateUpdatedAt"),
      quoteIdentifier("createdAt"),
    ],
    scope: "project",
    where: `${quoteIdentifier("projectId")} = $1`,
  },
  // The project's run activity (roots + descendants) for progress views.
  projectRuns: {
    table: quoteIdentifier("run"),
    columns: [
      "id",
      quoteIdentifier("parentRunId"),
      quoteIdentifier("rootRunId"),
      quoteIdentifier("agentType"),
      "status",
      // The TaskSpec brief. Synced so sub-agent runs can be listed by their
      // plan-task title (input.title) in the agent activity view.
      "input",
      quoteIdentifier("projectId"),
      quoteIdentifier("createdAt"),
      quoteIdentifier("startedAt"),
      quoteIdentifier("finishedAt"),
    ],
    scope: "project",
    where: `${quoteIdentifier("projectId")} = $1`,
  },
  // Chat messages of a task thread (the Team Lead chat).
  taskMessages: {
    table: quoteIdentifier("task_message"),
    columns: [
      "id",
      "role",
      "content",
      "metadata",
      quoteIdentifier("taskId"),
      quoteIdentifier("createdAt"),
    ],
    scope: "task",
    where: `${quoteIdentifier("taskId")} = $1`,
  },
};

export function resolveShapeKey(shape: string): ShapeKey | null {
  // hasOwn, not `in`: prototype names like "toString" must not resolve.
  return Object.hasOwn(SHAPES, shape) ? (shape as ShapeKey) : null;
}

function serializeColumns(columns: string[]): string {
  return columns.join(",");
}

function getElectricShapeUrl(): URL {
  const configuredUrl = process.env.ELECTRIC_URL;
  if (!configuredUrl) {
    throw new Error("ELECTRIC_URL is not configured");
  }
  const url = new URL(configuredUrl);
  if (url.pathname.endsWith("/v1/shape")) {
    return url;
  }
  return new URL("/v1/shape", url);
}

const TRUSTED_ORIGINS = new Set(
  (process.env.TRUSTED_ORIGINS?.split(",") ?? ["http://localhost:3000"]).map(
    (o) => o.trim(),
  ),
);

/**
 * Set CORS headers explicitly on the proxied response so the browser can read
 * Electric's protocol headers (offset/handle/schema/cursor) on a credentialed
 * request. We overwrite Electric's own CORS headers (it sends `*`, which the
 * browser rejects with credentials) and echo the request origin — but only
 * when it is in the TRUSTED_ORIGINS allowlist, matching the cors plugin's
 * policy on every other route (reflecting arbitrary origins with credentials
 * would silently become a cross-site read hole under SameSite=None cookies).
 * Also strip hop-by-hop encoding headers so the re-streamed body isn't
 * mis-decoded.
 */
function withExposedElectricHeaders(
  headers: Headers,
  origin: string | null,
): Headers {
  headers.set(
    "Access-Control-Expose-Headers",
    ELECTRIC_EXPOSE_HEADERS.join(", "),
  );
  headers.delete("Access-Control-Allow-Origin");
  headers.delete("Access-Control-Allow-Credentials");
  if (origin && TRUSTED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  headers.delete("content-encoding");
  headers.delete("content-length");
  return headers;
}

export const isAbortError = (error: unknown): boolean => {
  const name = (error as { name?: string } | null)?.name;
  const code = (error as { code?: number } | null)?.code;
  return name === "AbortError" || code === 20;
};

/**
 * Re-stream an upstream body without letting a mid-stream client disconnect
 * escape as an unhandled error. Bun aborts the in-flight pipe when the
 * browser closes a long-poll connection; driving the copy ourselves lets us
 * swallow that one case instead of crashing the watcher with a DOMException.
 * (Shared with the durable-streams proxy in ./streams.ts.)
 */
export function passthroughStream(
  body: ReadableStream<Uint8Array> | null,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;

  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        if (isAbortError(error)) {
          controller.close();
          return;
        }
        controller.error(error);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

export async function proxyShape(
  request: Request,
  shapeKey: ShapeKey,
): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const shape = SHAPES[shapeKey];
  const requestUrl = new URL(request.url);

  // Resolve the where-clause parameter and authorize the scope. Projects are
  // platform-visible, so authorization only requires a valid session plus,
  // for scoped shapes, that the target row exists (and for tasks, that the
  // thread is either the caller's own or a project's lead thread).
  let paramValue: string | null = null;
  if (shape.scope === "project") {
    const projectId = requestUrl.searchParams.get("projectId");
    if (!projectId) {
      return new Response("Missing projectId", { status: 400 });
    }
    const exists = await db.query.project.findFirst({
      where: eq(projectTable.id, projectId),
      columns: { id: true },
    });
    if (!exists) {
      return new Response("Not found", { status: 404 });
    }
    paramValue = projectId;
  } else if (shape.scope === "task") {
    const taskId = requestUrl.searchParams.get("taskId");
    if (!taskId) {
      return new Response("Missing taskId", { status: 400 });
    }
    const taskRow = await db.query.task.findFirst({
      where: eq(taskTable.id, taskId),
      columns: { id: true, userId: true },
    });
    if (!taskRow) {
      return new Response("Forbidden", { status: 403 });
    }
    // Personal task threads stay private; a project's Team Lead thread is
    // readable by anyone since projects are platform-visible.
    if (taskRow.userId !== session.user.id) {
      const leadProject = await db.query.project.findFirst({
        where: eq(projectTable.leadTaskId, taskId),
        columns: { id: true },
      });
      if (!leadProject) {
        return new Response("Forbidden", { status: 403 });
      }
    }
    paramValue = taskId;
  }

  const originUrl = getElectricShapeUrl();
  requestUrl.searchParams.forEach((value, key) => {
    if (ELECTRIC_PROTOCOL_QUERY_PARAMS.includes(key)) {
      originUrl.searchParams.set(key, value);
    }
  });

  originUrl.searchParams.set("table", shape.table);
  if (shape.where) {
    originUrl.searchParams.set("where", shape.where);
  }
  originUrl.searchParams.set("columns", serializeColumns(shape.columns));
  if (paramValue !== null) {
    originUrl.searchParams.set("params[1]", paramValue);
  }

  // Electric Cloud auth (only when configured; local dev uses ELECTRIC_INSECURE).
  if (process.env.ELECTRIC_SOURCE_ID && process.env.ELECTRIC_SECRET) {
    originUrl.searchParams.set("source_id", process.env.ELECTRIC_SOURCE_ID);
    originUrl.searchParams.set("secret", process.env.ELECTRIC_SECRET);
  }

  let response: Response;
  try {
    response = await fetch(originUrl, {
      method: request.method,
      signal: request.signal,
    });
  } catch (error) {
    // The client closing a live shape subscription aborts the upstream fetch.
    // Expected for streaming proxies — swallow it instead of logging.
    if (request.signal.aborted || isAbortError(error)) {
      return new Response(null, { status: 499 });
    }
    throw error;
  }

  const origin = request.headers.get("origin");

  return new Response(passthroughStream(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers: withExposedElectricHeaders(new Headers(response.headers), origin),
  });
}
