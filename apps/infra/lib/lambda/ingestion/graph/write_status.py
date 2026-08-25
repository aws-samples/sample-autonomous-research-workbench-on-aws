"""Post-branch step — WriteStatus.

Runs after the Parallel state's graph and semantic branches join. Upserts the
document's row in Postgres, flipping each index's per-document status to
`indexed` or `failed` based on how its branch finished, so a later run can skip
already-processed files and the UI can show per-document progress.

Input (the Parallel state's output — an array of the two branch results, in
branch order: [graphBranch, semanticBranch]):
    [
      {"document_id", "source_key", "status": "written"|"skipped"|..., ...},
      {"document_id", "records": <int>, "status": "embedded"|"skipped"|...},
    ]

The two branches share the same source_key/document_id (both descend from the
Ingest output), so either element identifies the document.

DB connection: DATABASE_URL, or DB_USER/DB_PASSWORD/DB_ADDRESS/DB_NAME (the
Secrets-Manager-backed values wired by the stack), mirroring
packages/database/client.ts.
"""

from __future__ import annotations

import json
import logging
import os
from urllib.parse import quote

import boto3
import psycopg

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("write_status")

# Branch status -> IndexStatus enum value.
_GRAPH_OK = {"written", "skipped"}
_SEMANTIC_OK = {"embedded", "skipped"}


_secrets = boto3.client("secretsmanager")
_cached_url: str | None = None


def _database_url() -> str:
    """Build the DSN. Prefers DATABASE_URL; otherwise fetches the RDS-managed
    secret named by DB_SECRET_ARN (username/password) and combines it with
    DB_ADDRESS/DB_NAME. Cached across warm invocations."""
    global _cached_url
    if _cached_url:
        return _cached_url

    url = os.environ.get("DATABASE_URL")
    if url:
        _cached_url = url
        return url

    secret_arn = os.environ.get("DB_SECRET_ARN")
    host = os.environ.get("DB_ADDRESS")
    name = os.environ.get("DB_NAME", "application")
    if not (secret_arn and host):
        raise RuntimeError("Set DATABASE_URL, or DB_SECRET_ARN + DB_ADDRESS")

    secret = json.loads(_secrets.get_secret_value(SecretId=secret_arn)["SecretString"])
    user = quote(secret["username"])
    pw = quote(secret["password"])
    _cached_url = f"postgresql://{user}:{pw}@{host}/{name}"
    return _cached_url


def _branch(results: list, idx: int) -> dict:
    """Safely pull branch `idx` from the Parallel output; {} if missing/null."""
    if isinstance(results, list) and len(results) > idx and isinstance(results[idx], dict):
        return results[idx]
    return {}


def handler(event, _context) -> dict:
    # The Parallel state emits an array; the map itemSelector also puts the
    # per-file {source_key,...} on the state, but outputPath on the branches
    # means `event` here is the branches array.
    graph = _branch(event, 0)
    semantic = _branch(event, 1)

    # Either branch carries the identity (both descend from Ingest).
    source_key = graph.get("source_key") or semantic.get("source_key")
    document_id = graph.get("document_id") or semantic.get("document_id")
    file_name = (source_key or "").rsplit("/", 1)[-1]

    if not source_key:
        log.warning("no source_key in branch results; skipping status write")
        return {"status": "no_source_key"}

    graph_status = "indexed" if graph.get("status") in _GRAPH_OK else "failed"
    index_status = "indexed" if semantic.get("status") in _SEMANTIC_OK else "failed"

    errors = [
        f"{name}: {r.get('error')}"
        for name, r in (("graph", graph), ("semantic", semantic))
        if r.get("error")
    ]
    last_error = ("; ".join(errors))[:2000] or None

    # Upsert on the unique sourceKey. Timestamps set only when that index
    # actually reached `indexed`.
    sql = """
    INSERT INTO "document"
      ("sourceKey", "fileName", "documentId",
       "indexStatus", "indexedAt",
       "graphIndexStatus", "graphIndexedAt", "lastError")
    VALUES
      (%(key)s, %(name)s, %(doc)s,
       %(idx)s::"IndexStatus",
       CASE WHEN %(idx)s = 'indexed' THEN now() ELSE NULL END,
       %(gidx)s::"IndexStatus",
       CASE WHEN %(gidx)s = 'indexed' THEN now() ELSE NULL END,
       %(err)s)
    ON CONFLICT ("sourceKey") DO UPDATE SET
      "fileName" = EXCLUDED."fileName",
      "documentId" = COALESCE(EXCLUDED."documentId", "document"."documentId"),
      "indexStatus" = EXCLUDED."indexStatus",
      "indexedAt" = COALESCE(EXCLUDED."indexedAt", "document"."indexedAt"),
      "graphIndexStatus" = EXCLUDED."graphIndexStatus",
      "graphIndexedAt" = COALESCE(EXCLUDED."graphIndexedAt", "document"."graphIndexedAt"),
      "lastError" = EXCLUDED."lastError",
      "updatedAt" = now()
    """
    params = {
        "key": source_key,
        "name": file_name,
        "doc": document_id,
        "idx": index_status,
        "gidx": graph_status,
        "err": last_error,
    }

    with psycopg.connect(_database_url(), autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)

    log.info(
        "status for %s: index=%s graph=%s", source_key, index_status, graph_status
    )
    return {
        "source_key": source_key,
        "document_id": document_id,
        "index_status": index_status,
        "graph_index_status": graph_status,
        "status": "recorded",
    }
