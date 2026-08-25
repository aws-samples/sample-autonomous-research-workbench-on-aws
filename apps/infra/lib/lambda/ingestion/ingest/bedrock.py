"""Bedrock Converse client for structured extraction via Claude.

Copied (near-verbatim) from infon_core.llm.bedrock on the
feat/extraction-quality-tiers branch. Returns ``None`` on credential errors,
timeouts, or exhausted retries so the caller can skip the chunk gracefully.

Configuration is environment-driven:

* ``BEDROCK_MODEL_ID`` — model to invoke (default:
  ``us.anthropic.claude-haiku-4-5-20251001-v1:0``).
* ``BEDROCK_REGION`` / ``AWS_DEFAULT_REGION`` — region for the
  bedrock-runtime client (default: ``us-east-1``).
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any

import boto3
from botocore.exceptions import (
    BotoCoreError,
    ClientError,
    NoCredentialsError,
    ReadTimeoutError,
)

logger = logging.getLogger(__name__)

DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
MODEL_ID_ENV = "BEDROCK_MODEL_ID"
REGION_ENV = "BEDROCK_REGION"
REGION_ENV_FALLBACK = "AWS_DEFAULT_REGION"
DEFAULT_REGION = "us-east-1"

_MAX_RETRIES = 3
_BASE_BACKOFF_S = 1.0

_RETRYABLE_ERROR_CODES = frozenset(
    {"ThrottlingException", "ServiceUnavailableException"}
)

_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)```\s*$", re.DOTALL)

_client: Any = None


def _build_client() -> Any:
    global _client
    if _client is None:
        region = (
            os.environ.get(REGION_ENV)
            or os.environ.get(REGION_ENV_FALLBACK)
            or DEFAULT_REGION
        )
        _client = boto3.client("bedrock-runtime", region_name=region)
    return _client


def _strip_code_fences(text: str) -> str:
    m = _CODE_FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text


def invoke_model(prompt: str, system: str | None = None) -> dict | list | None:
    """Call Bedrock Converse and return the parsed JSON response, or None."""
    model_id = os.environ.get(MODEL_ID_ENV) or DEFAULT_MODEL_ID

    kwargs: dict[str, Any] = {
        "modelId": model_id,
        "messages": [{"role": "user", "content": [{"text": prompt}]}],
    }
    if system:
        kwargs["system"] = [{"text": system}]

    try:
        client = _build_client()
    except (NoCredentialsError, BotoCoreError) as exc:
        logger.warning("Bedrock client creation failed: %s", exc)
        return None

    last_exc: BaseException | None = None
    for attempt in range(_MAX_RETRIES):
        try:
            response = client.converse(**kwargs)
            text = response["output"]["message"]["content"][0]["text"]
            return json.loads(_strip_code_fences(text))

        except ClientError as exc:
            error_code = exc.response.get("Error", {}).get("Code", "")
            if error_code in _RETRYABLE_ERROR_CODES:
                last_exc = exc
                time.sleep(_BASE_BACKOFF_S * (2**attempt))
                continue
            logger.warning("Bedrock non-retryable ClientError: %s", exc)
            return None

        except (ReadTimeoutError, BotoCoreError) as exc:
            logger.warning("Bedrock timeout or BotoCore error: %s", exc)
            return None

        except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
            logger.warning("Bedrock response parse error: %s", exc)
            return None

    logger.warning(
        "Bedrock retries exhausted after %d attempts: %s", _MAX_RETRIES, last_exc
    )
    return None


_DESCRIBE_PROMPT = (
    "This image is a slide or page from a small-molecule drug-discovery "
    "document (inhibitor programs, SAR, ADMET/PK, biochemical & biophysical "
    "assays, computational modeling). Transcribe and describe its "
    "content comprehensively and factually:\n"
    "- all readable text, verbatim\n"
    "- tables as markdown\n"
    "- chart data: series names, categories, approximate values, trends\n"
    "- diagrams: the entities shown and how they relate\n"
    "Output plain text only, no preamble. If the image contains no "
    "informative content (decoration, logo, photo without text), reply "
    "with exactly: NONE"
)


def describe_image(png: bytes, context: str | None = None) -> str | None:
    """Describe/transcribe one PNG image via Converse. Returns None on failure
    or when the model reports no informative content."""
    model_id = os.environ.get(MODEL_ID_ENV) or DEFAULT_MODEL_ID
    prompt = _DESCRIBE_PROMPT + (f"\n\nDocument: {context}" if context else "")

    kwargs: dict[str, Any] = {
        "modelId": model_id,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"image": {"format": "png", "source": {"bytes": png}}},
                    {"text": prompt},
                ],
            }
        ],
        "inferenceConfig": {"maxTokens": 2000},
    }

    try:
        client = _build_client()
    except (NoCredentialsError, BotoCoreError) as exc:
        logger.warning("Bedrock client creation failed: %s", exc)
        return None

    last_exc: BaseException | None = None
    for attempt in range(_MAX_RETRIES):
        try:
            response = client.converse(**kwargs)
            text = response["output"]["message"]["content"][0]["text"].strip()
            return None if text == "NONE" or not text else text

        except ClientError as exc:
            error_code = exc.response.get("Error", {}).get("Code", "")
            if error_code in _RETRYABLE_ERROR_CODES:
                last_exc = exc
                time.sleep(_BASE_BACKOFF_S * (2**attempt))
                continue
            logger.warning("Bedrock non-retryable ClientError: %s", exc)
            return None

        except (ReadTimeoutError, BotoCoreError) as exc:
            logger.warning("Bedrock timeout or BotoCore error: %s", exc)
            return None

        except (KeyError, IndexError, TypeError) as exc:
            logger.warning("Bedrock response parse error: %s", exc)
            return None

    logger.warning(
        "Bedrock describe retries exhausted after %d attempts: %s",
        _MAX_RETRIES, last_exc,
    )
    return None
