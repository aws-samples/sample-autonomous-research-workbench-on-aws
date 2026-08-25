/**
 * Bolt-backed GraphProvider. Reads the reified infon graph from Memgraph or
 * Neptune (see bolt-client.ts for auth/dialect notes) and serves it in the
 * viewer shape: infons collapsed to labeled entity→entity links.
 */
import { runQuery, toInt, toNumber, toPlain } from "./bolt-client";
import { trimToBudget, type GraphBudget } from "./overview";
import {
  DOC_EDGE_QUERIES,
  DOC_INDEX_QUERY,
  DOC_INFON_EDGE_QUERY,
  DOC_NODE_QUERIES,
  ENTITY_NODE_QUERY,
  ENTITY_SEARCH_QUERY,
  FRONTIER_EXPAND_QUERY,
  INFON_EDGE_QUERY,
  ONTOLOGY_ENTITY_QUERY,
  ONTOLOGY_MACRO_QUERY,
  ONTOLOGY_PREDICATE_QUERY,
  ONTOLOGY_TAG_QUERY,
  ONTOLOGY_USAGE_QUERY,
  STATS_DOC_QUERY,
  STATS_EDGE_QUERY,
  STATS_NODE_QUERY,
} from "./queries";
import type { GraphDocumentIndexEntry, GraphProvider } from "./provider";
import type {
  DocumentGraph,
  EntitySearchResult,
  GraphLink,
  GraphNode,
  GraphOverview,
  GraphStats,
  OntologyView,
} from "./types";

export class BoltGraphProvider implements GraphProvider {
  async overview(budget: GraphBudget): Promise<GraphOverview> {
    // Fetch the whole entity/fact layer and trim in TS: the degree ranking
    // needs global fact counts anyway, and filtering here avoids pushing a
    // budget-sized IN $names list at Neptune. The route caches the result.
    const entities = await this.nodeQuery("Entity", ENTITY_NODE_QUERY, {});
    const links = await this.infonQuery(INFON_EDGE_QUERY, {});
    return trimToBudget(entities, links, budget);
  }

