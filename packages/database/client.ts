import { readFileSync } from "node:fs";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as relations from "./relations";
import * as schema from "./schema";

function getCaCert(): string | undefined {
  const caPath = process.env.RDS_CA_BUNDLE_PATH;
  if (!caPath) {
    return undefined;
  }
  return readFileSync(caPath, "utf8");
}

export function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const user = process.env.DB_USER;
  const pass = process.env.DB_PASSWORD;
  const host = process.env.DB_ADDRESS;
  const name = process.env.DB_NAME;

  if (user && pass && host && name) {
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}/${name}`;
  }

  throw new Error(
    "Missing database configuration. Set DATABASE_URL or DB_USER, DB_PASSWORD, DB_ADDRESS, and DB_NAME.",
  );
}

const globalForDb = globalThis as typeof globalThis & {
  db?: ReturnType<typeof createDb>;
};

function createDb() {
  const caCert = getCaCert();

  const pool = new Pool({
    connectionString: getDatabaseUrl(),
    ssl: caCert
      ? {
          rejectUnauthorized: true,
          ca: caCert,
        }
      : false,
    // Fail fast instead of hanging forever: pg's defaults put no bound on
    // connection establishment or query execution, so a wedged connection
    // (dropped TCP path, unreachable endpoint) blocks its caller
    // indefinitely. On the AgentCore runtime that silent hang kept /ping
    // reporting HealthyBusy and held idle sessions alive to the 8h max
    // lifetime. Every statement in this app is short OLTP work — anything
    // slower than these bounds is a bug, and callers' retry paths (guarded
    // claims, the sweep backstop) recover from a thrown timeout.
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
    statement_timeout: 55_000,
    // Detect half-open connections (e.g. dropped by an idle NAT/LB) instead
    // of writing into the void.
    keepAlive: true,
  });

  return drizzle({
    client: pool,
    schema: { ...schema, ...relations },
  });
}

export const db: ReturnType<typeof createDb> = globalForDb.db ?? createDb();

if (process.env.NODE_ENV !== "production") {
  globalForDb.db = db;
}
