import { ORPCError } from "@orpc/server";
import {
  PROJECT_EG_AFFECTED_ENTITIES_QUERY,
  PROJECT_EG_AFFECTS_EDGES_QUERY,
  PROJECT_EG_DECISIONS_QUERY,
  PROJECT_EG_DERIVED_ENTITIES_QUERY,
  PROJECT_EG_DERIVED_FROM_EDGES_QUERY,
  PROJECT_EG_EVIDENCE_EDGES_QUERY,
  PROJECT_EG_HYPOTHESES_QUERY,
  PROJECT_EG_INFORMING_ENTITIES_QUERY,
  PROJECT_EG_INFORMS_EDGES_QUERY,
  PROJECT_EG_OBSERVATIONS_QUERY,
  runQuery,
  toInt,
  toNumber,
} from "@repo/graph";
import * as z from "zod";

import { admin, authorized } from "../context";

/**
 * The graph routes speak portable openCypher via `@repo/graph`'s `runQuery`
 * (Bolt to Memgraph in dev, Neptune SigV4 in prod). `runQuery` returns raw
 * driver records, so integer-valued parameters are wrapped with `toInt` (the
 * driver otherwise sends floats, which LIMIT rejects) and returned values are
 * flattened to plain JSON with `deepPlain`.
 */

/** Recursively convert neo4j driver values (Integer, arrays, maps) to JSON. */
function deepPlain(value: unknown): unknown {
  if (value && typeof value === "object" && "toNumber" in value) {
    return toNumber(value);
  }
  if (Array.isArray(value)) {
    return value.map(deepPlain);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = deepPlain(val);
    }
    return out;
  }
  return value;
}

type Row = Record<string, unknown>;

/** Run an openCypher query, converting integer params and flattening results. */
async function cypher(
  query: string,
  parameters: Record<string, unknown> = {},
): Promise<Row[]> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    params[key] =
      typeof value === "number" && Number.isInteger(value)
        ? toInt(value)
        : value;
  }
  const rows = await runQuery<Row>(query, params);
  return rows.map((row) => deepPlain(row) as Row);
}

/**
 * Schema discovery for the graph, the openCypher equivalent of what
 * graph-explorer's Schema Explorer shows: node labels, relationship types,
 * and the properties observed on each.
 *
 * Property discovery samples nodes (bounded by `sampleSize`) rather than
 * scanning the whole graph, so it stays cheap on large datasets.
 */

const NodeLabel = z.object({
  label: z.string(),
  count: z.number(),
  properties: z.array(z.string()),
});

const EdgeType = z.object({
  type: z.string(),
  count: z.number(),
});

const GraphSchema = z.object({
  nodeLabels: z.array(NodeLabel),
  edgeTypes: z.array(EdgeType),
});

export const getSchema = authorized
  .route({
    method: 'GET',
    path: '/graph/schema',
    tags: ['Graph'],
    description:
      'Discover the graph schema: node labels, relationship types, and sampled properties per label.',
  })
  .input(
    z.object({
      sampleSize: z.number().int().positive().max(10000).default(1000),
    }),
  )
  .output(GraphSchema)
  .handler(async ({ input }) => {
    const [labelRows, edgeRows, propertyRows] = await Promise.all([
      // Node labels with counts.
      cypher("MATCH (n) RETURN labels(n) AS labels, count(*) AS count"),
      // Relationship types with counts.
      cypher("MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count"),
      // Property keys per label, from a bounded sample of nodes.
      cypher(
        `MATCH (n)
         WITH n LIMIT $sampleSize
         UNWIND labels(n) AS label
         UNWIND keys(n) AS key
         RETURN label, collect(DISTINCT key) AS properties`,
        { sampleSize: input.sampleSize },
      ),
    ]);

    // Sampled property keys keyed by label.
    const propsByLabel = new Map<string, string[]>();
    for (const row of propertyRows) {
      const label = String(row.label);
      const properties = Array.isArray(row.properties)
        ? (row.properties as unknown[]).map(String)
        : [];
      propsByLabel.set(label, properties);
    }

    // `labels(n)` yields an array; flatten so each label is counted once.
    const labelCounts = new Map<string, number>();
    for (const row of labelRows) {
      const count = Number(row.count ?? 0);
      const labels = Array.isArray(row.labels) ? (row.labels as unknown[]) : [];
      for (const raw of labels) {
        const label = String(raw);
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + count);
      }
    }

    const nodeLabels = [...labelCounts.entries()]
      .map(([label, count]) => ({
        label,
        count,
        properties: propsByLabel.get(label) ?? [],
      }))
      .sort((a, b) => b.count - a.count);

    const edgeTypes = edgeRows
      .map((row) => ({ type: String(row.type), count: Number(row.count ?? 0) }))
      .sort((a, b) => b.count - a.count);

    return { nodeLabels, edgeTypes };
  });

