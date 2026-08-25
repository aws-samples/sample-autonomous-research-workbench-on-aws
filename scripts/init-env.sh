#!/usr/bin/env bash
#
# init-env.sh — generate local .env files for apps/api, apps/web,
# apps/worker, and packages/database.
#
# Static local-dev values (Postgres, Memgraph, service URLs) are written
# directly; Cognito values are pulled live from the AWS account. A
# BETTER_AUTH_SECRET is generated once and preserved on re-runs.
#
# Usage:
#   ./scripts/init-env.sh                     # defaults to us-west-2
#   ./scripts/init-env.sh --region us-east-1
#
# Requires: aws cli (authenticated), openssl, jq

set -euo pipefail

# Deliberately not driven by the ambient AWS_REGION: the Cognito pool lives in
# us-west-2 regardless of what the current shell has exported.
REGION="us-west-2"
if [[ "${1:-}" == "--region" && -n "${2:-}" ]]; then
  REGION="$2"
fi
# The pool is created by the ResearchWorkbench/Cognito CDK stack; depending on how it
# was deployed the name is either the explicit 'research-workbench' or a CDK-generated
# one prefixed with the stack name (e.g. 'ResearchWorkbenchCognito...UserPool...').
# Match by prefix, case-insensitive and ignoring hyphens, so both forms work.
POOL_PREFIX="${COGNITO_POOL_NAME:-research-workbench}"

# CloudFormation stack name prefix for resource discovery (gateway, harness,
# storage, ingestion). Override when deploying under a different umbrella
# stack name, e.g. STACK_PREFIX=MyDevBranch ./scripts/init-env.sh
STACK_PREFIX="${STACK_PREFIX:-ResearchWorkbench}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_ENV="$ROOT/apps/api/.env"
WEB_ENV="$ROOT/apps/web/.env.local"
DB_ENV="$ROOT/packages/database/.env"
WORKER_ENV="$ROOT/apps/worker/.env"

for cmd in aws openssl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '$cmd' is required but not installed" >&2
    exit 1
  fi
done

echo "→ Checking AWS credentials..."
if ! aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; then
  echo "error: AWS credentials are not configured or have expired" >&2
  exit 1
fi

# ── Cognito discovery ────────────────────────────────────────────────────────

echo "→ Looking up Cognito user pool matching '$POOL_PREFIX*' in $REGION..."
POOLS_JSON="$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" \
  --query 'UserPools[].{Id:Id,Name:Name}' --output json)"

# Prefix match, case-insensitive, hyphens ignored: 'research-workbench' matches
# 'research-workbench', 'ResearchWorkbenchCognitoUserPool...', etc.
MATCHES_JSON="$(echo "$POOLS_JSON" | jq --arg p "$POOL_PREFIX" \
  '[.[] | select((.Name | ascii_downcase | gsub("-"; "")) | startswith($p | ascii_downcase | gsub("-"; "")))]')"
MATCH_COUNT="$(echo "$MATCHES_JSON" | jq 'length')"

if [[ "$MATCH_COUNT" -eq 0 ]]; then
  echo "error: no Cognito user pool matching '$POOL_PREFIX*' found in $REGION" >&2
  echo "  pools in this region:" >&2
  echo "$POOLS_JSON" | jq -r '.[] | "    \(.Name) (\(.Id))"' >&2
  exit 1
fi

