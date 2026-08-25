import { cors } from "@elysiajs/cors";
import { auth } from "@repo/auth";
import { router } from "@repo/orpc";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Elysia } from "elysia";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ELECTRIC_EXPOSE_HEADERS,
  proxyShape,
  resolveShapeKey,
} from "./electric";
import {
  logger,
  orpcLogger,
  requestLogger,
  serializeSafeError,
} from "./logger";
import { proxyStream, STREAMS_EXPOSE_HEADERS } from "./streams";
import { proxyProjectSync } from "./sync";

const PUBLIC_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
);

const port = Number(process.env.PORT ?? 4000);

// ── oRPC Handlers ──────────────────────────────────────────────────────────

const rpcHandler = new RPCHandler(router, {
  rootInterceptors: [requestLogger],
});

const openAPIHandler = new OpenAPIHandler(router, {
  rootInterceptors: [requestLogger],
});

const openAPIGenerator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

// ── Scalar API Reference HTML ──────────────────────────────────────────────

const scalarHTML = `<!doctype html>
<html>
  <head>
    <title>Autonomous Research Workbench: API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/x-icon" href="/favicon.ico" />
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', {
        url: '/api/spec.json',
        showSidebar: true,
        showToolbar: "never",
        hideClientButton: true,
      })
    </script>
  </body>
</html>`;

const app = new Elysia()
  .onError(({ error, code }) => {
    const name = (error as { name?: string })?.name;
    if (code === "PARSE" || name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    logger.error(
      { error: serializeSafeError(error), code },
      "Unhandled API error",
    );
  })
  .use(
    cors({
      origin: process.env.TRUSTED_ORIGINS?.split(",") ?? [
        "http://localhost:3000",
      ],
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization"],
      // Electric shape + durable-stream protocol headers must be readable by
      // the browser clients.
      exposeHeaders: [...ELECTRIC_EXPOSE_HEADERS, ...STREAMS_EXPOSE_HEADERS],
    }),
  )

  // ── Electric SQL shape sync proxy ────────────────────────────────────────
  .get(
    "/sync/:shape",
    async ({ request, params }) => {
      const shapeKey = resolveShapeKey(params.shape);
      if (!shapeKey) {
        return new Response("Unknown shape", { status: 404 });
      }
      return proxyShape(request, shapeKey);
    },
    { parse: "none" },
  )

  // ── Durable-streams read proxy ───────────────────────────────────────────
  // Live agent run deltas. `/v1/stream/run-{runId}?taskId=...` is authenticated
  // and authorized against task ownership, then forwarded to the streams server.
  .get(
    "/v1/stream/:streamId",
    async ({ request, params }) => {
      return proxyStream(request, params.streamId);
    },
    { parse: "none" },
  )

  // ── Better Auth ──────────────────────────────────────────────────────────
  .all(
    "/api/auth/*",
    async ({ request }) => {
      return auth.handler(request);
    },
    { parse: "none" },
  )

  // ── Electric SQL sync proxy ────────────────────────────────────────────────
  // Live project-row updates. `/sync/project/:projectId` is authenticated and
  // authorized against project ownership, then forwarded to Electric as a shape
  // scoped to that single row.
  .all(
    "/sync/project/:projectId",
    ({ request, params: { projectId } }) =>
      proxyProjectSync(request, projectId),
    { parse: "none" },
  )

  // ── oRPC (type-safe RPC) ───────────────────────────────────────────────────
  .all(
    "/rpc/*",
    async ({ request }) => {
      const { response } = await rpcHandler.handle(request, {
        prefix: "/rpc",
        context: { headers: request.headers, logger: orpcLogger },
      });

      return response ?? new Response("Not Found", { status: 404 });
    },
    { parse: "none" },
  )

  // ── OpenAPI spec (JSON) ────────────────────────────────────────────────────
  .get("/api/spec.json", async () => {
    const spec = await openAPIGenerator.generate(router, {
      info: {
        title: "Autonomous Research Workbench",
        description: "API for the Autonomous Research Workbench platform",
        version: "0.0.1",
      },
      servers: [{ url: "/api" }],
      components: {},
    });

    return new Response(JSON.stringify(spec), {
      headers: { "Content-Type": "application/json" },
    });
  })

  // ── Scalar API Reference UI ────────────────────────────────────────────────
  .get("/api", () => {
    return new Response(scalarHTML, {
      headers: { "Content-Type": "text/html" },
    });
  })

  // ── Static favicon ─────────────────────────────────────────────────────────
  .get("/favicon.ico", () => {
    return new Response(Bun.file(join(PUBLIC_DIR, "favicon.ico")), {
      headers: {
        "Content-Type": "image/x-icon",
        "Cache-Control": "public, max-age=86400",
      },
    });
  })

  // ── OpenAPI handler (REST-style routes) ────────────────────────────────────
  .all(
    "/api/*",
    async ({ request }) => {
      const { response } = await openAPIHandler.handle(request, {
        prefix: "/api",
        context: { headers: request.headers, logger: orpcLogger },
      });

      return response ?? new Response("Not Found", { status: 404 });
    },
    { parse: "none" },
  )

  .get("/", () => "Hello from @workbench/api")
  .listen(port);

logger.info(`API running at http://localhost:${port}`);
