# Autonomous Research Workbench on AWS

A multi-agent research platform: specialist agents plan and run scientific
investigations, grounding their work in a shared knowledge graph built from an
ingested document corpus.

The monorepo holds four applications — `api`, `web`, `worker`, and the `infra`
CDK app — plus the shared `@repo/*` libraries they build on.

## Getting Started

### 1. Start the local infrastructure

```bash
docker compose up -d --build    # or: pnpm db:local:up
```

#### Services

| Service | Host Port | Description |
| --- | --- | --- |
| `postgres` | 5432 | Postgres 17 (database `application`, user/password `postgres`/`postgres`). Runs with `wal_level=logical` so Electric can stream changes. |
| `electric` | 3010 | [ElectricSQL](https://electric-sql.com) sync engine — syncs Postgres tables to clients over HTTP shapes. |
| `durable-streams` | 4437 | Electric Streams (durable-streams) server for ephemeral, high-frequency streaming (agent token/tool deltas). Built from `docker/durable-streams`. |
| `memgraph` | 7687 (Bolt), 7444 | [Memgraph](https://memgraph.com) graph database (MAGE image), spoken to via the Bolt protocol. |
| `memgraph-lab` | 3001 | Browser UI for exploring the Memgraph graph — open http://localhost:3001. |

Host ports can be overridden with `POSTGRES_PORT`, `ELECTRIC_PORT`, `STREAMS_PORT`, `MEMGRAPH_PORT`, `MEMGRAPH_HTTP_PORT`, and `MEMGRAPH_LAB_PORT` env vars.

Stop everything with `pnpm db:local:down`, or `pnpm db:local:reset` to wipe the data volumes and start fresh.

### 2. Make sure your AWS credentials are active

The env setup pulls Cognito config live from the AWS account, so you need a valid session (e.g. `aws sso login`). Verify with:

```bash
aws sts get-caller-identity
```

### 3. Generate the local env files

```bash
./scripts/init-env.sh
```

This writes `apps/api/.env`, `apps/web/.env.local`, and `packages/database/.env` — local-dev values for Postgres/Memgraph plus Cognito settings discovered from the AWS account (defaults to `us-west-2`; pass `--region <region>` to override). Safe to re-run; it preserves the generated `BETTER_AUTH_SECRET`. Requires `aws`, `openssl`, and `jq`.

### 4. Install dependencies and run the database migrations

```bash
pnpm i
pnpm db:migrate
```

This applies the drizzle migrations from `packages/database/drizzle` to the local Postgres.

### 5. Run

```bash
pnpm run dev
```

This starts all apps via turbo — the API on http://localhost:4000 and the web app on http://localhost:3000.

## Deploying to AWS

Needs Docker running — several stacks build container images and bundle Python Lambdas
from local assets.

```bash
cd apps/infra
pnpm run bootstrap             # cdk bootstrap — once per account/region
pnpm run deploy --all          # deploy every stack
```

Use `pnpm run deploy`, not `pnpm deploy` — the latter is a built-in pnpm command and
shadows the script.

Then re-run the env script from the repo root so the local `.env` files pick up the
deployed Cognito config:

```bash
./scripts/init-env.sh
```

Tear down with:

```bash
pnpm run destroy --all
```

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This project is licensed under the Apache-2.0 License.
