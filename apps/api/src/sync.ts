import { auth } from "@repo/auth";
import { db, eq, project as projectTable } from "@repo/database";

import { passthroughStream } from "./electric";

/**
 * Electric SQL shape proxy.
 *
 * The browser can't reach Electric directly (it lives on the private network),
 * and we don't want clients choosing arbitrary tables/filters. So the browser
 * subscribes through this authenticated route and we forward a server-scoped
 * shape request to Electric, re-streaming the (long-poll) response back.
 *
 * Projects are platform-visible: any authenticated user may subscribe to any
 * project's row. We still pin `table=project` and `where "id" = $1`
 * server-side so the client can't widen the shape. The client only supplies
 * Electric's cursor params (offset, handle, live, cursor) which we pass
 * through verbatim.
 */

/** Electric protocol headers the client's ShapeStream reads; must be exposed. */
export const ELECTRIC_EXPOSE_HEADERS = [
  "electric-offset",
  "electric-handle",
  "electric-schema",
  "electric-cursor",
  "electric-up-to-date",
];

// Electric's own cursor/control params. Everything else the client sends is
// ignored — table and where are fixed server-side.
const FORWARDED_PARAMS = ["offset", "handle", "live", "cursor", "replica"];

function getElectricBaseUrl(): string {
  const url = process.env.ELECTRIC_URL ?? "http://localhost:3010";
  return url.replace(/\/$/, "");
}

/**
 * Proxy a live subscription to a single project's row. `projectId` is the last
 * path segment; any authenticated user may subscribe (projects are
 * platform-visible), so we only verify the project exists before forwarding a
 * shape request scoped to that row.
 */
export async function proxyProjectSync(
  request: Request,
  projectId: string,
): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const exists = await db.query.project.findFirst({
    where: eq(projectTable.id, projectId),
    columns: { id: true },
  });
  if (!exists) {
    return new Response("Not found", { status: 404 });
  }

  const requestUrl = new URL(request.url);
  const originUrl = new URL(`${getElectricBaseUrl()}/v1/shape`);
  // Server-pinned shape definition — the client cannot widen it.
  originUrl.searchParams.set("table", "project");
  originUrl.searchParams.set("where", `"id" = $1`);
  originUrl.searchParams.set("params[1]", projectId);
  for (const key of FORWARDED_PARAMS) {
    const value = requestUrl.searchParams.get(key);
    if (value !== null) originUrl.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(originUrl, {
      method: "GET",
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted || (error as Error)?.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    throw error;
  }

  const origin = request.headers.get("origin") ?? "http://localhost:3000";

  const headers = new Headers(response.headers);
  headers.set(
    "access-control-expose-headers",
    ELECTRIC_EXPOSE_HEADERS.join(", "),
  );
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.delete("content-encoding");
  headers.delete("content-length");

  return new Response(passthroughStream(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
