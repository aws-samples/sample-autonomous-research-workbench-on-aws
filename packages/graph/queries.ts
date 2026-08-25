/**
 * openCypher queries for the knowledge graph, kept inside Neptune's dialect:
 * linear patterns only, coalesce() over IS NULL, all parameterized. Runs
 * unchanged against Memgraph (dev) and Neptune (prod).
 *
 * Infons are STORED reified — (:Infon) nodes with S_OF/O_OF edges, because
 * Neptune has no list properties and provenance/polarity/flags live on the
 * node — but they are SERVED collapsed: one labeled entity→entity link per
 * infon, so the viewer draws the fact as an edge instead of a duplicate node.
 */
import type { GraphNode } from "./types";

// Every entity, for the corpus overview (trimmed to budget in TS).
// entity_kind/canonical_id are null for entities extracted from text but
// not (yet) resolved against the curated ontology — expected, not an error.
export const ENTITY_NODE_QUERY =
  "MATCH (n:Entity) RETURN n.name AS id, n.name AS label, " +
  "n.kind AS entity_kind, n.canonical_id AS canonical_id, " +
  "coalesce(n.curated, false) AS curated";

// One row per infon, collapsed to subject-entity → object-entity.
const INFON_EDGE_FIELDS =
  "RETURN i.infon_id AS id, s.name AS source, o.name AS target, " +
  "i.subject AS subject, i.predicate AS predicate, i.object AS object, " +
  "i.polarity AS polarity, i.confidence AS confidence, " +
  "i.in_vocab AS in_vocab, i.domain_range_ok AS domain_range_ok, " +
  "i.document_id AS document_id";

export const INFON_EDGE_QUERY =
  "MATCH (s:Entity)<-[:S_OF]-(i:Infon)-[:O_OF]->(o:Entity) " +
  INFON_EDGE_FIELDS;

// Document-scoped variants (one document + its entities + its facts).
export const DOC_NODE_QUERIES: { kind: GraphNode["kind"]; cypher: string }[] = [
  {
    kind: "Document",
    cypher:
      "MATCH (n:Document {id: $documentId}) RETURN n.id AS id, " +
      "coalesce(n.title, n.id) AS label, n.source_path AS source_path, " +
      "n.page_count AS page_count",
  },
  {
    kind: "Entity",
    cypher:
      "MATCH (:Document {id: $documentId})-[:HAS_INFON]->(:Infon)-[]->(n:Entity) " +
      "RETURN DISTINCT n.name AS id, n.name AS label, " +
      "n.kind AS entity_kind, n.canonical_id AS canonical_id, " +
      "coalesce(n.curated, false) AS curated",
  },
];

export const DOC_EDGE_QUERIES: [string, string][] = [
  [
    "MENTIONS",
    "MATCH (a:Document {id: $documentId})-[:HAS_INFON]->(:Infon)-[]->(b:Entity) " +
      "RETURN DISTINCT a.id AS s, b.name AS t",
  ],
];

export const DOC_INFON_EDGE_QUERY =
  "MATCH (:Document {id: $documentId})-[:HAS_INFON]->(i:Infon)-[:S_OF]->(s:Entity) " +
  "MATCH (i)-[:O_OF]->(o:Entity) " +
  INFON_EDGE_FIELDS;

// Lightweight listing used to reconcile Postgres graphIndexStatus columns.
export const DOC_INDEX_QUERY =
  "MATCH (d:Document) RETURN d.id AS id, d.ingested_at AS ingestedAt";

// Stats.
export const STATS_NODE_QUERY =
  "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS n";
export const STATS_EDGE_QUERY =
  "MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS n";
export const STATS_DOC_QUERY =
  "MATCH (d:Document) " +
  "OPTIONAL MATCH (d)-[:HAS_INFON]->(i:Infon) " +
  "RETURN d.id AS id, coalesce(d.title, d.id) AS title, count(i) AS infonCount " +
  "ORDER BY title";

// ── Agent graph-tool queries ────────────────────────────────────────────────
// Used by packages/agent/core/tools/graph/. Same dialect rules as above; note
// list PARAMETERS ($names) are fine on Neptune — only list PROPERTIES are not.

