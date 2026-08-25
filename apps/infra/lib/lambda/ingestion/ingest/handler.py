"""Stage 1 — Ingest.

Distributed-Map item processor step #1. Downloads one object from the knowledge
bucket, converts it to text with Docling (+ PPTX chart/notes recovery and the
Bedrock VLM fallback for image-only pages), and writes the extracted document as
a JSON artifact to the semantic bucket.

Input (from the map's itemSelector):
    {"bucket": "<knowledge-bucket>", "key": "<object-key>", "size": <int>}

Output (small pointer payload — the document text stays in S3, never inline):
    {"document_id", "title", "content_hash", "page_count", "status",
     "text_uri": "s3://<semantic-bucket>/ingested/<document_id>.json", ...}

Unsupported suffixes are skipped with status="skipped" so the map run does not
fail on stray objects (images, .DS_Store, etc.).
"""

from __future__ import annotations

import dataclasses
import json
import logging
import os
from pathlib import Path

import boto3
from docling.chunking import HybridChunker

from docling_ingest import SUPPORTED_SUFFIXES, build_converter, ingest_file

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ingest")

s3 = boto3.client("s3")

SEMANTIC_BUCKET = os.environ["SEMANTIC_BUCKET"]
INGESTED_PREFIX = os.environ.get("INGESTED_PREFIX", "ingested")

# Chunker tokenizer, pinned to an immutable commit rather than a mutable branch
# so a compromised or retagged upstream repo can't swap the model out from under
# us. Must stay in sync with the bake step in this directory's Dockerfile — the
# offline cache lookup is revision-keyed, so a mismatch fails at runtime.
TOKENIZER_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
# A public git commit hash, not a credential.
TOKENIZER_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"  # pragma: allowlist secret

# Reused across warm invocations — converter construction is expensive.
_converter = None
_chunker = None


def _converter_and_chunker():
    global _converter, _chunker
    if _converter is None:
        _converter = build_converter()
        # HybridChunker requires a tokenizer. In offline mode (HF_HUB_OFFLINE=1)
        # the default validator that constructs one from HuggingFace fails because
        # transformers can't infer model_max_length from a local-only cache. We
        # build the tokenizer ourselves: the all-MiniLM-L6-v2 weights are baked
        # into HF_HOME at image-build time, and max_tokens=256 is the model's
        # actual context window.
        from docling_core.transforms.chunker.tokenizer.huggingface import (
            HuggingFaceTokenizer,
        )
        from transformers import AutoTokenizer

        # The revision IS pinned, to the immutable commit in TOKENIZER_REVISION
        # above; bandit only recognizes a literal here and can't follow the
        # module-level constant.
        tok = AutoTokenizer.from_pretrained(  # nosec B615
            TOKENIZER_MODEL, revision=TOKENIZER_REVISION
        )
        hf_tok = HuggingFaceTokenizer(tokenizer=tok, max_tokens=256)
        _chunker = HybridChunker(tokenizer=hf_tok)
    return _converter, _chunker


def handler(event: dict, _context) -> dict:
    bucket = event["bucket"]
    key = event["key"]
    suffix = Path(key).suffix.lower()

    if suffix not in SUPPORTED_SUFFIXES:
        log.info("skipping unsupported object: %s", key)
        return {"key": key, "status": "skipped", "reason": f"unsupported {suffix}"}

    # Download to /tmp preserving the filename — ingest_file derives the stable
    # document_id and title from the file name.
    # Hardcoded /tmp is intentional (bandit B108): it is the only writable path
    # in the Lambda runtime, and it is per-execution-environment, not a shared
    # multi-tenant tmpdir. `.name` strips any directory components from the S3
    # key, so a crafted key can't traverse out of /tmp.
    local = Path("/tmp") / Path(key).name  # nosec B108
    local.parent.mkdir(parents=True, exist_ok=True)
    s3.download_file(bucket, key, str(local))
    log.info("downloaded s3://%s/%s -> %s", bucket, key, local)

    converter, chunker = _converter_and_chunker()
    doc = ingest_file(local, converter, chunker)

    text_key = f"{INGESTED_PREFIX}/{doc.document_id}.json"
    payload = {
        "document_id": doc.document_id,
        "title": doc.title,
        "source_key": key,
        "content_hash": doc.content_hash,
        "page_count": doc.page_count,
        "text": doc.text,
        "docling_chars": doc.docling_chars,
        "chart_count": doc.chart_count,
        "notes_chars": doc.notes_chars,
        "vlm_pages": doc.vlm_pages,
        "vlm_chars": doc.vlm_chars,
    }
    s3.put_object(
        Bucket=SEMANTIC_BUCKET,
        Key=text_key,
        Body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )
    log.info(
        "%s: %d chars, %d pages -> s3://%s/%s",
        doc.title, len(doc.text), doc.page_count, SEMANTIC_BUCKET, text_key,
    )

    # Return the small pointer only — Step Functions caps state at 256 KB.
    return {
        "document_id": doc.document_id,
        "title": doc.title,
        "source_key": key,
        "content_hash": doc.content_hash,
        "page_count": doc.page_count,
        "chars": len(doc.text),
        "text_uri": f"s3://{SEMANTIC_BUCKET}/{text_key}",
        "text_key": text_key,
        "status": "ingested",
    }
