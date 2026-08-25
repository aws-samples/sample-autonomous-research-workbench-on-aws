import "dotenv/config";

/**
 * AgentCore Runtime bootstrap.
 *
 * Resolves configuration that AgentCore cannot inject directly (Aurora
 * credentials from Secrets Manager, the runtime's own ARN from SSM — see
 * bootstrap.ts), then starts the invocation server. This file must not
 * (transitively) import @repo/database — the pg Pool's connection string is
 * resolved at module load, so DB credentials have to be in process.env
 * before the server module (which imports the processors) is loaded. Hence
 * the dynamic import at the bottom.
 */
import { resolveDbCredentials, resolveRuntimeArn } from "./bootstrap";

async function main(): Promise<void> {
  await Promise.all([resolveDbCredentials(), resolveRuntimeArn()]);

  await import("./agentcore-server");
}

main().catch((error) => {
  console.error("[agentcore] bootstrap failed:", error);
  process.exit(1);
});
