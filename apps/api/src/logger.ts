import type {
  StandardHandlerInterceptorOptions,
  StandardHandleResult,
} from "@orpc/server/standard";
import type { ContextLogger, InitialContext } from "@repo/orpc/context";
import type { Logger } from "pino";
import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

const SAFE_ERROR_METADATA = [
  "code",
  "schema",
  "table",
  "column",
  "constraint",
  "routine",
  "severity",
] as const;

/**
 * Drizzle query errors include a `params:` line containing user input. Keep
 * the query shape, database diagnostics, and call frames while dropping those
 * values and other enumerable driver fields (for example PostgreSQL `detail`).
 */
export function serializeSafeError(
  error: unknown,
  depth = 0,
): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { type: "NonError", message: "A non-Error value was thrown" };
  }

  const errorWithMetadata = error as Error &
    Record<(typeof SAFE_ERROR_METADATA)[number], unknown> & {
      cause?: unknown;
    };
  const paramsIndex = error.message.indexOf("\nparams:");
  const message =
    paramsIndex === -1
      ? error.message
      : `${error.message.slice(0, paramsIndex)}\nparams: [redacted]`;
  const stackFrames = error.stack
    ?.split("\n")
    .filter((line) => /^\s+at\s/.test(line));
  const serialized: Record<string, unknown> = {
    type: error.name,
    message,
    ...(stackFrames?.length
      ? {
          stack: `${error.name}: ${message.split("\n", 1)[0]}\n${stackFrames.join("\n")}`,
        }
      : {}),
  };

  for (const key of SAFE_ERROR_METADATA) {
    const value = errorWithMetadata[key];
    if (typeof value === "string" || typeof value === "number") {
      serialized[key] = value;
    }
  }

  if (errorWithMetadata.cause !== undefined && depth < 3) {
    serialized.cause = serializeSafeError(errorWithMetadata.cause, depth + 1);
  }

  return serialized;
}

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss",
          ignore: "pid,hostname",
          // Keep request summaries on a single line. Safe error objects still
          // include call frames without exposing query parameters.
          singleLine: true,
        },
      }
    : undefined,
});

/** Convert oRPC's raw exception binding before handing it to Pino. */
export const orpcLogger: ContextLogger = {
  error(bindings, message) {
    const { err, ...safeBindings } = bindings;
    logger.error({ ...safeBindings, error: serializeSafeError(err) }, message);
  },
};

/**
 * The shape oRPC passes to a root interceptor: the standard handler options
 * plus a `next()` to continue the chain. Mirrors `@orpc/shared`'s Interceptor
 * without taking on an extra direct dependency.
 */
type RootInterceptorOptions =
  StandardHandlerInterceptorOptions<InitialContext> & {
    next: (
      options?: StandardHandlerInterceptorOptions<InitialContext>,
    ) => Promise<StandardHandleResult>;
  };

/**
 * oRPC root interceptor that logs exactly one Next.js-style line per request:
 *
 *   GET /rpc/projects/list 200 in 12ms
 *
 * On error it logs the full error object (multi-line, with stack) instead.
 */
export async function requestLogger(
  options: RootInterceptorOptions,
): Promise<StandardHandleResult> {
  const start = performance.now();
  const { method, url } = options.request;
  const path = url.pathname;

  try {
    const result = await options.next();
    const ms = Math.round(performance.now() - start);

    if (result.matched) {
      const status = result.response.status;
      const fields = { method, path, status, durationMs: ms };
      const message = `${method} ${path} ${status} in ${ms}ms`;

      if (status >= 500) {
        logger.error(fields, message);
      } else {
        logger.info(fields, message);
      }
    }

    return result;
  } catch (error) {
    const ms = Math.round(performance.now() - start);
    logger.error(
      { error: serializeSafeError(error), method, path, durationMs: ms },
      `${method} ${path} failed in ${ms}ms`,
    );
    throw error;
  }
}
