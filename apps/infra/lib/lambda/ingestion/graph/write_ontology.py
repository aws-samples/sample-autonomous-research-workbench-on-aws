"""Pre-Map step — WriteOntology.

Runs once before the Distributed Map fans out. MERGEs the taxonomy skeleton,
the closed predicate vocabulary, and the curated entities into the graph so
every per-document write lands against an ontology that already exists.

Input:  {} (ignored)
Output: {"status": "ontology_written", "run_at": "<iso8601>", <ontology counts>}
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from graph_store import GraphStore
from ontology import load_ontology

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("write_ontology")


def handler(event: dict, _context) -> dict:
    ontology = load_ontology()
    store = GraphStore()
    try:
        store.write_ontology(ontology)
    finally:
        store.close()

    return {
        "status": "ontology_written",
        # Threaded to each document write as its ingested_at timestamp.
        "run_at": datetime.now(timezone.utc).isoformat(),
        "macros": len(ontology.macros),
        "predicates": len(ontology.predicates),
        "entities": len(ontology.entity_records),
    }