// Entity search with degree (fact count) so callers can rank matches.
export const ENTITY_SEARCH_QUERY =
  "MATCH (e:Entity) WHERE toLower(e.name) CONTAINS toLower($q) " +
  "OPTIONAL MATCH (e)<-[:S_OF|O_OF]-(i:Infon) " +
  "RETURN e.name AS name, e.kind AS kind, e.canonical_id AS canonical_id, " +
  "coalesce(e.curated, false) AS curated, count(i) AS degree " +
  "ORDER BY degree DESC LIMIT $limit";

export const ENTITY_SEARCH_KIND_QUERY =
  "MATCH (e:Entity) WHERE toLower(e.name) CONTAINS toLower($q) " +
  "AND e.kind = $kind " +
  "OPTIONAL MATCH (e)<-[:S_OF|O_OF]-(i:Infon) " +
  "RETURN e.name AS name, e.kind AS kind, e.canonical_id AS canonical_id, " +
  "coalesce(e.curated, false) AS curated, count(i) AS degree " +
  "ORDER BY degree DESC LIMIT $limit";

export const DOC_TITLE_SEARCH_QUERY =
  "MATCH (d:Document) WHERE toLower(coalesce(d.title, d.id)) CONTAINS toLower($q) " +
  "RETURN d.id AS id, coalesce(d.title, d.id) AS title LIMIT $limit";

export const TAG_SEARCH_QUERY =
  "MATCH (t:Tag) WHERE toLower(t.name) CONTAINS toLower($q) " +
  "RETURN t.name AS name LIMIT $limit";

// Zero-match recovery: what kinds exist (predicates come from
// ONTOLOGY_USAGE_QUERY below).
export const ENTITY_KIND_COUNT_QUERY =
  "MATCH (e:Entity) RETURN e.kind AS kind, count(e) AS n ORDER BY n DESC";

export const ENTITY_LOOKUP_QUERY =
  "MATCH (e:Entity {name: $name}) " +
  "RETURN e.name AS name, e.kind AS kind LIMIT 1";

// Frontier expansion: all facts touching any entity in $names, with both
// endpoints. One bounded call per hop keeps LIMIT control in the caller
// (multi-hop expansion and path search dedup in TS). If Neptune ever rejects
// the S_OF|O_OF alternation, the fallback is:
//   MATCH (i:Infon)-[:S_OF]->(s:Entity) MATCH (i)-[:O_OF]->(o:Entity)
//   WHERE s.name IN $names OR o.name IN $names ...
const FRONTIER_EXPAND_FIELDS =
  "RETURN DISTINCT i.infon_id AS id, s.name AS source, o.name AS target, " +
  "s.kind AS source_kind, o.kind AS target_kind, " +
  "coalesce(s.curated, false) AS source_curated, " +
  "coalesce(o.curated, false) AS target_curated, " +
  "i.subject AS subject, i.predicate AS predicate, i.object AS object, " +
  "i.polarity AS polarity, i.confidence AS confidence, " +
  "i.in_vocab AS in_vocab, i.domain_range_ok AS domain_range_ok, " +
  "i.document_id AS document_id " +
  "LIMIT $limit";

export const FRONTIER_EXPAND_QUERY =
  "MATCH (e:Entity)<-[:S_OF|O_OF]-(i:Infon) " +
  "MATCH (i)-[:S_OF]->(s:Entity) MATCH (i)-[:O_OF]->(o:Entity) " +
  "WHERE e.name IN $names " +
  FRONTIER_EXPAND_FIELDS;

export const FRONTIER_EXPAND_PREDICATE_QUERY =
  "MATCH (e:Entity)<-[:S_OF|O_OF]-(i:Infon) " +
  "MATCH (i)-[:S_OF]->(s:Entity) MATCH (i)-[:O_OF]->(o:Entity) " +
  "WHERE e.name IN $names AND i.predicate = $predicate " +
  FRONTIER_EXPAND_FIELDS;

export const DOC_TITLES_BY_IDS_QUERY =
  "MATCH (d:Document) WHERE d.id IN $ids " +
  "RETURN d.id AS id, coalesce(d.title, d.id) AS title";

// Overview: most-connected entities + the facts among them (mini-graph).
export const TOP_ENTITY_QUERY =
  "MATCH (e:Entity)<-[:S_OF|O_OF]-(i:Infon) " +
  "RETURN e.name AS name, e.kind AS kind, count(i) AS degree " +
  "ORDER BY degree DESC LIMIT $topN";

