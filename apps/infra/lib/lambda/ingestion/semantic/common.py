"""Shared config, Bedrock clients, and LanceDB schema for the semantic stage.

One unified multimodal vector column (Cohere Embed v4 on Bedrock) holds text
chunks, figure descriptions, page screenshots and tables in the same space, so
a single query retrieves across all of them. A Bedrock VLM describes
figures/charts at ingest time.

Adapted for the Step Functions pipeline: the LanceDB store lives in a dedicated
S3 bucket (LANCEDB_URI / LANCEDB_BUCKET); the Hatchet/Postgres coupling of the
source worker is removed.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Callable, Optional, TypeVar

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError
from lancedb.pydantic import LanceModel, Vector
from PIL import Image

logger = logging.getLogger("semantic.common")

T = TypeVar("T")

# Manual retry layer on top of botocore's adaptive retries: under the
# Distributed Map's concurrent load a throttled call that exhausts the adaptive
# budget is backed off and retried again here rather than raised immediately.
# Mirrors the graph stage (graph/bedrock.py).
_MANUAL_RETRIES = 3
_BASE_BACKOFF_S = 1.0
_RETRYABLE_ERROR_CODES = frozenset(
    {"ThrottlingException", "ServiceUnavailableException"}
)


def _default_db_uri() -> str:
    """Resolve the LanceDB location: explicit LANCEDB_URI, else s3://LANCEDB_BUCKET,
    else a local ./lancedb dir for experimentation."""
    uri = os.environ.get("LANCEDB_URI")
    if uri:
        return uri
    bucket = os.environ.get("LANCEDB_BUCKET")
    if bucket:
        return f"s3://{bucket}"
    return "./lancedb"


@dataclass
class Settings:
    db_uri: str = field(default_factory=_default_db_uri)
    table_name: str = os.environ.get("LANCEDB_TABLE", "documents")

    # Bedrock region + models. In Lambda AWS_REGION is set to the function region.
    region: str = os.environ.get(
        "BEDROCK_REGION", os.environ.get("AWS_REGION", "us-west-2")
    )
    # Cohere Embed v4 via the global cross-region inference profile.
    embed_model: str = os.environ.get("EMBED_MODEL", "global.cohere.embed-v4:0")
    # Figure/chart description model (Bedrock Converse). Defaults to the model
    # the pipeline is configured with (BEDROCK_MODEL_ID), same as the graph
    # stages, so we only manage one model subscription.
    vlm_model: str = os.environ.get(
        "VLM_MODEL",
        os.environ.get(
            "BEDROCK_MODEL_ID",
            "global.anthropic.claude-haiku-4-5-20251001-v1:0",
        ),
    )
    embed_dim: int = 1536  # Embed v4: 256..1536; must match the schema below.

    images_scale: float = 2.0
    describe_figures: bool = True
    max_describe_chars: int = 4000

    max_image_bytes: int = 4 * 1024 * 1024
    vlm_image_max_edge: int = 1568

    ann_min_rows: int = 5000

    # Per-file Bedrock fan-out. Kept low (2) because the account's per-minute
    # Bedrock quota is small: with the Distributed Map running several files at
    # once AND the graph branch hitting the same model, high per-file
    # concurrency exhausts even adaptive retries (ThrottlingException). Override
    # via INGEST_MAX_WORKERS.
    max_workers: int = int(os.environ.get("INGEST_MAX_WORKERS", "1"))
    embed_batch_size: int = int(os.environ.get("EMBED_BATCH_SIZE", "96"))
    # More retry headroom so sustained throttling is ridden out, not raised.
    max_retries: int = int(os.environ.get("BEDROCK_MAX_RETRIES", "12"))


SETTINGS = Settings()

VLM_PROMPT = (
    "Describe the attached image from a scientific / drug-discovery document "
    "for a search index. The full image is stored and can be viewed later for "
    "exact values, so you do not need to transcribe every data point — but look "
    "closely and capture the visual detail that conveys what the image shows and "
    "why it matters.\n\n"
    "If it is a chart/diagram: state the chart type, title, axis labels, and "
    "series/legend entries. Then make the important call-outs — the overall "
    "trend or pattern, the largest/smallest or outlier values, notable contrasts "
    "between series, any threshold or annotation marked on the chart, and what "
    "the figure is demonstrating. Include approximate values where they support "
    "a call-out (mark them approximate). For diagrams/flows (e.g. reaction "
    "schemes, binding modes), describe the components and how they connect. "
    "If it is a table: give its title, column headers, and a one-line summary of "
    "what it contains plus any standout figures. If it is a photo or decorative "
    "image: one sentence.\n\n"
    "Aim for a focused paragraph or a few bullet points (roughly 80-150 words) — "
    "rich on the meaningful details, not an exhaustive dump. Output ONLY the "
    "factual description — this is read by software, not a person. Do NOT address "
    "a reader, ask questions, apologise, or add meta-commentary. Do NOT list "
    "absent elements (e.g. 'no axes')."
)


# --------------------------------------------------------------------------- #
# LanceDB schema — single unified multimodal vector column
# --------------------------------------------------------------------------- #
class DocChunk(LanceModel):
    id: str
    document_id: str
    source_file: str
    file_type: str  # pdf | pptx | xlsx
    page_no: Optional[int] = None
    modality: str = "text"  # text | figure | page | table
    ref: Optional[str] = None
    caption: Optional[str] = None

    text: str
    vector: Vector(SETTINGS.embed_dim)

    image_bytes: Optional[bytes] = None


# --------------------------------------------------------------------------- #
# Bedrock: Embed v4 + VLM describe
# --------------------------------------------------------------------------- #
class Bedrock:
    def __init__(self, cfg: Settings = SETTINGS):
        self.cfg = cfg
        self.rt = boto3.client(
            "bedrock-runtime",
            region_name=cfg.region,
            config=BotoConfig(
                retries={"max_attempts": cfg.max_retries, "mode": "adaptive"},
                read_timeout=120,
                max_pool_connections=max(cfg.max_workers, 10),
            ),
        )

    def _with_retries(self, label: str, call: Callable[[], T]) -> T:
        """Invoke a Bedrock call, retrying retryable errors (throttling / service
        unavailable) with exponential backoff on top of botocore's adaptive
        retries. Re-raises the last exception if all attempts are exhausted or
        the error is non-retryable."""
        last_exc: BaseException | None = None
        for attempt in range(_MANUAL_RETRIES):
            try:
                return call()
            except ClientError as exc:
                error_code = exc.response.get("Error", {}).get("Code", "")
                if error_code not in _RETRYABLE_ERROR_CODES:
                    raise
                last_exc = exc
                time.sleep(_BASE_BACKOFF_S * (2**attempt))
        logger.warning(
            "Bedrock %s retries exhausted after %d attempts: %s",
            label, _MANUAL_RETRIES, last_exc,
        )
        raise last_exc  # type: ignore[misc]

    def _embed_invoke(self, body: dict) -> list[list[float]]:
        def call() -> list[list[float]]:
            resp = self.rt.invoke_model(
                modelId=self.cfg.embed_model, body=json.dumps(body)
            )
            out = json.loads(resp["body"].read())
            emb = out["embeddings"]
            if isinstance(emb, dict):
                return emb["float"]
            return emb

        return self._with_retries("embed", call)

    def embed_texts(self, texts: list[str], query: bool = False) -> list[list[float]]:
        if not texts:
            return []
        input_type = "search_query" if query else "search_document"
        vectors: list[list[float]] = []
        size = max(1, self.cfg.embed_batch_size)
        for start in range(0, len(texts), size):
            batch = [t or " " for t in texts[start:start + size]]
            vectors.extend(self._embed_invoke({
                "texts": batch,
                "input_type": input_type,
                "embedding_types": ["float"],
                "output_dimension": self.cfg.embed_dim,
            }))
        return vectors

    def embed_text(self, text: str, query: bool = False) -> list[float]:
        return self.embed_texts([text], query=query)[0]

    def embed_interleaved(self, text: str, png: bytes, query: bool = False) -> list[float]:
        """Image + its text context -> ONE vector (the page-like pattern)."""
        uri = "data:image/png;base64," + base64.b64encode(png).decode()
        return self._embed_invoke({
            "input_type": "search_query" if query else "search_document",
            "embedding_types": ["float"],
            "output_dimension": self.cfg.embed_dim,
            "inputs": [{
                "content": [
                    {"type": "text", "text": text or " "},
                    {"type": "image_url", "image_url": {"url": uri}},
                ]
            }],
        })[0]

    def _fit_image(self, png: bytes) -> bytes:
        """Shrink a crop over max_image_bytes so the Converse call stays under
        Bedrock's hard 5 MiB image limit. Best-effort."""
        if len(png) <= self.cfg.max_image_bytes:
            return png
        try:
            img = Image.open(io.BytesIO(png))
            img.load()
        except Exception as e:  # noqa: BLE001
            logger.warning("could not open image to resize (%s); sending as-is", e)
            return png

        edge = self.cfg.vlm_image_max_edge
        out = png
        for _ in range(6):
            w, h = img.size
            longest = max(w, h)
            if longest > edge:
                scale = edge / longest
                resized = img.resize((max(1, int(w * scale)), max(1, int(h * scale))))
            else:
                resized = img
            buf = io.BytesIO()
            resized.save(buf, format="PNG")
            out = buf.getvalue()
            if len(out) <= self.cfg.max_image_bytes:
                return out
            edge = int(edge * 0.75)
        return out

    def describe(self, png: bytes) -> str:
        png = self._fit_image(png)
        resp = self._with_retries("describe", lambda: self.rt.converse(
            modelId=self.cfg.vlm_model,
            messages=[{
                "role": "user",
                "content": [
                    {"image": {"format": "png", "source": {"bytes": png}}},
                    {"text": VLM_PROMPT},
                ],
            }],
            inferenceConfig={"maxTokens": 550, "temperature": 0},
        ))
        txt = resp["output"]["message"]["content"][0]["text"]
        return txt[: self.cfg.max_describe_chars]