if [[ "$MATCH_COUNT" -gt 1 ]]; then
  echo "⚠ note: $MATCH_COUNT pools match '$POOL_PREFIX*':" >&2
  echo "$MATCHES_JSON" | jq -r '.[] | "    \(.Name) (\(.Id))"' >&2

  # Disambiguate: prefer an exact normalized-name match ('research-workbench' ==
  # 'research-workbench'), otherwise pick the first candidate that has a hosted UI
  # domain configured (the mcp/m2m pools don't).
  EXACT_JSON="$(echo "$MATCHES_JSON" | jq --arg p "$POOL_PREFIX" \
    '[.[] | select((.Name | ascii_downcase | gsub("-"; "")) == ($p | ascii_downcase | gsub("-"; "")))]')"
  if [[ "$(echo "$EXACT_JSON" | jq 'length')" -ge 1 ]]; then
    MATCHES_JSON="$EXACT_JSON"
    echo "  → using exact name match: $(echo "$EXACT_JSON" | jq -r '.[0].Name')" >&2
  else
    PICKED_JSON=""
    while IFS=$'\t' read -r CAND_ID CAND_NAME; do
      CAND_DOMAIN="$(aws cognito-idp describe-user-pool --user-pool-id "$CAND_ID" \
        --region "$REGION" --query 'UserPool.Domain' --output text 2>/dev/null || true)"
      if [[ -n "$CAND_DOMAIN" && "$CAND_DOMAIN" != "None" ]]; then
        PICKED_JSON="$(jq -n --arg id "$CAND_ID" --arg name "$CAND_NAME" '[{Id:$id,Name:$name}]')"
        echo "  → using pool with a hosted UI domain: $CAND_NAME" >&2
        break
      fi
    done < <(echo "$MATCHES_JSON" | jq -r '.[] | "\(.Id)\t\(.Name)"')
    if [[ -n "$PICKED_JSON" ]]; then
      MATCHES_JSON="$PICKED_JSON"
    else
      echo "error: none of the matching pools has a hosted UI domain configured" >&2
      echo "  set COGNITO_POOL_NAME to pick one explicitly" >&2
      exit 1
    fi
  fi
fi

USER_POOL_ID="$(echo "$MATCHES_JSON" | jq -r '.[0].Id')"
POOL_NAME="$(echo "$MATCHES_JSON" | jq -r '.[0].Name')"
echo "   matched: $POOL_NAME"

# The pool holds two app clients: the browser-facing web client ('research-workbench')
# and the gateway M2M client ('research-workbench-gateway-m2m'). List order is not
# stable, so pick by name — web client is the one without 'm2m'.
CLIENTS_JSON="$(aws cognito-idp list-user-pool-clients --user-pool-id "$USER_POOL_ID" \
  --region "$REGION" --query 'UserPoolClients[].{Id:ClientId,Name:ClientName}' --output json)"

CLIENT_ID="$(echo "$CLIENTS_JSON" | jq -r \
  '[.[] | select(.Name | ascii_downcase | contains("m2m") | not)][0].Id // empty')"
M2M_CLIENT_ID="$(echo "$CLIENTS_JSON" | jq -r \
  '[.[] | select(.Name | ascii_downcase | contains("m2m"))][0].Id // empty')"

if [[ -z "$CLIENT_ID" ]]; then
  echo "error: user pool $USER_POOL_ID has no non-M2M app client" >&2
  echo "  clients: $(echo "$CLIENTS_JSON" | jq -c .)" >&2
  exit 1
fi

DOMAIN_PREFIX="$(aws cognito-idp describe-user-pool --user-pool-id "$USER_POOL_ID" \
  --region "$REGION" --query 'UserPool.Domain' --output text)"

if [[ -z "$DOMAIN_PREFIX" || "$DOMAIN_PREFIX" == "None" ]]; then
  echo "error: user pool $USER_POOL_ID has no hosted UI domain configured" >&2
  exit 1
fi

COGNITO_DOMAIN="$DOMAIN_PREFIX.auth.$REGION.amazoncognito.com"

echo "   pool:   $USER_POOL_ID"
echo "   client: $CLIENT_ID"
echo "   domain: $COGNITO_DOMAIN"

# ── AgentCore Gateway discovery ──────────────────────────────────────────────
# The API mints a client_credentials token with the M2M client and attaches
# the gateway's MCP endpoint to harness invocations. Leave the URL empty to
# invoke the harness without gateway tools.

echo "→ Looking up AgentCore gateway via the ResearchWorkbench gateway stack..."
AGENTCORE_GATEWAY_URL=""
GATEWAY_M2M_CLIENT_ID="$M2M_CLIENT_ID"
GATEWAY_M2M_CLIENT_SECRET=""
GATEWAY_OAUTH_SCOPE="agentcore-gateway/invoke"

GATEWAY_STACK="$(aws cloudformation list-stacks --region "$REGION" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
  --query "StackSummaries[?starts_with(StackName, '${STACK_PREFIX}AgentCoreGateway')].StackName | [0]" \
  --output text 2>/dev/null || true)"
