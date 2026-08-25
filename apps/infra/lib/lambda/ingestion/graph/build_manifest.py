"""Pre-Map step — BuildManifest.

Reconciles the knowledge bucket against the `document` table and writes the list
of files that still need processing to a manifest the Distributed Map iterates.
No API involvement: users can drop files straight into S3 and this stage creates
their tracking rows.

Flow:
  1. List every object in the knowledge bucket (source of truth for what EXISTS).
  2. Load the `document` table (source of truth for what's PROCESSED).
  3. For any S3 object without a row, INSERT a `pending` row (self-healing).
  4. Select the pending set: files whose graph OR vector index is not `indexed`
     — or ALL files when the execution input sets replaceExisting=true.
  5. Write [{"bucket","key"}, ...] to s3://<semantic>/manifests/pending.json.

Input (execution input, forwarded by the state machine):
    {"replaceExisting": <bool, default false>}

Output: {"manifest_bucket", "manifest_key", "pending": <int>, "total": <int>}

DB creds: DB_SECRET_ARN + DB_ADDRESS (+ DB_NAME), mirroring write_status.py.
"""

from __future__ import annotations

import json
import logging
import os
from urllib.parse import quote

import boto3
import psycopg

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("build_manifest")

s3 = boto3.client("s3")
_secrets = boto3.client("secretsmanager")

KNOWLEDGE_BUCKET = os.environ["KNOWLEDGE_BUCKET"]
MANIFEST_BUCKET = os.environ["MANIFEST_BUCKET"]
MANIFEST_KEY = os.environ.get("MANIFEST_KEY", "manifests/pending.json")

# Only these types are ingestible; others in the bucket are ignored entirely.
SUPPORTED_SUFFIXES = (".pdf", ".docx", ".pptx", ".xlsx")

_cached_url: str | None = None


def _database_url() -> str:
    global _cached_url
    if _cached_url:
        return _cached_url
    url = os.environ.get("DATABASE_URL")
    if url:
        _cached_url = url
        return url
    secret_arn = os.environ["DB_SECRET_ARN"]
    host = os.environ["DB_ADDRESS"]
    name = os.environ.get("DB_NAME", "application")
    secret = json.loads(_secrets.get_secret_value(SecretId=secret_arn)["SecretString"])
    _cached_url = (
        f"postgresql://{quote(secret['username'])}:{quote(secret['password'])}@{host}/{name}"
    )
    return _cached_url


def _document_id(file_name: str) -> str:
    """Match the ingest Lambda's id: 'doc-' + sha256(fileName)[:12]."""
    import hashlib

    return "doc-" + hashlib.sha256(file_name.encode("utf-8")).hexdigest()[:12]


def _list_knowledge_keys() -> list[str]:
    keys: list[str] = []
    token: str | None = None
    while True:
        kwargs = {"Bucket": KNOWLEDGE_BUCKET}
        if token:
            kwargs["ContinuationToken"] = token
        page = s3.list_objects_v2(**kwargs)
        for obj in page.get("Contents", []):
            key = obj.get("Key")
            if key and key.lower().endswith(SUPPORTED_SUFFIXES):
                keys.append(key)
        if page.get("IsTruncated"):
            token = page.get("NextContinuationToken")
        else:
            break
    return keys


def handler(event: dict, _context) -> dict:
    replace_existing = bool((event or {}).get("replaceExisting", False))
    keys = _list_knowledge_keys()
    log.info("knowledge bucket: %d ingestible object(s)", len(keys))

    pending: list[dict] = []
    with psycopg.connect(_database_url(), autocommit=True) as conn:
        with conn.cursor() as cur:
            # Existing per-key status.
            cur.execute(
                'SELECT "sourceKey", "indexStatus", "graphIndexStatus" FROM "document"'
            )
            status = {
                r[0]: (r[1], r[2]) for r in cur.fetchall()
            }

            for key in keys:
                file_name = key.rsplit("/", 1)[-1]
                if key not in status:
                    # File dropped straight into S3 — create its tracking row.
                    cur.execute(
                        'INSERT INTO "document" '
                        '("sourceKey", "fileName", "documentId", '
                        ' "indexStatus", "graphIndexStatus") '
                        "VALUES (%(k)s, %(n)s, %(d)s, 'pending', 'pending') "
                        'ON CONFLICT ("sourceKey") DO NOTHING',
                        {"k": key, "n": file_name, "d": _document_id(file_name)},
                    )
                    pending.append({"bucket": KNOWLEDGE_BUCKET, "key": key})
                    continue

                idx, gidx = status[key]
                if replace_existing or idx != "indexed" or gidx != "indexed":
                    pending.append({"bucket": KNOWLEDGE_BUCKET, "key": key})

    s3.put_object(
        Bucket=MANIFEST_BUCKET,
        Key=MANIFEST_KEY,
        Body=json.dumps(pending).encode("utf-8"),
        ContentType="application/json",
    )
    log.info(
        "manifest: %d/%d pending -> s3://%s/%s (replaceExisting=%s)",
        len(pending), len(keys), MANIFEST_BUCKET, MANIFEST_KEY, replace_existing,
    )
    return {
        "manifest_bucket": MANIFEST_BUCKET,
        "manifest_key": MANIFEST_KEY,
        "pending": len(pending),
        "total": len(keys),
    }