export const clearGraph = admin
  .route({
    method: 'POST',
    path: '/graph/clear',
    tags: ['Graph'],
    description: 'Detach-delete every node in the graph and report how many were removed.',
  })
  .output(z.object({ deleted: z.number() }))
  .handler(async () => {
    try {
      const [before] = await cypher("MATCH (n) RETURN count(n) AS count");
      await cypher("MATCH (n) DETACH DELETE n");

      return { deleted: Number(before?.count ?? 0) };
    } catch (error) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: error instanceof Error ? error.message : "Clear failed",
      });
    }
  });

/**
 * Fetch the actual graph (nodes + relationships) for the Cluster view.
 *
 * Uses the internal `id()` for stable node identity (works on both Neo4j and
 * Neptune openCypher) and derives a display name from common property keys.
 * Bounded by `limit` so a large graph can't overwhelm the client.
 */
const GraphNode = z.object({
  id: z.string(),
  label: z.string(),
  group: z.string(),
  properties: z.record(z.string(), z.unknown()),
});

const GraphLink = z.object({
  source: z.string(),
  target: z.string(),
  relation: z.string(),
});

const GraphData = z.object({
  nodes: z.array(GraphNode),
  links: z.array(GraphLink),
});

function displayName(
  properties: Record<string, unknown>,
  group: string,
  id: string,
): string {
  const candidate =
    properties.name ?? properties.title ?? properties.id ?? properties.label;
  return candidate != null ? String(candidate) : `${group} ${id}`;
}