if [[ -n "$GATEWAY_STACK" && "$GATEWAY_STACK" != "None" ]]; then
  GATEWAY_ID="$(aws cloudformation describe-stack-resources --region "$REGION" \
    --stack-name "$GATEWAY_STACK" \
    --query "StackResources[?ResourceType=='AWS::BedrockAgentCore::Gateway'].PhysicalResourceId | [0]" \
    --output text 2>/dev/null || true)"
  if [[ -n "$GATEWAY_ID" && "$GATEWAY_ID" != "None" ]]; then
    AGENTCORE_GATEWAY_URL="$(aws bedrock-agentcore-control get-gateway \
      --gateway-identifier "$GATEWAY_ID" --region "$REGION" \
      --query 'gatewayUrl' --output text 2>/dev/null || true)"
    [[ "$AGENTCORE_GATEWAY_URL" == "None" ]] && AGENTCORE_GATEWAY_URL=""
  fi
fi

if [[ -n "$M2M_CLIENT_ID" ]]; then
  GATEWAY_M2M_CLIENT_SECRET="$(aws cognito-idp describe-user-pool-client \
    --user-pool-id "$USER_POOL_ID" --client-id "$M2M_CLIENT_ID" --region "$REGION" \
    --query 'UserPoolClient.ClientSecret' --output text 2>/dev/null || true)"
  # No literal secret here: this clears the var when the AWS CLI returns the
  # string "None" (meaning no client secret is configured).
  [[ "$GATEWAY_M2M_CLIENT_SECRET" == "None" ]] && GATEWAY_M2M_CLIENT_SECRET=""  # pragma: allowlist secret
fi

if [[ -n "$AGENTCORE_GATEWAY_URL" && -n "$M2M_CLIENT_ID" && -n "$GATEWAY_M2M_CLIENT_SECRET" ]]; then
  echo "   stack:      $GATEWAY_STACK"
  echo "   url:        $AGENTCORE_GATEWAY_URL"
  echo "   m2m client: $M2M_CLIENT_ID"
else
  echo "   ⚠ gateway not fully resolved — harness will run without gateway tools"
  [[ -z "$AGENTCORE_GATEWAY_URL" ]] && echo "     missing: AGENTCORE_GATEWAY_URL"
  [[ -z "$M2M_CLIENT_ID" ]] && echo "     missing: GATEWAY_M2M_CLIENT_ID (no *m2m* app client in pool)"
  [[ -n "$M2M_CLIENT_ID" && -z "$GATEWAY_M2M_CLIENT_SECRET" ]] && echo "     missing: GATEWAY_M2M_CLIENT_SECRET"
fi

# ── AgentCore harness ARN discovery ─────────────────────────────────────────

echo "→ Looking up AgentCore project_prospect harness via the ResearchWorkbench harness stack..."
# The harness's name is the CDK stack name (harnessName: this.stackName in
# AgentCoreHarnessStack), not 'project_prospect', so we can't match it by name
# via list-harnesses. Resolve the CFN stack instead: the harness resource's
# PhysicalResourceId is its ARN.
PROJECT_PROSPECT_HARNESS_ARN=""
HARNESS_STACK="$(aws cloudformation list-stacks --region "$REGION" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
  --query "StackSummaries[?starts_with(StackName, '${STACK_PREFIX}AgentCoreHarness')].StackName | [0]" \
  --output text 2>/dev/null || true)"
if [[ -n "$HARNESS_STACK" && "$HARNESS_STACK" != "None" ]]; then
  if HARNESS_ARN="$(aws cloudformation describe-stack-resources --region "$REGION" \
    --stack-name "$HARNESS_STACK" \
    --query "StackResources[?ResourceType=='AWS::BedrockAgentCore::Harness'].PhysicalResourceId | [0]" \
    --output text 2>/dev/null)" && [[ -n "$HARNESS_ARN" && "$HARNESS_ARN" != "None" ]]; then
    PROJECT_PROSPECT_HARNESS_ARN="$HARNESS_ARN"
    echo "   stack:   $HARNESS_STACK"
    echo "   harness: $PROJECT_PROSPECT_HARNESS_ARN"
  fi
fi
if [[ -z "$PROJECT_PROSPECT_HARNESS_ARN" ]]; then
  echo "   ⚠ project_prospect harness not found — set PROJECT_PROSPECT_HARNESS_ARN manually"
