import { BoltGraphProvider } from "./bolt-provider";
import { graphBoltUrl } from "./bolt-client";
import { EmptyGraphProvider, type GraphProvider } from "./provider";

/**
 * The active graph provider. Bolt-backed (Memgraph locally, Neptune with
 * GRAPH_AUTH=sigv4) when a bolt URL is configured via GRAPH_BOLT_URL or
 * MEMGRAPH_URL; the empty placeholder otherwise so the UI renders cleanly
 * without graph infrastructure.
 */
export const graphProvider: GraphProvider = graphBoltUrl()
  ? new BoltGraphProvider()
  : new EmptyGraphProvider();

export * from "./types";
export * from "./provider";
export * from "./overview";
export * from "./queries";
export * from "./seed";
export { graphBoltUrl, runQuery, toInt, toNumber, toPlain } from "./bolt-client";
