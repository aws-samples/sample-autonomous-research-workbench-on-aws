/**
 * MCP tool handler invoked by the AgentCore Gateway Lambda target.
 *
 * The gateway passes the invoked tool name via the `bedrockAgentCoreToolName`
 * context key and the tool arguments as the event body. Allowlisted request
 * headers (e.g. x-project-id) are NOT placed on the event — for a Lambda target
 * the gateway serializes them under the client-context custom key
 * `bedrockAgentCorePropagatedHeaders` (parsed object on some runtimes, JSON
 * string on others).
 *
 * The project id scopes every tool call to a single `project` row. It is
 * carried in the x-project-id header rather than as a tool argument so the
 * agent can't spoof or confuse which project it is editing.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { Pool } from "pg";

interface ToolContext {
  clientContext?: {
    // Values are mostly strings, but bedrockAgentCorePropagatedHeaders arrives
    // as an already-parsed object on some runtimes.
    custom?: Record<string, unknown>;
  };
}

interface ToolEvent {
  // Tool arguments as defined in tool-schema.json.
  [key: string]: unknown;
  // Some transports also surface propagated headers here; kept as a fallback.
  headers?: Record<string, string>;
}

/** Case-insensitive lookup over a header bag. */
function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/** Read the gateway's propagated headers, tolerating object or JSON-string. */
function propagatedHeaders(context: ToolContext): Record<string, string> | undefined {
  const raw = context.clientContext?.custom?.["bedrockAgentCorePropagatedHeaders"];
  if (!raw) return undefined;
  const value =
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return undefined;
          }
        })()
      : raw;
  return typeof value === "object" && value !== null
    ? (value as Record<string, string>)
    : undefined;
}

function resolveProjectId(event: ToolEvent, context: ToolContext): string | undefined {
  const fromPropagated = headerValue(propagatedHeaders(context), "x-project-id");
  if (fromPropagated) return fromPropagated;
  const fromEvent = headerValue(event.headers, "x-project-id");
  if (fromEvent) return fromEvent;
  const fromCustom = context.clientContext?.custom?.["x-project-id"];
  return typeof fromCustom === "string" ? fromCustom : undefined;
}

// ── Database ────────────────────────────────────────────────────────────────
// One pooled client is reused across warm invocations. Credentials come from
// the Aurora-managed secret (DB_SECRET_ARN); host/port/name from env.

let pool: Pool | undefined;
const secrets = new SecretsManagerClient({
  customUserAgent: process.env.USER_AGENT_STRING,
});