export const TOP_ENTITY_EDGE_QUERY =
  "MATCH (s:Entity)<-[:S_OF]-(i:Infon)-[:O_OF]->(o:Entity) " +
  "WHERE s.name IN $names AND o.name IN $names " +
  "RETURN i.infon_id AS id, s.name AS source, o.name AS target, " +
  "i.subject AS subject, i.predicate AS predicate, i.object AS object, " +
  "i.polarity AS polarity, i.confidence AS confidence, " +
  "i.in_vocab AS in_vocab, i.domain_range_ok AS domain_range_ok, " +
  "i.document_id AS document_id " +
  "LIMIT 200";

// Document taxonomy (per-document facts tool).
export const DOC_TAXONOMY_QUERIES: [string, string][] = [
  [
    "macro",
    "MATCH (:Document {id: $documentId})-[:IN_MACRO]->(m:Macro) RETURN m.name AS name",
  ],
  [
    "micro",
    "MATCH (:Document {id: $documentId})-[:IN_MICRO]->(m:Micro) RETURN m.name AS name",
  ],
  [
    "tag",
    "MATCH (:Document {id: $documentId})-[:TAGGED]->(t:Tag) RETURN t.name AS name",
  ],
];

// Ontology.
export const ONTOLOGY_MACRO_QUERY =
  "MATCH (m:Macro)-[:HAS_MICRO]->(mi:Micro) " +
  "RETURN m.name AS macro, mi.name AS micro ORDER BY macro, micro";
export const ONTOLOGY_TAG_QUERY =
  "MATCH (mi:Micro)-[:HAS_TAG]->(t:Tag) " +
  "RETURN mi.name AS micro, t.name AS tag ORDER BY micro, tag";
export const ONTOLOGY_ENTITY_QUERY =
  "MATCH (e:Entity) WHERE coalesce(e.curated, false) = true " +
  "RETURN e.name AS name, e.kind AS kind, e.canonical_id AS canonicalId " +
  "ORDER BY kind, name";
export const ONTOLOGY_PREDICATE_QUERY =
  "MATCH (p:Predicate) RETURN p.name AS name, p.description AS description, " +
  "p.domain_kinds AS domainKinds, p.range_kinds AS rangeKinds ORDER BY name";
export const ONTOLOGY_USAGE_QUERY =
  "MATCH (i:Infon) RETURN i.predicate AS predicate, count(i) AS n";

// ── Agent write queries ─────────────────────────────────────────────────────
// Used by the opt-in "graph-write" tool group. Same Neptune dialect as the
// ingestion writer (apps/infra/lib/lambda/ingestion/graph/graph_store.py):
// deterministic MERGE keys, coalesce() to avoid clobbering existing props,
// no list properties. Agent-authored infons are marked verified_by='agent'
// so they stay distinguishable from ingested ('llm') facts.

// Provenance stamps (created_at_ms, author_*, run ids) are coalesce-kept:
// a re-assert MERGEs onto the existing infon and must NOT refresh them —
// the research loop counts "new knowledge since watermark" on created_at_ms,
// so a refreshed stamp would make an old fact count as new again. Epoch ms
// are app-generated (portable across Memgraph/Neptune, plain numeric
// comparisons) rather than a server clock function, whose units differ
// between engines (Memgraph timestamp() is µs).
const MERGE_AGENT_INFON_CORE =
  "MERGE (i:Infon {infon_id: $infonId}) " +
  "SET i.subject = $subject, i.predicate = $predicate, i.object = $object, " +
  "i.polarity = $polarity, i.confidence = $confidence, " +
  "i.verified_by = 'agent', i.in_vocab = $inVocab, " +
  "i.document_id = $documentId, i.project_id = $projectId, " +
  "i.created_at_ms = coalesce(i.created_at_ms, $createdAtMs), " +
  "i.author_agent_id = coalesce(i.author_agent_id, $authorAgentId), " +
  "i.author_name = coalesce(i.author_name, $authorName), " +
  "i.run_id = coalesce(i.run_id, $runId), " +
  "i.root_run_id = coalesce(i.root_run_id, $rootRunId) " +
  "MERGE (s:Entity {name: $subject}) " +
  "SET s.kind = coalesce($subjectKind, s.kind) " +
  "MERGE (i)-[:S_OF]->(s) " +
  "MERGE (o:Entity {name: $object}) " +
  "SET o.kind = coalesce($objectKind, o.kind) " +
  "MERGE (i)-[:O_OF]->(o)";

