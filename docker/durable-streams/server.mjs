import { DurableStreamTestServer } from "@durable-streams/server";

const port = Number(process.env.PORT ?? 4437);
const host = process.env.HOST ?? "0.0.0.0";
const dataDir = process.env.DATA_DIR ?? "/data";

const server = new DurableStreamTestServer({ port, host, dataDir });

async function main() {
  await server.start();
  console.log(`Durable Streams server listening on http://${host}:${port}`);
}

const shutdown = async () => {
  console.log("Shutting down Durable Streams server...");
  await server.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  console.error("Failed to start Durable Streams server", error);
  process.exit(1);
});
