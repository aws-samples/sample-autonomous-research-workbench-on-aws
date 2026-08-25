import * as path from "node:path";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Lambda entrypoint that applies the Drizzle SQL migrations in ./drizzle to
 * the Aurora cluster. Deployed by the ResearchWorkbench/Database CDK stack (see
 * apps/infra/lib/stacks/database-stack.ts) and invoked manually after a
 * deploy:
 *
 *   aws lambda invoke --function-name <MigrationFunctionArn> /dev/stdout
 */

interface RdsSecret {
  username: string;
  password: string;
  host: string;
  port: number;
  dbname: string;
}

async function getDatabaseCredentials(secretArn: string): Promise<RdsSecret> {
  const client = new SecretsManagerClient({
    customUserAgent: process.env.USER_AGENT_STRING,
  });
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );

  if (!response.SecretString) {
    throw new Error("Database secret has no SecretString");
  }

  return JSON.parse(response.SecretString) as RdsSecret;
}

export async function handler(): Promise<{
  statusCode: number;
  body: string;
}> {
  const secretArn = process.env.DATABASE_SECRET_ARN;
  if (!secretArn) {
    throw new Error("DATABASE_SECRET_ARN environment variable is not set");
  }

  const credentials = await getDatabaseCredentials(secretArn);

  const pool = new Pool({
    host: credentials.host,
    port: credentials.port,
    user: credentials.username,
    password: credentials.password,
    database: credentials.dbname,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const db = drizzle(pool);

    // The Drizzle SQL migrations are copied next to the bundle at deploy time
    // (see the NodejsFunction bundling commandHooks in database-stack.ts).
    const migrationsFolder = path.join(__dirname, "drizzle");

    console.log(`Running migrations from ${migrationsFolder}...`);
    await migrate(db, { migrationsFolder });
    console.log("Migrations complete.");

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Migrations applied successfully" }),
    };
  } finally {
    await pool.end();
  }
}