export const WRITE_AGENT_INFON_QUERY =
  MERGE_AGENT_INFON_CORE + " RETURN i.infon_id AS id";

// Variant anchored on a Document for provenance: the leading MATCH means
// nothing is written (zero rows returned) when the document id is unknown.
export const WRITE_AGENT_INFON_WITH_DOC_QUERY =
  "MATCH (d:Document {id: $documentId}) " +
  MERGE_AGENT_INFON_CORE +
  " MERGE (d)-[:HAS_INFON]->(i) RETURN i.infon_id AS id";

export const PREDICATE_LOOKUP_QUERY =
  "MATCH (p:Predicate {name: $name}) RETURN p.name AS name LIMIT 1";

// The project's seed hypothesis is written to the EPISTEMIC graph as the root
// (:Hypothesis) node by the Team Lead on its activation turn (see
// seed.ts / the lead's seedHypothesis tool), reusing CREATE_HYPOTHESIS_QUERY
// below. There is no separate (:Entity {kind:'Hypothesis'}) seed node anymore:
// the loop and linkEvidence key on :Hypothesis, so the seed lives there.

// ── Research-loop queries (new knowledge since watermark) ───────────────────
// "New knowledge" = the agent REASONING accumulated since the project's
// knowledge watermark: new :Observation and :Hypothesis nodes (from the
// graph-epistemic tools), project-stamped, whose created_at_ms is strictly
// after the watermark. Raw :Infon facts (graphAddFact) are the factual
// substrate the reasoning cites — they are NOT what the loop reacts to, so the
// Team Lead's sufficiency cycle turns on observations/hypotheses, not triples.
// Nodes written before the created_at_ms stamp existed are excluded by the
// numeric comparison — acceptable: they predate the loop.
//
// One query per label (no UNION) to stay within the conservative
// linear-pattern dialect shared by Memgraph and Neptune; knowledge.ts merges
// the two streams, aggregates per author, and orders/limits in JS.

// Per-author counts for the pulse message ("5 findings from X, 2 from Y") plus
// the max timestamp, which is what the watermark advances to (never
// wall-clock "now": an in-flight write with a slightly earlier stamp must not
// end up below the watermark unseen).
export const NEW_OBSERVATIONS_COUNT_QUERY =
  "MATCH (o:Observation) " +
  "WHERE o.project_id = $projectId AND o.created_at_ms > $sinceMs " +
  "RETURN o.author_name AS author, count(o) AS n, max(o.created_at_ms) AS max_ms";

export const NEW_HYPOTHESES_COUNT_QUERY =
  "MATCH (h:Hypothesis) " +
  "WHERE h.project_id = $projectId AND h.created_at_ms > $sinceMs " +
  "RETURN h.author_name AS author, count(h) AS n, max(h.created_at_ms) AS max_ms";

// The nodes themselves, oldest first, for the lead's getNewKnowledge tool and
// the contribution-round brief. Each side over-fetches to $limit; knowledge.ts
// merges both, re-sorts oldest-first, and truncates to the true top-$limit.
export const NEW_OBSERVATIONS_QUERY =
  "MATCH (o:Observation) " +
  "WHERE o.project_id = $projectId AND o.created_at_ms > $sinceMs " +
  "RETURN o._id AS id, o.claim AS claim, o.confidence AS confidence, " +
  "o.source_tool AS source_tool, o.author_name AS author, " +
  "o.created_at_ms AS created_at_ms " +
  "ORDER BY created_at_ms LIMIT $limit";

export const NEW_HYPOTHESES_QUERY =
  "MATCH (h:Hypothesis) " +
  "WHERE h.project_id = $projectId AND h.created_at_ms > $sinceMs " +
  "RETURN h._id AS id, h.claim AS claim, h.testable_prediction AS testable_prediction, " +
  "h.status AS status, h.confidence AS confidence, h.author_name AS author, " +
  "h.created_at_ms AS created_at_ms " +
  "ORDER BY created_at_ms LIMIT $limit";

// ── Epistemic graph queries ─────────────────────────────────────────────────
// Used by the "graph-epistemic" tool group. Unlike facts (reified :Infon),
// hypotheses/observations/decisions get DEDICATED node labels with typed edges
// (supports/contradicts/derived_from/affects/informs_decision), because they
// carry a lifecycle (status) and evidence relationships that a flat triple
// can't express. Same Neptune dialect: linear patterns, coalesce() over IS
// NULL, no list properties. Every node keys on a deterministic $id and is
// stamped with project_id/run_id for scoping; created_at is coalesced so
// re-asserting a node never rewrites its birth time (or an advanced status).