fi

# ── Knowledge bucket + ingestion Step Function discovery ────────────────────
# Used by the Settings → Knowledge admin panel (S3 browsing + sync). The
# bucket name is stack-derived (…-knowledge); the state machine has the
# explicit name ResearchWorkbench-Ingestion.

echo "→ Looking up knowledge bucket via the ResearchWorkbench storage stack..."
# Resolve through CloudFormation rather than by bucket-name pattern: the
# account may hold storage stacks from other branches/deployments whose
# buckets would match a name-based search.
KNOWLEDGE_BUCKET=""
STORAGE_STACK="$(aws cloudformation list-stacks --region "$REGION" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
  --query "StackSummaries[?starts_with(StackName, '${STACK_PREFIX}Storage')].StackName | [0]" \
  --output text 2>/dev/null || true)"
if [[ -n "$STORAGE_STACK" && "$STORAGE_STACK" != "None" ]]; then
  if BUCKET="$(aws cloudformation describe-stack-resources --region "$REGION" \
    --stack-name "$STORAGE_STACK" \
    --query "StackResources[?starts_with(LogicalResourceId, 'KnowledgeBucket')].PhysicalResourceId | [0]" \
    --output text 2>/dev/null)" && [[ -n "$BUCKET" && "$BUCKET" != "None" ]]; then
    KNOWLEDGE_BUCKET="$BUCKET"
    echo "   stack:  $STORAGE_STACK"
    echo "   bucket: $KNOWLEDGE_BUCKET"
  fi
fi
if [[ -z "$KNOWLEDGE_BUCKET" ]]; then
  echo "   ⚠ knowledge bucket not found — set KNOWLEDGE_BUCKET manually"
fi

echo "→ Looking up artifacts (project files) bucket via the ResearchWorkbench storage stack..."
FILES_BUCKET=""
if [[ -n "$STORAGE_STACK" && "$STORAGE_STACK" != "None" ]]; then
  if BUCKET="$(aws cloudformation describe-stack-resources --region "$REGION" \
    --stack-name "$STORAGE_STACK" \
    --query "StackResources[?starts_with(LogicalResourceId, 'ArtifactsBucket')].PhysicalResourceId | [0]" \
    --output text 2>/dev/null)" && [[ -n "$BUCKET" && "$BUCKET" != "None" ]]; then
    FILES_BUCKET="$BUCKET"
    echo "   bucket: $FILES_BUCKET"
  fi
fi
if [[ -z "$FILES_BUCKET" ]]; then
  echo "   ⚠ artifacts bucket not found — set FILES_BUCKET manually (project Files tab)"
fi

echo "→ Looking up LanceDB bucket via the ResearchWorkbench storage stack..."
# Backs the worker's document query tools (queryDocuments etc.). Without it
# the tools fall back to an empty local ./lancedb directory and silently
# return no results.
LANCEDB_BUCKET=""
if [[ -n "$STORAGE_STACK" && "$STORAGE_STACK" != "None" ]]; then
  if BUCKET="$(aws cloudformation describe-stack-resources --region "$REGION" \
    --stack-name "$STORAGE_STACK" \
    --query "StackResources[?starts_with(LogicalResourceId, 'LanceDBBucket')].PhysicalResourceId | [0]" \
    --output text 2>/dev/null)" && [[ -n "$BUCKET" && "$BUCKET" != "None" ]]; then
    LANCEDB_BUCKET="$BUCKET"
    echo "   bucket: $LANCEDB_BUCKET"
  fi
fi
if [[ -z "$LANCEDB_BUCKET" ]]; then
  echo "   ⚠ lancedb bucket not found — set LANCEDB_BUCKET manually (document query tools)"
fi

echo "→ Looking up ingestion state machine via the ResearchWorkbench ingestion stack..."
INGESTION_STATE_MACHINE_ARN=""
INGESTION_STACK="$(aws cloudformation list-stacks --region "$REGION" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
  --query "StackSummaries[?starts_with(StackName, '${STACK_PREFIX}Ingestion')].StackName | [0]" \
  --output text 2>/dev/null || true)"
