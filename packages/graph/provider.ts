import type { GraphBudget } from "./overview";
import type {
  DocumentGraph,
  EntitySearchResult,
  GraphOverview,
  GraphStats,
  OntologyView,
} from "./types";

/**
 * A source of knowledge-graph views. Implementations isolate the graph
 * backend (Memgraph locally, Amazon Neptune in production) from the rest of
 * the application so the relational document routes never depend on graph
 * infrastructure.
 */
export interface GraphProvider {
  /**
   * Return the corpus entity network trimmed to the budget: the
   * most-connected entities and the facts among them, as collapsed
   * entity→entity links. Never the whole graph — at corpus scale (hundreds
   * of thousands of nodes) that is unusable in a browser.
   */
  overview(budget: GraphBudget): Promise<GraphOverview>;

  /**
   * Search entities by name substring, ranked by degree (fact count).
   */
  searchEntities(q: string, limit: number): Promise<EntitySearchResult[]>;

  /**
   * Return the one-hop fact neighbourhood of an entity: every fact touching
   * it, with both endpoint entities, capped at `limit` facts.
   */
  expand(name: string, limit: number): Promise<DocumentGraph>;

  /**
   * Return the neighbourhood graph for a single document.
   */
  neighbourhood(documentId: string): Promise<DocumentGraph>;

  /**
   * Return node/edge counts by label/type plus per-document infon counts.
   */
  stats(): Promise<GraphStats>;

  /**
   * Return the taxonomy tree, curated entities, and predicate vocabulary
   * with live usage counts.
   */
  ontology(): Promise<OntologyView>;

  /**
   * Return every Document node's id and ingestion timestamp. Cheap listing
   * used to reconcile the relational graphIndexStatus columns.
   */
  documentIndex(): Promise<GraphDocumentIndexEntry[]>;
}

export interface GraphDocumentIndexEntry {
  id: string;
  ingestedAt: string | null;
}

/**
 * Placeholder provider used when no graph store is configured. Returns a
 * graph containing only the document node so the UI renders cleanly without
 * any edges.
 */
export class EmptyGraphProvider implements GraphProvider {
  async overview(): Promise<GraphOverview> {
    return { nodes: [], links: [], total: { nodes: 0, edges: 0 } };
  }

  async searchEntities(): Promise<EntitySearchResult[]> {
    return [];
  }

  async expand(): Promise<DocumentGraph> {
    return { nodes: [], links: [] };
  }

  async neighbourhood(documentId: string): Promise<DocumentGraph> {
    return {
      nodes: [{ id: documentId, label: documentId, kind: "Document" }],
      links: [],
    };
  }

  async stats(): Promise<GraphStats> {
    return {
      totalNodes: 0,
      totalEdges: 0,
      nodesByLabel: {},
      edgesByType: {},
      documents: [],
    };
  }

  async ontology(): Promise<OntologyView> {
    return { taxonomy: [], entitiesByKind: {}, predicates: [] };
  }

  async documentIndex(): Promise<GraphDocumentIndexEntry[]> {
    return [];
  }
}