// created_at_ms (numeric epoch) and author_name/run_id are coalesce-kept — a
// re-assert MERGEs onto the existing node and must NOT refresh them, exactly
// like the infon write: the research loop counts "new knowledge since the
// watermark" on created_at_ms, so a refreshed stamp would make an old node
// count as new again. generating_agent is the same value as author_name; both
// are kept so the epistemic read tools and the loop can each use their own.
export const CREATE_HYPOTHESIS_QUERY =
  "MERGE (h:Hypothesis {_id: $id}) " +
  "SET h.claim = $claim, h.testable_prediction = $testablePrediction, " +
  "h.status = coalesce(h.status, $status), h.confidence = $confidence, " +
  "h.generating_agent = $generatingAgent, h.project_id = $projectId, " +
  "h.run_id = coalesce(h.run_id, $runId), " +
  "h.author_name = coalesce(h.author_name, $authorName), " +
  "h.created_at = coalesce(h.created_at, $createdAt), " +
  "h.created_at_ms = coalesce(h.created_at_ms, $createdAtMs) " +
  "RETURN h._id AS id, h.status AS status, h.claim AS claim";

export const CREATE_OBSERVATION_QUERY =
  "MERGE (o:Observation {_id: $id}) " +
  "SET o.claim = $claim, o.confidence = $confidence, o.source_tool = $sourceTool, " +
  "o.generating_agent = $generatingAgent, o.project_id = $projectId, " +
  "o.run_id = coalesce(o.run_id, $runId), " +
  "o.author_name = coalesce(o.author_name, $authorName), " +
  "o.created_at = coalesce(o.created_at, $createdAt), " +
  "o.created_at_ms = coalesce(o.created_at_ms, $createdAtMs) " +
  "RETURN o._id AS id, o.claim AS claim";

// Links an observation to an ingested/curated entity it was derived from.
// Zero rows returned when the entity name is unknown, so the tool can report
// which sources actually resolved.
export const LINK_DERIVED_FROM_QUERY =
  "MATCH (o:Observation {_id: $observationId}) " +
  "MATCH (e:Entity {name: $entityName}) " +
  "MERGE (o)-[:derived_from]->(e) " +
  "RETURN e.name AS name";

// Evidence edges. Relationship type can't be parameterized in openCypher, so
// polarity picks between two otherwise-identical queries (both validated as an
// enum before we get here). Zero rows => one of the endpoints doesn't exist.
export const LINK_SUPPORTS_QUERY =
  "MATCH (o:Observation {_id: $observationId}) " +
  "MATCH (h:Hypothesis {_id: $hypothesisId}) " +
  "MERGE (o)-[r:supports]->(h) " +
  "SET r.weight = $weight, r.rationale = $rationale, " +
  "r.generating_agent = $generatingAgent " +
  "RETURN type(r) AS polarity";

export const LINK_CONTRADICTS_QUERY =
  "MATCH (o:Observation {_id: $observationId}) " +
  "MATCH (h:Hypothesis {_id: $hypothesisId}) " +
  "MERGE (o)-[r:contradicts]->(h) " +
  "SET r.weight = $weight, r.rationale = $rationale, " +
  "r.generating_agent = $generatingAgent " +
  "RETURN type(r) AS polarity";

export const SET_HYPOTHESIS_STATUS_QUERY =
  "MATCH (h:Hypothesis {_id: $hypothesisId}) " +
  "SET h.status = $status, h.status_reason = $reason " +
  "RETURN h._id AS id, h.status AS status";

export const RECORD_DECISION_QUERY =
  "MERGE (d:Decision {_id: $id}) " +
  "SET d.decision_type = $decisionType, d.description = $description, " +
  "d.rationale = $rationale, d.generating_agent = $generatingAgent, " +
  "d.project_id = $projectId, d.run_id = $runId, " +
  "d.created_at = coalesce(d.created_at, $createdAt) " +
  "RETURN d._id AS id";

// Decision → affected node. The target may be an Entity (keyed by name) or a
// Hypothesis (keyed by _id), so match on either. Zero rows => unresolved ref.
export const DECISION_AFFECTS_QUERY =
  "MATCH (d:Decision {_id: $decisionId}) " +
  "MATCH (t) WHERE t._id = $ref OR t.name = $ref " +
  "MERGE (d)-[:affects]->(t) " +
  "RETURN coalesce(t._id, t.name) AS ref";