if [[ -n "$INGESTION_STACK" && "$INGESTION_STACK" != "None" ]]; then
  if SFN_ARN="$(aws cloudformation describe-stack-resources --region "$REGION" \
    --stack-name "$INGESTION_STACK" \
    --query "StackResources[?ResourceType=='AWS::StepFunctions::StateMachine'].PhysicalResourceId | [0]" \
    --output text 2>/dev/null)" && [[ -n "$SFN_ARN" && "$SFN_ARN" != "None" ]]; then
    INGESTION_STATE_MACHINE_ARN="$SFN_ARN"
    echo "   stack:         $INGESTION_STACK"
    echo "   state machine: $INGESTION_STATE_MACHINE_ARN"
  fi
fi
if [[ -z "$INGESTION_STATE_MACHINE_ARN" ]]; then
  echo "   ⚠ ingestion state machine not found — set INGESTION_STATE_MACHINE_ARN manually"
fi

# ── Better Auth secret (generate once, preserve on re-runs) ──────────────────

BETTER_AUTH_SECRET=""
if [[ -f "$API_ENV" ]]; then
  BETTER_AUTH_SECRET="$(grep -E '^BETTER_AUTH_SECRET=' "$API_ENV" | head -1 | cut -d= -f2- | tr -d '"')"
fi
if [[ -z "$BETTER_AUTH_SECRET" ]]; then
  BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
  echo "→ Generated new BETTER_AUTH_SECRET"
else
  echo "→ Preserving existing BETTER_AUTH_SECRET"
fi

# ── apps/api/.env ────────────────────────────────────────────────────────────

cat > "$API_ENV" <<EOF
# Generated by scripts/init-env.sh — re-run to refresh AWS-derived values.

# ── Server ──
PORT=4000

# ── Database (docker-compose postgres) ──
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/application"  # pragma: allowlist secret

# ── Better Auth ──
BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET"
BETTER_AUTH_URL="http://localhost:4000"
TRUSTED_ORIGINS="http://localhost:3000"

# ── Cognito (pulled from AWS account $(aws sts get-caller-identity --query Account --output text)) ──
COGNITO_CLIENT_ID="$CLIENT_ID"
COGNITO_DOMAIN="$COGNITO_DOMAIN"
AWS_DEFAULT_REGION="$REGION"
COGNITO_USERPOOL_ID="$USER_POOL_ID"

# ── Graph store (docker-compose memgraph) ──
GRAPH_BOLT_URL="bolt://localhost:7687"
GRAPH_AUTH="none"

# ── Electric SQL (docker-compose electric) — /sync proxy upstream ──
ELECTRIC_URL="http://localhost:3010"
# Electric Cloud only (leave unset for local ELECTRIC_INSECURE dev):
# ELECTRIC_SOURCE_ID=""
# ELECTRIC_SECRET=""

# ── AgentCore ──
PROJECT_PROSPECT_HARNESS_ARN="$PROJECT_PROSPECT_HARNESS_ARN"

# ── Orchestrated run dispatch ──
# Local dev: POST run pointers to the locally running agentcore server
# (apps/worker, port 8080) instead of calling InvokeAgentRuntime.
AGENTCORE_LOCAL_URL="http://localhost:8080"
# Deployed alternative (unset AGENTCORE_LOCAL_URL to use it):
# AGENTCORE_RUNTIME_ARN=""

# ── AgentCore Gateway (project-scoped harness tools) ──
AGENTCORE_GATEWAY_URL="$AGENTCORE_GATEWAY_URL"
GATEWAY_M2M_CLIENT_ID="$GATEWAY_M2M_CLIENT_ID"
GATEWAY_M2M_CLIENT_SECRET="$GATEWAY_M2M_CLIENT_SECRET"
GATEWAY_OAUTH_SCOPE="$GATEWAY_OAUTH_SCOPE"

# ── Durable Streams server (docker-compose durable-streams) ──
STREAMS_URL="http://localhost:4437"

# ── Knowledge bucket admin (Settings → Knowledge) ──
KNOWLEDGE_BUCKET="$KNOWLEDGE_BUCKET"
INGESTION_STATE_MACHINE_ARN="$INGESTION_STATE_MACHINE_ARN"

