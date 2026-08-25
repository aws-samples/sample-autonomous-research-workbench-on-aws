"""Stage 3 — WriteGraph.

Distributed-Map item processor step #3. Reads the infons artifact stage 2 wrote
and MERGEs the document, its infons, and its Macro/Micro/Tag classification into
the graph (Neptune over Bolt, SigV4 IAM auth).

Input (stage 2's pointer output, plus run_at threaded in via the map's
itemSelector from the pre-Map WriteOntology step):
    {"document_id", "title", "source_key", "page_count", "infons_key",
     "status", "run_at", ...}

Output: {"document_id", "infon_count", "status"}
"""

from __future__ import annotations

import json
import logging
import os

import boto3

from extract import ExtractedInfon
from graph_store import GraphStore
from ontology import DocumentClassification

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("write_graph")

s3 = boto3.client("s3")

SEMANTIC_BUCKET = os.environ["SEMANTIC_BUCKET"]


def handler(event: dict, _context) -> dict:
    if event.get("status") != "extracted":
        # Skipped/failed upstream — nothing to write.
        return event

    obj = s3.get_object(Bucket=SEMANTIC_BUCKET, Key=event["infons_key"])
    data = json.loads(obj["Body"].read())

    infons = [ExtractedInfon(**i) for i in data["infons"]]
    cls = data["classification"]
    classification = DocumentClassification(
        macros=cls["macros"], micros=cls["micros"], tags=cls["tags"]
    )

    store = GraphStore()
    try:
        store.write_document(
            document_id=data["document_id"],
            title=data["title"] or data["document_id"],
            source_path=data.get("source_key") or "",
            page_count=data.get("page_count") or 0,
            ingested_at=event.get("run_at") or "",
            infons=infons,
            classification=classification,
        )
    finally:
        store.close()

    log.info(
        "%s: wrote %d infons to graph", data.get("title"), len(infons)
    )
    return {
        "document_id": data["document_id"],
        "source_key": data.get("source_key"),
        "title": data.get("title"),
        "infon_count": len(infons),
        "status": "written",
    }
