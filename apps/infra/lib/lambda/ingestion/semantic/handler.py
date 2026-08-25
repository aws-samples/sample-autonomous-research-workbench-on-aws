"""Semantic stage — parallel branch after Ingest.

Downloads the original object from the knowledge bucket, runs the multimodal
pipeline (Docling with images -> Bedrock Embed v4 / VLM describe), and appends
the resulting records to the S3-backed LanceDB vector store.

Runs its OWN Docling parse (with page/figure images) rather than reusing stage
1's text-only output — the vector store needs the image surfaces stage 1 does
not produce.

Input (stage 1 Ingest's pointer output, threaded through the map):
    {"document_id", "source_key", "status": "ingested", ...}

Output: {"document_id", "records": <int>, "status": "embedded" | "skipped"}

Concurrency: the Distributed Map runs up to 10 of these at once, all appending
to one LanceDB table on S3. LanceDB uses optimistic-concurrency commits; a
conflicting append is retried with backoff (see _add_with_retry).
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

import boto3

from common import SETTINGS
from ingest import SUPPORTED_SUFFIXES, build_ingestor, ensure_indexes, get_table

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("semantic")

s3 = boto3.client("s3")

KNOWLEDGE_BUCKET = os.environ["KNOWLEDGE_BUCKET"]

# Reused across warm invocations — converter + Bedrock client are expensive.
_ingestor = None


def _get_ingestor():
    global _ingestor
    if _ingestor is None:
        _ingestor = build_ingestor(SETTINGS)
    return _ingestor


def _add_with_retry(table, records: list[dict], attempts: int = 6) -> None:
    """Append records, retrying on the optimistic-concurrency commit conflict
    that arises when several map iterations write the same table at once."""
    delay = 1.0
    for i in range(attempts):
        try:
            table.add(records)
            return
        except Exception as e:  # noqa: BLE001 - LanceDB raises a generic commit error
            msg = str(e).lower()
            retryable = "commit" in msg or "conflict" in msg or "version" in msg
            if not retryable or i == attempts - 1:
                raise
            log.warning("LanceDB commit conflict (attempt %d/%d): %s",
                        i + 1, attempts, e)
            time.sleep(delay)
            delay *= 2


def handler(event: dict, _context) -> dict:
    if event.get("status") != "ingested":
        # Unsupported/failed object from stage 1 — nothing to embed.
        return {**event, "semantic_status": "skipped"}

    key = event["source_key"]
    document_id = event["document_id"]
    suffix = Path(key).suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        # Semantic pipeline handles pdf/pptx/xlsx; graph stage may accept more.
        log.info("semantic skip (unsupported %s): %s", suffix, key)
        return {
            "document_id": document_id,
            "source_key": key,
            "records": 0,
            "status": "skipped",
        }

    # Hardcoded /tmp is intentional (bandit B108): it is the only writable path
    # in the Lambda runtime, and it is per-execution-environment, not a shared
    # multi-tenant tmpdir. `.name` strips any directory components from the S3
    # key, so a crafted key can't traverse out of /tmp.
    local = Path("/tmp") / Path(key).name  # nosec B108
    local.parent.mkdir(parents=True, exist_ok=True)
    s3.download_file(KNOWLEDGE_BUCKET, key, str(local))

    ingestor = _get_ingestor()
    records = ingestor.ingest_file(
        local, document_id=document_id, source_name=Path(key).name
    )

    if records:
        table = get_table()
        # Idempotent re-ingest: drop this document's existing rows (keyed by its
        # document_id) before re-adding, so re-running the pipeline over the same
        # file replaces its vectors instead of accumulating duplicates. LanceDB
        # .add is a plain append, so without this every rerun doubles the rows.
        safe = document_id.replace("'", "''")
        try:
            table.delete(f"document_id = '{safe}'")
        except Exception as e:  # noqa: BLE001 - first run: nothing to delete
            log.info("no existing rows to delete for %s (%s)", document_id, e)
        _add_with_retry(table, records)
        ensure_indexes(table)

    log.info("%s: wrote %d records to LanceDB", key, len(records))
    return {
        "document_id": document_id,
        "source_key": key,
        "records": len(records),
        "status": "embedded",
    }