// Observation/Hypothesis → Decision it informed. Same either-key match.
export const DECISION_INFORMED_BY_QUERY =
  "MATCH (d:Decision {_id: $decisionId}) " +
  "MATCH (s) WHERE s._id = $ref OR s.name = $ref " +
  "MERGE (s)-[:informs_decision]->(d) " +
  "RETURN coalesce(s._id, s.name) AS ref";

// Reads. Evidence for one hypothesis (both polarities).
export const HYPOTHESIS_EVIDENCE_QUERY =
  "MATCH (o:Observation)-[r:supports|contradicts]->(h:Hypothesis {_id: $hypothesisId}) " +
  "RETURN o._id AS observation_id, o.claim AS claim, type(r) AS polarity, " +
  "r.weight AS weight, r.rationale AS rationale";

// Project-scoped hypothesis listing, newest first. Status filter is a separate
// constant so the base query keeps a clean node-pattern match.
export const QUERY_HYPOTHESES_QUERY =
  "MATCH (h:Hypothesis {project_id: $projectId}) " +
  "RETURN h._id AS id, h.claim AS claim, " +
  "h.testable_prediction AS testable_prediction, h.status AS status, " +
  "h.confidence AS confidence, h.created_at AS created_at " +
  "ORDER BY h.created_at DESC LIMIT $limit";

export const QUERY_HYPOTHESES_STATUS_QUERY =
  "MATCH (h:Hypothesis {project_id: $projectId}) WHERE h.status = $status " +
  "RETURN h._id AS id, h.claim AS claim, " +
  "h.testable_prediction AS testable_prediction, h.status AS status, " +
  "h.confidence AS confidence, h.created_at AS created_at " +
  "ORDER BY h.created_at DESC LIMIT $limit";

// ── Epistemic-graph project view ────────────────────────────────────────────
// The project workspace's Graph tab renders the EPISTEMIC tier — the reasoning
// nodes the agents authored under this project (:Hypothesis/:Observation/
// :Decision) and the typed edges among them — plus the (:Entity) nodes that
// reasoning directly touches, so a hypothesis can be read against the compounds
// and targets it is actually about.
//
// What stays excluded is the rest of the factual substrate: reified (:Infon)
// triples, (:Document) nodes, and any entity more than one hop out. Those are
// corpus-wide and vastly outnumber the reasoning, which is what a project view
// is about. Entities therefore appear as LEAVES hanging off the reasoning that
// cites them — there are deliberately no entity-to-entity fact edges here,
// since drawing those would rebuild the fact tier inside the project view.
//
// Nodes are fetched per label rather than derived from the edges, because
// isolated nodes carry meaning here: the seed hypothesis has no evidence on the
// activation turn, and an observation may exist before it is linked. Each query
// matches exactly one label, so the caller knows the kind without projecting it.
export const PROJECT_EG_HYPOTHESES_QUERY =
  "MATCH (h:Hypothesis {project_id: $projectId}) " +
  "RETURN h._id AS id, properties(h) AS props LIMIT $limit";

export const PROJECT_EG_OBSERVATIONS_QUERY =
  "MATCH (o:Observation {project_id: $projectId}) " +
  "RETURN o._id AS id, properties(o) AS props LIMIT $limit";

export const PROJECT_EG_DECISIONS_QUERY =
  "MATCH (d:Decision {project_id: $projectId}) " +
  "RETURN d._id AS id, properties(d) AS props LIMIT $limit";

// The (:Entity) nodes this project's reasoning touches, one query per edge
// shape that can reach one. Entities are shared corpus-wide and carry no
// project_id, so they are anchored by the project-stamped EG node on the other
// end of the edge — never matched directly, which is what keeps the rest of the
// corpus out.
//
// Identity: entities key on `name`, not the `_id` the EG nodes use, so `name` is
// returned as the id. The write path MERGEs on {name: ...}, making it the
// canonical key. An entity reachable by two different edges (a decision affects
// what an observation was derived from) appears in both result sets and is
// deduplicated by id at the caller.
export const PROJECT_EG_DERIVED_ENTITIES_QUERY =
  "MATCH (o:Observation {project_id: $projectId})-[:derived_from]->(e:Entity) " +
  "RETURN e.name AS id, properties(e) AS props LIMIT $limit";