# ── Project files (S3-backed Files tab, presigned URLs) ──
FILES_BUCKET="$FILES_BUCKET"
EOF
echo "→ Wrote $API_ENV"

# ── apps/web/.env.local ──────────────────────────────────────────────────────

cat > "$WEB_ENV" <<EOF
# Generated by scripts/init-env.sh — re-run to refresh.

# Base URL of the API service (auth, rpc, openapi docs)
VITE_SERVICE_URL=http://localhost:4000
EOF
echo "→ Wrote $WEB_ENV"

# ── packages/database/.env ───────────────────────────────────────────────────
# drizzle-kit (db:migrate, db:push, db:studio) loads .env from the package dir.

cat > "$DB_ENV" <<EOF
# Generated by scripts/init-env.sh — re-run to refresh.

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/application"  # pragma: allowlist secret
EOF
echo "→ Wrote $DB_ENV"

# ── apps/worker/.env ─────────────────────────────────────────────────────────
# Run executor serving the AgentCore invocation contract on :8080.

cat > "$WORKER_ENV" <<EOF
# Generated by scripts/init-env.sh — re-run to refresh.

# ── Database (docker-compose postgres) ──
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/application"  # pragma: allowlist secret

# ── Durable Streams server (docker-compose durable-streams) ──
STREAMS_URL="http://localhost:4437"

# ── Orchestrated run dispatch ──
# Self-dispatch (child spawns, parent resumes, retries) loops back to this
# same local server instead of calling InvokeAgentRuntime.
AGENTCORE_LOCAL_URL="http://localhost:8080"

# ── AWS / Bedrock (agent model calls) ──
AWS_DEFAULT_REGION="$REGION"

# ── Graph store (docker-compose memgraph) — used by graph tools ──
GRAPH_BOLT_URL="bolt://localhost:7687"
GRAPH_AUTH="none"

# ── Document query tools (LanceDB on S3, shared with the deployed stack) ──
LANCEDB_BUCKET="$LANCEDB_BUCKET"

# ── Web origin for links in owner emails (Team Lead owner-email tool) ──
PUBLIC_APP_URL="http://localhost:3000"
EOF
echo "→ Wrote $WORKER_ENV"

# ── Sanity check: OAuth callback registration ────────────────────────────────
# better-auth handles the OAuth callback on the API origin, so the app client
# must have http://localhost:4000/api/auth/callback/cognito registered.

EXPECTED_CALLBACK="http://localhost:4000/api/auth/callback/cognito"
CALLBACKS_JSON="$(aws cognito-idp describe-user-pool-client --user-pool-id "$USER_POOL_ID" \
  --client-id "$CLIENT_ID" --region "$REGION" \
  --query 'UserPoolClient.CallbackURLs' --output json)"

if ! echo "$CALLBACKS_JSON" | jq -e --arg cb "$EXPECTED_CALLBACK" '(. // []) | index($cb) != null' >/dev/null; then
  echo ""
  echo "⚠ warning: the Cognito app client does not have the API callback URL registered:"
  echo "    $EXPECTED_CALLBACK"
  echo "  currently registered:"
  echo "$CALLBACKS_JSON" | jq -r '(. // []) | if length == 0 then "    (none)" else .[] | "    " + . end'
  echo "  Sign-in will fail with a redirect_mismatch until it is added, e.g.:"
  ALL_CALLBACKS="$(echo "$CALLBACKS_JSON" | jq -r --arg cb "$EXPECTED_CALLBACK" '((. // []) + [$cb]) | map("\"" + . + "\"") | join(" ")')"
  echo "    aws cognito-idp update-user-pool-client --user-pool-id $USER_POOL_ID \\"
  echo "      --client-id $CLIENT_ID --region $REGION \\"
  echo "      --callback-urls $ALL_CALLBACKS \\"
  echo "      --allowed-o-auth-flows code --allowed-o-auth-scopes email openid profile \\"
  echo "      --allowed-o-auth-flows-user-pool-client --supported-identity-providers COGNITO"
fi

echo ""
echo "✓ Done. Start the stack with:"
echo "    pnpm db:local:up               # postgres, electric, streams, memgraph"
echo "    pnpm db:migrate                # apply drizzle migrations"
echo "    pnpm run dev                   # api :4000, web :3000, worker :8080"