function toProperties(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstLabel(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? String(value[0]) : "Node";
}

/**
 * Display name for an epistemic node. These carry no `name`/`title` — a
 * hypothesis or observation is identified by its `claim` and a decision by its
 * `description`, all free text — so the label is that sentence, clipped to
 * something a node caption can carry. The full text stays in `properties` for
 * the detail panel.
 */
const EG_LABEL_MAX = 80;

function egLabel(
  properties: Record<string, unknown>,
  group: string,
  id: string,
): string {
  const candidate = properties.claim ?? properties.description;
  if (candidate == null) return `${group} ${id}`;
  const text = String(candidate).trim();
  if (text.length === 0) return `${group} ${id}`;
  return text.length > EG_LABEL_MAX
    ? `${text.slice(0, EG_LABEL_MAX - 1).trimEnd()}…`
    : text;
}

export const getGraph = authorized
  .route({
    method: "GET",
    path: "/graph",
    tags: ["Graph"],
    description:
      "Fetch nodes and relationships for the cluster view, bounded by `limit`.",
  })
  .input(
    z.object({ limit: z.number().int().positive().max(5000).default(500) }),
  )
  .output(GraphData)
  .handler(async ({ input }) => {
    const [nodeRows, edgeRows] = await Promise.all([
      cypher(
        "MATCH (n) RETURN id(n) AS id, labels(n) AS labels, properties(n) AS props LIMIT $limit",
        { limit: input.limit },
      ),
      cypher(
        `MATCH (a)-[r]->(b)
         RETURN id(a) AS source, id(b) AS target, type(r) AS relation
         LIMIT $limit`,
        { limit: input.limit },
      ),
    ]);

    const nodes = new Map<string, z.infer<typeof GraphNode>>();
    for (const row of nodeRows) {
      const id = String(row.id);
      const group = firstLabel(row.labels);
      const properties = toProperties(row.props);
      nodes.set(id, {
        id,
        group,
        properties,
        label: displayName(properties, group, id),
      });
    }

    // Keep only links whose endpoints are within the fetched node set.
    const links = edgeRows
      .map((row) => ({
        source: String(row.source),
        target: String(row.target),
        relation: String(row.relation),
      }))
      .filter((l) => nodes.has(l.source) && nodes.has(l.target));

    return { nodes: [...nodes.values()], links };
  });

/**
 * Fetch the project-scoped EPISTEMIC graph for a project workspace's graph tab.
 *
 * The reasoning tier — the (:Hypothesis), (:Observation), and (:Decision) nodes
 * the agents authored under this project via the graph-epistemic tools, joined
 * by their typed edges (supports/contradicts, informs_decision, affects) — plus
 * the (:Entity) nodes that reasoning directly cites, reached by derived_from,
 * affects, and informs_decision. Those entities are what the reasoning is
 * *about*, so a hypothesis can be read against its compounds and targets.
 *
 * Still excluded is the rest of the factual tier: reified (:Infon) triples,
 * (:Document) nodes, and entities more than one hop from the reasoning — shared
 * corpus-wide, and they would bury the handful of nodes a project view is about.
 * Entities appear as leaves; no entity-to-entity fact edges are drawn.
 *
 * Returns the same `GraphData` shape the cluster view consumes so both share the
 * renderer. Nodes come from per-label queries rather than the edges, so an
 * isolated node still shows: the seed hypothesis has no evidence on the
 * activation turn.
 */
export const getProjectGraph = authorized
  .route({
    method: "GET",
    path: "/graph/project",
    tags: ["Graph"],
    description:
      "Fetch a project's epistemic graph: the hypotheses, observations, and decisions its agents authored, joined by evidence and decision edges.",
  })
  .input(
    z.object({
      projectId: z.string().min(1),
      limit: z.number().int().positive().max(5000).default(500),
    }),
  )
  .output(GraphData)
  .handler(async ({ input }) => {
    const params = { projectId: input.projectId, limit: input.limit };

    const [
      hypothesisRows,
      observationRows,
      decisionRows,
      derivedEntityRows,
      affectedEntityRows,
      informingEntityRows,
      evidenceEdges,
      informsEdges,
      affectsEdges,
      derivedFromEdges,
    ] = await Promise.all([
      cypher(PROJECT_EG_HYPOTHESES_QUERY, params),
      cypher(PROJECT_EG_OBSERVATIONS_QUERY, params),
      cypher(PROJECT_EG_DECISIONS_QUERY, params),
      cypher(PROJECT_EG_DERIVED_ENTITIES_QUERY, params),
      cypher(PROJECT_EG_AFFECTED_ENTITIES_QUERY, params),
      cypher(PROJECT_EG_INFORMING_ENTITIES_QUERY, params),
      cypher(PROJECT_EG_EVIDENCE_EDGES_QUERY, params),
      cypher(PROJECT_EG_INFORMS_EDGES_QUERY, params),
      cypher(PROJECT_EG_AFFECTS_EDGES_QUERY, params),
      cypher(PROJECT_EG_DERIVED_FROM_EDGES_QUERY, params),
    ]);

    // Each query matches a single label, so the group comes from which query
    // produced the row. The three entity queries are one group: an entity can be
    // reached by more than one edge kind, and `nodes` is keyed by id, so
    // whichever row lands last wins — they describe the same node either way.
    const labelled: [string, Row[]][] = [
      ["Hypothesis", hypothesisRows],
      ["Observation", observationRows],
      ["Decision", decisionRows],
      ["Entity", derivedEntityRows],
      ["Entity", affectedEntityRows],
      ["Entity", informingEntityRows],
    ];

    const nodes = new Map<string, z.infer<typeof GraphNode>>();
    for (const [group, rows] of labelled) {
      for (const row of rows) {
        // Entities with no `name` cannot be addressed by the edge queries, which
        // key on it, so they'd be unreachable leaves; skip rather than emit a
        // node id of "null" that silently collides with every other such row.
        if (row.id == null) continue;
        const id = String(row.id);
        const properties = toProperties(row.props);
        nodes.set(id, {
          id,
          group,
          properties,
          // Entities carry a `name`; the EG nodes carry free-text claim /
          // description that needs clipping to fit a node caption.
          label:
            group === "Entity"
              ? displayName(properties, group, id)
              : egLabel(properties, group, id),
        });
      }
    }

    // Keep only edges whose endpoints are both in the fetched node set. That
    // filter is what bounds the view: an `informs_decision` edge from another
    // project's observation, or an `affects` edge onto an entity the queries
    // above didn't fetch, drops out rather than dragging a foreign node in.
    const links = [
      ...evidenceEdges,
      ...informsEdges,
      ...affectsEdges,
      ...derivedFromEdges,
    ]
      .map((row) => ({
        source: String(row.source),
        target: String(row.target),
        relation: String(row.relation),
      }))
      .filter((l) => nodes.has(l.source) && nodes.has(l.target));

    return { nodes: [...nodes.values()], links };
  });

/**
 * Static placeholder for the "Knowledge Graph" metric tile.
 * Avoids querying the graph database for global node and relationship counts.
 */
export const getStats = authorized
  .route({
    method: "GET",
    path: "/graph/stats",
    tags: ["Graph"],
    description: 'Static placeholder for the "Knowledge Graph" metric tile.',
  })
  .input(z.object({}))
  .output(z.object({ value: z.literal("X") }))
  .handler(() => ({ value: "X" }));

/**
 * Hypothesis metric: total Hypothesis nodes and how many were created in the
 * last 7 days (based on the numeric `createdAt` epoch-ms property).
 * Hypotheses without a `createdAt` are excluded from the weekly delta.
 */
export const getHypothesisStats = authorized
  .route({
    method: "GET",
    path: "/graph/hypothesis-stats",
    tags: ["Graph"],
    description:
      "Total Hypothesis nodes and how many were created in the last 7 days.",
  })
  .input(z.object({}))
  .output(z.object({ total: z.number(), lastWeek: z.number() }))
  .handler(async () => {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const [totalRow] = await cypher(
      "MATCH (n:Hypothesis) RETURN count(n) AS count",
    );
    const [weekRow] = await cypher(
      "MATCH (n:Hypothesis) WHERE n.createdAt >= $since RETURN count(n) AS count",
      { since },
    );

    return {
      total: Number(totalRow?.count ?? 0),
      lastWeek: Number(weekRow?.count ?? 0),
    };
  });
