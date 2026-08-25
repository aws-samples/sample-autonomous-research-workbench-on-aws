/**
 * Bolt client for the knowledge graph. Targets local Memgraph in dev;
 * switches to SigV4 IAM auth for Amazon Neptune when GRAPH_AUTH=sigv4.
 *
 * All queries stay inside Neptune's openCypher subset (no list properties,
 * coalesce() instead of IS NULL, parameterized everything) so the same code
 * runs against both backends.
 *
 * Env:
 *   GRAPH_BOLT_URL  — bolt endpoint (falls back to MEMGRAPH_URL)
 *   GRAPH_AUTH      — "none" (default) or "sigv4"
 *   AWS_REGION / AWS_DEFAULT_REGION — SigV4 region (required for sigv4)
 */
import neo4j, { type Driver } from "neo4j-driver";

import { buildNeptuneAuthManager } from "./neptune-auth";

export function graphBoltUrl(): string | undefined {
  return process.env.GRAPH_BOLT_URL ?? process.env.MEMGRAPH_URL;
}

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (driver) return driver;

  const boltUrl = graphBoltUrl();
  if (!boltUrl) {
    throw new Error(
      "graph store not configured — set GRAPH_BOLT_URL or MEMGRAPH_URL",
    );
  }

  const authMode = (process.env.GRAPH_AUTH ?? "none").toLowerCase();

  if (authMode === "sigv4") {
    const url = new URL(boltUrl);
    // SigV4 signatures embed the region, so it must match where Neptune
    // lives — always the task's own region (env is set by ECS/Lambda).
    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region) {
      throw new Error(
        "GRAPH_AUTH=sigv4 requires AWS_REGION (or AWS_DEFAULT_REGION) to be set",
      );
    }
    driver = neo4j.driver(
      boltUrl,
      buildNeptuneAuthManager(url.hostname, Number(url.port || 8182), region),
      // Keep connections under the 5-minute SigV4 token validity window.
      { maxConnectionLifetime: 240_000 },
    );
  } else {
    driver = neo4j.driver(boltUrl, undefined, {
      maxConnectionLifetime: 240_000,
    });
  }
  return driver;
}

export async function runQuery<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const session = getDriver().session();
  try {
    const result = await session.run(cypher, params);
    return result.records.map((r) => r.toObject() as T);
  } finally {
    await session.close();
  }
}

/**
 * Wrap a JS number as a neo4j Integer for parameters used in LIMIT (and other
 * integer-only positions) — the driver otherwise sends plain numbers as
 * floats, which Memgraph/Neptune reject ("Limit … must be an integer").
 */
export function toInt(value: number): ReturnType<typeof neo4j.int> {
  return neo4j.int(Math.trunc(value));
}

/** Convert neo4j Integer objects to plain JS numbers. */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (
    value &&
    typeof value === "object" &&
    "toNumber" in (value as Record<string, unknown>)
  ) {
    return (value as { toNumber(): number }).toNumber();
  }
  return Number(value ?? 0);
}

/** Convert a single cypher value to a JSON-safe plain value. */
export function toPlain(value: unknown): string | number | boolean | null {
  return value !== null && typeof value === "object" && "toNumber" in value
    ? toNumber(value)
    : (value as string | number | boolean | null);
}
