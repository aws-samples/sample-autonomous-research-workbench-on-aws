# Local Electric Streams (durable-streams) server.
#
# There is no official prebuilt image for the durable-streams server, so we run
# the reference Node server (`@durable-streams/server`) in a small container.
# This is the dev/testing server; for production use the Caddy plugin.
FROM node:22-alpine

WORKDIR /app

# The server package is versioned independently from the client; the wire
# protocol is compatible across these. Pin to the current latest server.
RUN npm install @durable-streams/server@0.3.7

COPY server.mjs ./server.mjs

ENV PORT=4437
ENV HOST=0.0.0.0
ENV DATA_DIR=/data

# Drop root. The server writes stream data to DATA_DIR, so that has to be owned
# by the unprivileged user (node, shipped by node:22-alpine) before we switch.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 4437

# Liveness: confirm the data plane is accepting connections. This is the dev
# server; the prod image's equivalent check lives in durable-streams-stack.ts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "require('node:net').connect(4437, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"]

CMD ["node", "server.mjs"]
