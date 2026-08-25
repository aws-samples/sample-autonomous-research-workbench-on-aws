# Build context is the MONOREPO ROOT (CDK builds this image from the repo root
# via ContainerImage.fromAsset), because @workbench/web depends on the @repo/*
# workspace packages and the shared pnpm lockfile.
FROM node:24-slim AS builder

WORKDIR /app

# Copy workspace config files from monorepo root
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Activate the exact pnpm pinned in package.json's "packageManager" via corepack
RUN corepack enable && corepack install

# Copy the web app and workspace dependencies
COPY apps/web ./apps/web
COPY packages ./packages

# Install dependencies
RUN pnpm install --frozen-lockfile

# Vite inlines VITE_* env vars at build time
ARG VITE_SERVICE_URL
ENV VITE_SERVICE_URL=$VITE_SERVICE_URL

# Build the app (Nitro bundles everything into .output/)
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN pnpm --filter @workbench/web build

FROM node:24-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# Nitro output is self-contained — no node_modules needed
COPY --from=builder /app/apps/web/.output .output

EXPOSE 3000

# Drop root: the Nitro output is self-contained and read-only at runtime.
# `node` is the unprivileged user the node:24-slim image ships.
USER node

# Liveness for local `docker run`/compose. In ECS the ALB target group probes
# "/login" on 3000 (see alb-stack.ts WebTargetGroup) — same route, so the two
# agree. node:24-slim has no curl; use node's own fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/login').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", ".output/server/index.mjs"]