export const PROJECT_EG_AFFECTED_ENTITIES_QUERY =
  "MATCH (d:Decision {project_id: $projectId})-[:affects]->(e:Entity) " +
  "RETURN e.name AS id, properties(e) AS props LIMIT $limit";

// An entity can also be cited as informing a decision: DECISION_INFORMED_BY
// matches `s._id = $ref OR s.name = $ref`, so an entity name resolves there too.
export const PROJECT_EG_INFORMING_ENTITIES_QUERY =
  "MATCH (e:Entity)-[:informs_decision]->(d:Decision {project_id: $projectId}) " +
  "RETURN e.name AS id, properties(e) AS props LIMIT $limit";

// Edges. One query per shape — no UNION, linear patterns only, matching the
// Memgraph/Neptune dialect the rest of this module targets. Only the
// project-side endpoint is filtered on project_id; the caller drops any edge
// whose other endpoint isn't in the fetched node set, which is what excludes
// cross-project edges (another project's observation citing our hypothesis)
// while keeping the entity edges, whose endpoints the queries above fetch.
export const PROJECT_EG_DERIVED_FROM_EDGES_QUERY =
  "MATCH (o:Observation {project_id: $projectId})-[r:derived_from]->(e:Entity) " +
  "RETURN o._id AS source, e.name AS target, type(r) AS relation " +
  "LIMIT $limit";
export const PROJECT_EG_EVIDENCE_EDGES_QUERY =
  "MATCH (o:Observation {project_id: $projectId})-[r:supports|contradicts]->(h:Hypothesis) " +
  "RETURN o._id AS source, h._id AS target, type(r) AS relation " +
  "LIMIT $limit";

// informs_decision originates on an :Observation, a :Hypothesis or an :Entity,
// so the source stays untyped and is anchored by the decision's project_id.
// coalesce spans both identity schemes: _id for EG nodes, name for entities.
export const PROJECT_EG_INFORMS_EDGES_QUERY =
  "MATCH (s)-[r:informs_decision]->(d:Decision {project_id: $projectId}) " +
  "RETURN coalesce(s._id, s.name) AS source, d._id AS target, " +
  "type(r) AS relation LIMIT $limit";

// affects targets an :Entity (keyed by name) or a :Hypothesis (keyed by _id) —
// coalesce covers both.
export const PROJECT_EG_AFFECTS_EDGES_QUERY =
  "MATCH (d:Decision {project_id: $projectId})-[r:affects]->(t) " +
  "RETURN d._id AS source, coalesce(t._id, t.name) AS target, " +
  "type(r) AS relation LIMIT $limit";

// ── Project teardown ────────────────────────────────────────────────────────
// Remove everything a project wrote into the graph when the project is deleted.
// Every node the project authored is stamped with project_id: the epistemic
// reasoning nodes (:Hypothesis / :Observation / :Decision, including the seed
// hypothesis) and the agent-authored facts (:Infon). DETACH DELETE drops each
// node together with all its edges (S_OF/O_OF, supports/contradicts,
// derived_from, affects, informs_decision, HAS_INFON), so no dangling
// relationships survive. One query per label keeps the linear-pattern dialect
// shared by Memgraph and Neptune.
//
// The shared substrate is intentionally left untouched: (:Entity), (:Document),
// and the ontology (:Macro/:Micro/:Tag/:Predicate) carry no project_id and are
// referenced across projects, so an entity that another project's fact also
// points at keeps that fact — only this project's own nodes and their edges go.
// Plain DETACH DELETE per label — the most portable form across Memgraph and
// Neptune (aggregating over just-deleted nodes in the same RETURN behaves
// differently between the two, and FOREACH…DETACH DELETE isn't universally
// supported). The teardown is best-effort, so counts aren't returned.
export const DELETE_PROJECT_INFONS_QUERY =
  "MATCH (i:Infon {project_id: $projectId}) DETACH DELETE i";
export const DELETE_PROJECT_HYPOTHESES_QUERY =
  "MATCH (h:Hypothesis {project_id: $projectId}) DETACH DELETE h";
export const DELETE_PROJECT_OBSERVATIONS_QUERY =
  "MATCH (o:Observation {project_id: $projectId}) DETACH DELETE o";
export const DELETE_PROJECT_DECISIONS_QUERY =
  "MATCH (d:Decision {project_id: $projectId}) DETACH DELETE d";
