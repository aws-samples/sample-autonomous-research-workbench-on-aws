/**
 * Shared boot-time environment resolution for the worker's entrypoints (the
 * AgentCore invocation server and the scheduled sweep Lambda).
 *
 * This module must not (transitively) import @repo/database — the pg Pool's
 * connection string is resolved at module load, so DB credentials have to be
 * in process.env before anything touching the database is loaded. Callers
 * therefore run these resolvers first and dynamically import the rest.
 */

/**
 * Secrets: AgentCore/Lambda env vars are plain strings (no ECS-style secret
 * injection), so the Aurora credentials are fetched from Secrets Manager at
 * boot via DB_SECRET_ARN.
 */
export async function resolveDbCredentials(): Promise<void> {
  if (process.env.DB_USER || process.env.DATABASE_URL) return;
  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) return;

  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    "@aws-sdk/client-secrets-manager"
  );
  const client = new SecretsManagerClient({
    customUserAgent: process.env.USER_AGENT_STRING,
  });
  const secret = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (!secret.SecretString) {
    throw new Error("DB secret has no SecretString");
  }
  const { username, password } = JSON.parse(secret.SecretString) as {
    username: string;
    password: string;
  };
  process.env.DB_USER = username;
  process.env.DB_PASSWORD = password;
}

/**
 * Self ARN: a runtime's env vars cannot reference its own ARN (the value
 * would depend on the resource being created), so the ARN used for
 * self-dispatch (spawn/resume/retry) is read from an SSM parameter written
 * by the infra stack after creation, via AGENTCORE_RUNTIME_ARN_PARAM.
 * (The sweep Lambda gets AGENTCORE_RUNTIME_ARN directly and skips this.)
 */
export async function resolveRuntimeArn(): Promise<void> {
  if (process.env.AGENTCORE_RUNTIME_ARN) return;
  const paramName = process.env.AGENTCORE_RUNTIME_ARN_PARAM;
  if (!paramName) return;

  const { SSMClient, GetParameterCommand } = await import(
    "@aws-sdk/client-ssm"
  );
  const client = new SSMClient({
    customUserAgent: process.env.USER_AGENT_STRING,
  });
  const result = await client.send(
    new GetParameterCommand({ Name: paramName }),
  );
  const arn = result.Parameter?.Value;
  if (!arn) {
    throw new Error(`SSM parameter ${paramName} has no value`);
  }
  process.env.AGENTCORE_RUNTIME_ARN = arn;
}