async function getPool(): Promise<Pool> {
  if (pool) return pool;

  const secretArn = process.env.DB_SECRET_ARN;
  const host = process.env.DB_HOST;
  const port = Number(process.env.DB_PORT ?? "5432");
  const database = process.env.DB_NAME ?? "application";
  if (!secretArn || !host) {
    throw new Error("DB_SECRET_ARN and DB_HOST must be set");
  }

  const secretValue = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  const { username, password } = JSON.parse(secretValue.SecretString ?? "{}") as {
    username: string;
    password: string;
  };

  pool = new Pool({
    host,
    port,
    database,
    user: username,
    password,
    // Aurora requires TLS; the managed cert chain is a public Amazon RDS CA, so
    // we don't pin it here (the Lambda has no bundled CA file). Encrypt in
    // transit without verifying the chain.
    ssl: { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return pool;
}

// ── Brief fields ──────────────────────────────────────────────────────────
// The columns the prospect agent may write, mapped to their `project` column.
// Anything not in this allowlist is rejected — the agent cannot touch status,
// ownerId, etc. Text fields are string-typed; budgetUsd is the one numeric
// field and maps to the ENFORCED spend cap (maxBudgetUsd), not prose.
const BRIEF_COLUMNS = {
  name: "name",
  seedHypothesis: "seedHypothesis",
  objective: "objective",
  checkInCadence: "checkInCadence",
  flags: "flags",
  contextNotes: "contextNotes",
} as const;

type BriefField = keyof typeof BRIEF_COLUMNS;

/** Numeric brief field: the enforced agent-spend cap in USD. */
const BUDGET_FIELD = "budgetUsd";
const BUDGET_COLUMN = "maxBudgetUsd";

async function updateProjectBrief(projectId: string, event: ToolEvent) {
  const updates: Array<[column: string, value: string | number]> = [];
  for (const field of Object.keys(BRIEF_COLUMNS) as BriefField[]) {
    const value = event[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw new Error(`Field "${field}" must be a string.`);
    }
    updates.push([BRIEF_COLUMNS[field], value]);
  }

  const budgetValue = event[BUDGET_FIELD];
  if (budgetValue !== undefined && budgetValue !== null) {
    const budget =
      typeof budgetValue === "number" ? budgetValue : Number(budgetValue);
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error(
        `Field "${BUDGET_FIELD}" must be a positive number of US dollars (e.g. 100).`,
      );
    }
    updates.push([BUDGET_COLUMN, budget]);
  }

  if (updates.length === 0) {
    return {
      ok: false,
      message:
        "No brief fields provided. Pass one or more of: " +
        [...Object.keys(BRIEF_COLUMNS), BUDGET_FIELD].join(", "),
    };
  }

  // Parameterized UPDATE: $1 is the project id, brief values are $2.. — column
  // names come only from the allowlists above, never from input.
  const setClauses = updates.map(
    ([column], i) => `"${column}" = $${i + 2}`,
  );
  const params = [projectId, ...updates.map(([, value]) => value)];

  const db = await getPool();
  const result = await db.query(
    `UPDATE "project" SET ${setClauses.join(", ")}, "updatedAt" = now()
       WHERE "id" = $1
       RETURNING "id"`,
    params,
  );

  if (result.rowCount === 0) {
    return { ok: false, message: `No project found for id ${projectId}.` };
  }

  const saved = updates.map(([field]) => field);
  return {
    ok: true,
    saved,
    message: `Saved ${saved.join(", ")}.`,
  };
}

async function getProjectBrief(projectId: string) {
  const db = await getPool();
  const cols = Object.values(BRIEF_COLUMNS)
    .map((c) => `"${c}"`)
    .join(", ");
  const result = await db.query(
    `SELECT "id", "status", ${cols}, "${BUDGET_COLUMN}" AS "${BUDGET_FIELD}"
       FROM "project" WHERE "id" = $1`,
    [projectId],
  );
  if (result.rowCount === 0) {
    return { ok: false, message: `No project found for id ${projectId}.` };
  }
  return { ok: true, project: result.rows[0] };
}

/**
 * List the agents that exist in the platform and can be assigned to a project.
 * Read-only: the prospect agent uses this to suggest a team in the chat; the
 * human does the actual assignment in the UI. Not project-scoped.
 */
async function listAvailableAgents() {
  const db = await getPool();
  const result = await db.query(
    `SELECT "id", "displayName", "description", "tools"
       FROM "agent"
       ORDER BY "displayName" ASC`,
  );
  return {
    ok: true,
    agents: result.rows.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      description: row.description ?? null,
      tools: row.tools ?? [],
    })),
  };
}

export async function handler(event: ToolEvent, context: ToolContext) {
  // The gateway addresses tools with a target-scoped compound name,
  // "<targetName>___<toolName>" (the `___` delimiter lets one Lambda serve
  // multiple targets). Strip the prefix so we match the bare tool name.
  const rawToolName =
    (context.clientContext?.custom?.["bedrockAgentCoreToolName"] as
      | string
      | undefined) ?? "unknown";
  const toolName = rawToolName.includes("___")
    ? rawToolName.slice(rawToolName.lastIndexOf("___") + 3)
    : rawToolName;

  // Not project-scoped — no x-project-id required.
  if (toolName === "list_available_agents") {
    return listAvailableAgents();
  }

  // The remaining tools operate on the caller's project.
  const projectId = resolveProjectId(event, context);
  if (!projectId) {
    return {
      ok: false,
      message:
        "No project id on the request. The x-project-id header was not propagated.",
    };
  }

  switch (toolName) {
    case "update_project_brief":
      return updateProjectBrief(projectId, event);
    case "get_project_brief":
      return getProjectBrief(projectId);
    default:
      throw new Error(
        `Unknown tool: ${toolName} (invoked as "${rawToolName}")`,
      );
  }
}
