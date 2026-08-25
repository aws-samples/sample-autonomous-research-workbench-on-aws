"""Stage 2 — Extract.

Distributed-Map item processor step #2. Reads the ingested-text artifact stage
1 wrote to the semantic bucket, runs ontology-steered Bedrock triple extraction,
and writes the resolved/validated infons back as a JSON artifact.

Input (stage 1's pointer output):
    {"document_id", "title", "content_hash", "text_key", "status", ...}

Output (small pointer payload — infons stay in S3):
    {"document_id", "infons_key", "infon_count", "chunks", "failed_chunks",
     "macros", "micros", "tags", "status", ...}

Skipped/failed upstream items pass straight through untouched.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import os

import boto3

from extract import extract_document
from ontology import load_ontology

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("extract")

s3 = boto3.client("s3")

SEMANTIC_BUCKET = os.environ["SEMANTIC_BUCKET"]
INFONS_PREFIX = os.environ.get("INFONS_PREFIX", "infons")

# load_ontology reads the bundled ontology.json; cache across warm invocations.
_ontology = None


def _get_ontology():
    global _ontology
    if _ontology is None:
        _ontology = load_ontology()
    return _ontology


def handler(event: dict, _context) -> dict:
    if event.get("status") != "ingested":
        # Unsupported/failed object from stage 1 — nothing to extract.
        return event

    ontology = _get_ontology()

    obj = s3.get_object(Bucket=SEMANTIC_BUCKET, Key=event["text_key"])
    doc = json.loads(obj["Body"].read())
    text = doc["text"]
    content_hash = doc["content_hash"]

    infons, stats = extract_document(text, content_hash, ontology)
    classification = ontology.classify(text)

    infons_key = f"{INFONS_PREFIX}/{event['document_id']}.json"
    payload = {
        "document_id": event["document_id"],
        "title": event.get("title"),
        "source_key": event.get("source_key"),
        "page_count": event.get("page_count"),
        "infons": [dataclasses.asdict(i) for i in infons],
        "classification": {
            "macros": classification.macros,
            "micros": classification.micros,
            "tags": classification.tags,
        },
    }
    s3.put_object(
        Bucket=SEMANTIC_BUCKET,
        Key=infons_key,
        Body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )
    log.info(
        "%s: %d infons (%d chunks, %d failed) -> s3://%s/%s",
        event.get("title"), stats["infons"], stats["chunks"],
        stats["failed_chunks"], SEMANTIC_BUCKET, infons_key,
    )

    return {
        "document_id": event["document_id"],
        "title": event.get("title"),
        "source_key": event.get("source_key"),
        "page_count": event.get("page_count"),
        "infons_key": infons_key,
        "infon_count": stats["infons"],
        "chunks": stats["chunks"],
        "failed_chunks": stats["failed_chunks"],
        "status": "extracted",
    }
