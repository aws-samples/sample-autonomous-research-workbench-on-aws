# AgentCore Runtime image: the worker's run processors behind the AgentCore
# invocation contract (POST /invocations, GET /ping on :8080). Build context
# is the MONOREPO ROOT because @workbench/worker depends on the @repo/* workspace
# packages and the shared pnpm lockfile. AgentCore requires linux/arm64.
FROM node:24 AS builder

WORKDIR /app

# Copy workspace config files from monorepo root
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Activate the exact pnpm pinned in package.json's "packageManager" via corepack
RUN corepack enable && corepack install

# Copy the worker app and workspace dependencies
COPY apps/worker ./apps/worker
COPY packages ./packages

# Production dependencies only. tsx is a runtime dependency here (the worker
# executes workspace TS sources directly, same as `pnpm dev`).
RUN pnpm install --frozen-lockfile --prod

# ── Cert stage ──────────────────────────────────────────────────────────────
# AWS publishes a single PEM bundle covering all RDS regions and CAs; the
# database client (packages/database/client.ts) reads it via
# RDS_CA_BUNDLE_PATH for Aurora TLS.
FROM node:24 AS certs
RUN curl -fsSL -o /rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    && chmod 0444 /rds-global-bundle.pem

FROM node:24-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Aurora TLS: CA bundle for the pg Pool's ssl option.
COPY --from=certs /rds-global-bundle.pem /certs/rds-global-bundle.pem
ENV RDS_CA_BUNDLE_PATH=/certs/rds-global-bundle.pem

# System CA bundle for native (Rust/rustls) TLS clients — LanceDB's S3 client
# probes the system store, which node:24-slim doesn't ship ("no native root CA
# certificates found"). Node itself uses its bundled CAs and is unaffected.
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/etc/ssl/certs

# Copy workspace config
COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./

# Copy worker source (tsx runs TS directly, no build step needed)
COPY --from=builder /app/apps/worker ./apps/worker

# Copy all packages (needed at runtime since tsx resolves workspace TS sources)
COPY --from=builder /app/packages ./packages

# Copy installed dependencies (pnpm store + workspace symlinks).
COPY --from=builder /app/node_modules ./node_modules

# AgentCore routes InvokeAgentRuntime traffic to this port.
EXPOSE 8080

# Drop root. `node` is the unprivileged user the node:24-slim image ships.
# In deployed environments LANCEDB_BUCKET is always set (agentcore-runtime-stack)
# so the vector store is S3-backed, but client.ts falls back to a relative
# ./lancedb path when it isn't — chown /app so a local `docker run` without that
# env var can still write instead of failing on a root-owned directory.
RUN chown -R node:node /app
USER node

# Liveness via the AgentCore /ping contract (agentcore-server.ts). It reports
# HealthyBusy while segments are in flight, so a 200 is the right signal here —
# a busy worker is healthy. node:24-slim has no curl; use node's own fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8080/ping').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Run through the package's tsx binary (pnpm places bins per-package) —
# SIGTERM must reach the node process directly (no shell wrapper) so the
# session shuts down promptly when AgentCore stops it.
WORKDIR /app/apps/worker
CMD ["./node_modules/.bin/tsx", "src/agentcore.ts"]
