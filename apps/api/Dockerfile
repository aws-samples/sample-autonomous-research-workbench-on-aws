# Build context is the MONOREPO ROOT, because @workbench/api depends on the
# @repo/* workspace packages and the shared pnpm lockfile.
FROM node:24 AS builder

WORKDIR /app

# Copy workspace config files from monorepo root
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Activate the exact pnpm pinned in package.json's "packageManager" via corepack
RUN corepack enable && corepack install

# Copy the api app and workspace dependencies
COPY apps/api ./apps/api
COPY packages ./packages

# Install production dependencies. We install here with Node's pnpm and copy the
# resulting node_modules into the Bun runner, because running pnpm under Bun
# fails (Bun lacks the node:sqlite built-in pnpm relies on).
RUN pnpm install --frozen-lockfile --prod

# ── Cert stage ──────────────────────────────────────────────────────────────
# AWS publishes a single PEM bundle covering all RDS regions and CAs; the
# database client (packages/database/client.ts) reads it via
# RDS_CA_BUNDLE_PATH for Aurora TLS.
FROM node:24 AS certs
RUN curl -fsSL -o /rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    && chmod 0444 /rds-global-bundle.pem

FROM oven/bun:1 AS runner

WORKDIR /app

# Production runtime: the logger only loads pino-pretty (a devDependency, not
# present after --prod) when NODE_ENV !== "production", so this must be set.
ENV NODE_ENV=production
ENV PORT=4000

# Aurora TLS: CA bundle for the pg Pool's ssl option.
COPY --from=certs /rds-global-bundle.pem /certs/rds-global-bundle.pem
ENV RDS_CA_BUNDLE_PATH=/certs/rds-global-bundle.pem

# Copy workspace config
COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./

# Copy api app source (bun runs TS directly, no build step needed)
COPY --from=builder /app/apps/api ./apps/api

# Copy all packages (needed at runtime since bun resolves workspace TS sources)
COPY --from=builder /app/packages ./packages

# Copy installed dependencies. pnpm hoists to a root node_modules with a .pnpm
# store plus per-package node_modules (workspace symlinks), so we bring all of
# them over rather than re-running pnpm inside the Bun image.
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 4000

# Drop root: the runtime only reads its own bundle, so it needs no write access
# anywhere in /app. `bun` is the unprivileged user the oven/bun image ships.
USER bun

# Liveness for local `docker run`/compose. In ECS the ALB target group probes
# "/" on 4000 (see alb-stack.ts ApiTargetGroup) — same route, so the two agree.
# The bun image has no curl; Bun's fetch is always present.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:4000/'); process.exit(r.ok ? 0 : 1)"]

CMD ["bun", "run", "apps/api/src/index.ts"]
