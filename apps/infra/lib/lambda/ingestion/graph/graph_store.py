"""Neptune-dialect openCypher graph writer over Bolt.

Works against Memgraph locally (bolt://localhost:7688, no auth) and against a
real Amazon Neptune cluster (bolt+ssc://<cluster>:8182 + GRAPH_AUTH=sigv4)
without code changes. The Cypher stays inside Neptune's openCypher subset —
the constraints validated on the feat/extraction-quality-tiers branch:

* no list properties (provenance via (:Document)-[:HAS_INFON]->(:Infon) edges)
* coalesce() instead of IS NULL property predicates
* deterministic MERGE keys, fully parameterized queries
* max_connection_lifetime kept under the ~5 min SigV4 token window

Environment:
* GRAPH_BOLT_URL  — default bolt://localhost:7688
* GRAPH_AUTH      — "none" (default, Memgraph) or "sigv4" (Neptune)
* AWS_DEFAULT_REGION / AWS_REGION — SigV4 region (required for sigv4)
"""

from __future__ import annotations

import logging
import os
from urllib.parse import urlparse

import neo4j

from extract import ExtractedInfon
from ontology import DocumentClassification, Ontology

log = logging.getLogger(__name__)

DEFAULT_BOLT_URL = "bolt://localhost:7688"

# ── Write Cypher (Neptune dialect: no list props, parameterized MERGE) ───────

_MERGE_DOCUMENT = """
MERGE (d:Document {id: $document_id})
SET d.title = $title,
    d.source_path = $source_path,
    d.page_count = $page_count,
    d.ingested_at = $ingested_at
"""

_MERGE_INFON = """
MATCH (d:Document {id: $document_id})
MERGE (i:Infon {infon_id: $infon_id})
SET i.subject = $subject,
    i.predicate = $predicate,
    i.object = $object,
    i.polarity = $polarity,
    i.confidence = $confidence,
    i.verified_by = 'llm',
    i.in_vocab = $in_vocab,
    i.domain_range_ok = $domain_range_ok,
    i.document_id = $document_id
MERGE (d)-[:HAS_INFON]->(i)
MERGE (s:Entity {name: $subject})
SET s.kind = coalesce($subject_kind, s.kind),
    s.canonical_id = coalesce($subject_canonical_id, s.canonical_id)
MERGE (i)-[:S_OF]->(s)
MERGE (o:Entity {name: $object})
SET o.kind = coalesce($object_kind, o.kind),
    o.canonical_id = coalesce($object_canonical_id, o.canonical_id)
MERGE (i)-[:O_OF]->(o)
"""

_DOC_MACRO = (
    "MATCH (d:Document {id: $document_id}) "
    "MERGE (m:Macro {name: $name}) MERGE (d)-[:IN_MACRO]->(m)"
)
_DOC_MICRO = (
    "MATCH (d:Document {id: $document_id}) "
    "MERGE (mi:Micro {name: $name}) MERGE (d)-[:IN_MICRO]->(mi)"
)
_DOC_TAG = (
    "MATCH (d:Document {id: $document_id}) "
    "MERGE (t:Tag {name: $name}) MERGE (d)-[:TAGGED]->(t)"
)

# Ontology-as-graph: taxonomy skeleton + predicate vocabulary nodes.
_MERGE_MACRO = "MERGE (m:Macro {name: $name})"
_MERGE_MICRO = (
    "MERGE (m:Macro {name: $macro}) "
    "MERGE (mi:Micro {name: $name}) "
    "MERGE (m)-[:HAS_MICRO]->(mi)"
)
_MERGE_TAG = (
    "MERGE (mi:Micro {name: $micro}) "
    "MERGE (t:Tag {name: $name}) "
    "MERGE (mi)-[:HAS_TAG]->(t)"
)
_MERGE_PREDICATE = """
MERGE (p:Predicate {name: $name})
SET p.description = $description,
    p.domain_kinds = $domain_kinds,
    p.range_kinds = $range_kinds
"""
_MERGE_CURATED_ENTITY = """
MERGE (e:Entity {name: $name})
SET e.kind = $kind,
    e.canonical_id = $canonical_id,
    e.curated = true
"""

_COUNT_NODES_BY_LABEL = "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS n"
_COUNT_EDGES_BY_TYPE = "MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS n"