  async searchEntities(
    q: string,
    limit: number,
  ): Promise<EntitySearchResult[]> {
    const rows = await runQuery(ENTITY_SEARCH_QUERY, {
      q,
      limit: toInt(limit),
    });
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        name: String(r.name),
        kind: r.kind == null ? null : String(r.kind),
        canonicalId: r.canonical_id == null ? null : String(r.canonical_id),
        curated: r.curated === true,
        degree: toNumber(r.degree),
      };
    });
  }

  async expand(name: string, limit: number): Promise<DocumentGraph> {
    const rows = await runQuery(FRONTIER_EXPAND_QUERY, {
      names: [name],
      limit: toInt(limit),
    });

    // Frontier rows carry both endpoints inline; synthesize the entity nodes
    // from them instead of a second round-trip.
    const nodes = new Map<string, GraphNode>();
    const links: GraphLink[] = [];
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      for (const end of ["source", "target"] as const) {
        const id = String(r[end]);
        if (nodes.has(id)) continue;
        nodes.set(id, {
          id,
          label: id,
          kind: "Entity",
          properties: {
            entity_kind: toPlain(r[`${end}_kind`]),
            curated: r[`${end}_curated`] === true,
          },
        });
      }
      links.push({
        source: String(r.source),
        target: String(r.target),
        type: "INFON",
        id: String(r.id),
        label: String(r.predicate),
        properties: {
          subject: toPlain(r.subject),
          predicate: String(r.predicate),
          object: toPlain(r.object),
          polarity: toPlain(r.polarity),
          confidence: toPlain(r.confidence),
          in_vocab: toPlain(r.in_vocab),
          domain_range_ok: toPlain(r.domain_range_ok),
          document_id: toPlain(r.document_id),
        },
      });
    }
    return { nodes: [...nodes.values()], links };
  }

  async neighbourhood(documentId: string): Promise<DocumentGraph> {
    return this.buildGraph(
      DOC_NODE_QUERIES,
      DOC_EDGE_QUERIES,
      DOC_INFON_EDGE_QUERY,
      { documentId },
    );
  }

  private async buildGraph(
    nodeQueries: { kind: GraphNode["kind"]; cypher: string }[],
    edgeQueries: [string, string][],
    infonQuery: string,
    params: Record<string, unknown>,
  ): Promise<DocumentGraph> {
    const nodes: GraphNode[] = [];
    for (const { kind, cypher } of nodeQueries) {
      nodes.push(...(await this.nodeQuery(kind, cypher, params)));
    }

    const links: GraphLink[] = [];
    for (const [type, cypher] of edgeQueries) {
      const rows = await runQuery<{ s: unknown; t: unknown }>(cypher, params);
      for (const row of rows) {
        links.push({ source: String(row.s), target: String(row.t), type });
      }
    }

    links.push(...(await this.infonQuery(infonQuery, params)));
    return { nodes, links };
  }

  private async nodeQuery(
    kind: GraphNode["kind"],
    cypher: string,
    params: Record<string, unknown>,
  ): Promise<GraphNode[]> {
    const rows = await runQuery(cypher, params);
    return rows.map((row) => {
      const { id, label, ...rest } = row as Record<string, unknown>;
      const properties: NonNullable<GraphNode["properties"]> = {};
      for (const [k, v] of Object.entries(rest)) {
        properties[k] = toPlain(v);
      }
      return { id: String(id), label: String(label ?? id), kind, properties };
    });
  }

  private async infonQuery(
    cypher: string,
    params: Record<string, unknown>,
  ): Promise<GraphLink[]> {
    const rows = await runQuery(cypher, params);
    return rows.map((row) => {
      const { id, source, target, predicate, ...rest } = row as Record<
        string,
        unknown
      >;
      const properties: NonNullable<GraphLink["properties"]> = {
        predicate: String(predicate),
      };
      for (const [k, v] of Object.entries(rest)) {
        properties[k] = toPlain(v);
      }
      return {
        source: String(source),
        target: String(target),
        type: "INFON" as const,
        id: String(id),
        label: String(predicate),
        properties,
      };
    });
  }

  async stats(): Promise<GraphStats> {
    const nodeRows = await runQuery<{ label: string; n: unknown }>(
      STATS_NODE_QUERY,
    );
    const edgeRows = await runQuery<{ type: string; n: unknown }>(
      STATS_EDGE_QUERY,
    );
    const docRows = await runQuery<{
      id: string;
      title: string;
      infonCount: unknown;
    }>(STATS_DOC_QUERY);

    const nodesByLabel: Record<string, number> = {};
    for (const row of nodeRows) nodesByLabel[row.label] = toNumber(row.n);
    const edgesByType: Record<string, number> = {};
    for (const row of edgeRows) edgesByType[row.type] = toNumber(row.n);

    return {
      totalNodes: Object.values(nodesByLabel).reduce((a, b) => a + b, 0),
      totalEdges: Object.values(edgesByType).reduce((a, b) => a + b, 0),
      nodesByLabel,
      edgesByType,
      documents: docRows.map((r) => ({
        id: r.id,
        title: r.title,
        infonCount: toNumber(r.infonCount),
      })),
    };
  }

  async documentIndex(): Promise<GraphDocumentIndexEntry[]> {
    const rows = await runQuery<{ id: unknown; ingestedAt: unknown }>(
      DOC_INDEX_QUERY,
    );
    return rows.map((row) => ({
      id: String(row.id),
      ingestedAt: row.ingestedAt == null ? null : String(row.ingestedAt),
    }));
  }

  async ontology(): Promise<OntologyView> {
    const macroRows = await runQuery<{ macro: string; micro: string }>(
      ONTOLOGY_MACRO_QUERY,
    );
    const tagRows = await runQuery<{ micro: string; tag: string }>(
      ONTOLOGY_TAG_QUERY,
    );
    const entityRows = await runQuery<{
      name: string;
      kind: string;
      canonicalId: string | null;
    }>(ONTOLOGY_ENTITY_QUERY);
    const predicateRows = await runQuery<{
      name: string;
      description: string | null;
      domainKinds: string | null;
      rangeKinds: string | null;
    }>(ONTOLOGY_PREDICATE_QUERY);
    const usageRows = await runQuery<{ predicate: string; n: unknown }>(
      ONTOLOGY_USAGE_QUERY,
    );

    const microsByMacro: Record<string, string[]> = {};
    for (const row of macroRows) {
      (microsByMacro[row.macro] ??= []).push(row.micro);
    }

    const tagsByMicro: Record<string, string[]> = {};
    for (const row of tagRows) {
      (tagsByMicro[row.micro] ??= []).push(row.tag);
    }

    const usage: Record<string, number> = {};
    for (const row of usageRows) usage[row.predicate] = toNumber(row.n);

    const entitiesByKind: OntologyView["entitiesByKind"] = {};
    for (const row of entityRows) {
      (entitiesByKind[row.kind] ??= []).push({
        name: row.name,
        canonicalId: row.canonicalId,
      });
    }

    return {
      taxonomy: Object.entries(microsByMacro).map(([macro, micros]) => ({
        macro,
        micros: micros.map((micro) => ({
          micro,
          tags: tagsByMicro[micro] ?? [],
        })),
      })),
      entitiesByKind,
      predicates: predicateRows.map((p) => ({
        name: p.name,
        description: p.description ?? "",
        domainKinds: p.domainKinds ?? "",
        rangeKinds: p.rangeKinds ?? "",
        usageCount: usage[p.name] ?? 0,
      })),
    };
  }
}