class GraphStore:
    def __init__(self, bolt_url: str | None = None):
        self._url = bolt_url or os.environ.get("GRAPH_BOLT_URL", DEFAULT_BOLT_URL)
        auth_mode = os.environ.get("GRAPH_AUTH", "none").lower()

        if auth_mode == "sigv4":
            from neptune_auth import build_neptune_auth_manager

            parsed = urlparse(self._url)
            # SigV4 signatures embed the region; the Lambda runtime always
            # sets AWS_REGION to its own region, which matches Neptune's.
            region = os.environ.get("AWS_DEFAULT_REGION") or os.environ.get(
                "AWS_REGION"
            )
            if not region:
                raise RuntimeError(
                    "GRAPH_AUTH=sigv4 requires AWS_REGION or AWS_DEFAULT_REGION"
                )
            auth = build_neptune_auth_manager(
                region, parsed.hostname or "", parsed.port or 8182
            )
        else:
            auth = None

        self._driver = neo4j.GraphDatabase.driver(
            self._url,
            auth=auth,
            # Stay under Neptune's ~5-minute SigV4 token validity so an open
            # connection never presents an expired token.
            max_connection_lifetime=240,
        )

    def close(self) -> None:
        self._driver.close()

    # ── Writes ───────────────────────────────────────────────────────────

    def write_ontology(self, ontology: Ontology) -> None:
        """MERGE the taxonomy, predicate vocabulary, and curated entities."""
        with self._driver.session() as session:
            for macro, micro_map in ontology.macros.items():
                session.run(_MERGE_MACRO, name=macro)
                for micro, tags in micro_map.items():
                    session.run(_MERGE_MICRO, macro=macro, name=micro)
                    for tag in tags:
                        session.run(_MERGE_TAG, micro=micro, name=tag)
            for p in ontology.predicates:
                session.run(
                    _MERGE_PREDICATE,
                    name=p.name,
                    description=p.description,
                    domain_kinds=",".join(p.domain_kinds),
                    range_kinds=",".join(p.range_kinds),
                )
            for record in ontology.entity_records:
                session.run(
                    _MERGE_CURATED_ENTITY,
                    name=record.name,
                    kind=record.kind,
                    canonical_id=record.canonical_id,
                )
        log.info("ontology written: %d macros, %d predicates, %d entities",
                 len(ontology.macros), len(ontology.predicates),
                 len(ontology.entity_records))

    def write_document(
        self,
        *,
        document_id: str,
        title: str,
        source_path: str,
        page_count: int,
        ingested_at: str,
        infons: list[ExtractedInfon],
        classification: DocumentClassification,
    ) -> None:
        with self._driver.session() as session:
            session.run(
                _MERGE_DOCUMENT,
                document_id=document_id,
                title=title,
                source_path=source_path,
                page_count=page_count,
                ingested_at=ingested_at,
            )
            for infon in infons:
                session.run(
                    _MERGE_INFON,
                    document_id=document_id,
                    infon_id=infon.infon_id,
                    subject=infon.subject,
                    predicate=infon.predicate,
                    object=infon.object,
                    polarity=infon.polarity,
                    confidence=infon.confidence,
                    in_vocab=infon.in_vocab,
                    domain_range_ok=infon.domain_range_ok,
                    subject_kind=infon.subject_kind,
                    object_kind=infon.object_kind,
                    subject_canonical_id=infon.subject_canonical_id,
                    object_canonical_id=infon.object_canonical_id,
                )
            for macro in classification.macros:
                session.run(_DOC_MACRO, document_id=document_id, name=macro)
            for micro in classification.micros:
                session.run(_DOC_MICRO, document_id=document_id, name=micro)
            for tag in classification.tags:
                session.run(_DOC_TAG, document_id=document_id, name=tag)

    # ── Reads (for the CLI report) ───────────────────────────────────────

    def stats(self) -> dict:
        with self._driver.session() as session:
            nodes = {
                r["label"]: r["n"] for r in session.run(_COUNT_NODES_BY_LABEL)
            }
            edges = {
                r["type"]: r["n"] for r in session.run(_COUNT_EDGES_BY_TYPE)
            }
        return {
            "nodes_by_label": nodes,
            "edges_by_type": edges,
            "total_nodes": sum(nodes.values()),
            "total_edges": sum(edges.values()),
        }
