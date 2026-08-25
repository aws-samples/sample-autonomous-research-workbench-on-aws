"""Ontology-steered triple extraction.

The extraction prompt is RENDERED FROM THE ONTOLOGY — the closed predicate
vocabulary (with domain/range hints) and the canonical entity catalogue
(grouped by kind, KO/EN aliases) both come from ontology.json. Post-extraction,
each triple is resolved and validated against the same ontology:

* subject/object spans resolve through the alias index -> canonical name + kind
* ``in_vocab``      — predicate is in the closed vocabulary
* ``domain_range_ok`` — subject/object kinds satisfy the predicate's
  domain/range hints. Only enforceable when the argument resolved to a curated
  entity; unresolved args pass (open-world). Violations are FLAGGED, never
  dropped — with a small curated catalogue, hard rejection would gut recall.

chunk_text / triple parsing / infon-id hashing are ported from
infon_core.pipeline.stages on the feat/extraction-quality-tiers branch
(content-addressed sha256 ids, not the doc-scoped 16-char variant).
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass

from bedrock import invoke_model
from ontology import Ontology

log = logging.getLogger(__name__)

CHUNK_TARGET_CHARS = 2000
CHUNK_OVERLAP_SENTENCES = 1
_CHUNK_SENTENCE_BOUNDARY = re.compile(r"[.!?]\s")


@dataclass(frozen=True)
class ExtractedInfon:
    infon_id: str
    subject: str  # canonical name when resolved, else raw span
    predicate: str
    object: str
    polarity: str  # "positive" | "negative"
    confidence: float  # certain -> 1.0, implied -> 0.8
    subject_kind: str | None  # entity kind when resolved
    object_kind: str | None
    subject_canonical_id: str | None
    object_canonical_id: str | None
    in_vocab: bool
    domain_range_ok: bool
    raw_subject: str
    raw_object: str


# ── Prompt rendering (the ontology-steering seam) ────────────────────────────


def render_system_prompt(ontology: Ontology) -> str:
    predicate_lines = "\n".join(
        f"- {p.name}: {p.description}"
        + (
            f" (subject: {'/'.join(p.domain_kinds)}; object: {'/'.join(p.range_kinds)})"
            if p.domain_kinds or p.range_kinds
            else ""
        )
        for p in ontology.predicates
    )

    entity_sections = []
    for kind, records in ontology.entities_by_kind().items():
        names = ", ".join(r.name for r in records)
        entity_sections.append(f"- {kind}: {names}")
    entity_catalogue = "\n".join(entity_sections)

    n = len(ontology.predicates)
    return f"""\
You are a structured-information extraction system specializing in \
small-molecule drug discovery and medicinal chemistry (inhibitor programs, \
SAR, ADMET/PK, biochemical & biophysical assays, and computational \
modeling). Extract ALL factual relationships from the provided text as \
structured triples.

## Predicate Vocabulary (CLOSED SET)

You MUST use ONLY the following {n} predicates. Do NOT invent new predicates:

{predicate_lines}

## Canonical Entity Catalogue

When an entity in the text refers to one of these canonical entities — \
including via a synonym, abbreviation, target/gene name, assay code, or \
chemotype label — use the canonical name EXACTLY as written below:

{entity_catalogue}

Entities NOT in this catalogue (specific compound IDs, people, cell lines, \
reagents, other targets) should be extracted with their name exactly as it \
appears in the text.

## What to Extract: THIS Document's Findings Only

Extract ONLY relationships that this document establishes as its OWN \
findings, results, or conclusions — the facts THIS work contributes. The graph \
is a record of what each paper found, not a record of everything each paper \
mentions.

INCLUDE:
- Measured results and observations reported here (e.g. a compound's assay \
readout, potency, selectivity, PK/ADMET value, SAR trend, structural finding).
- Conclusions and claims the authors draw from THIS work's data.

EXCLUDE (do NOT extract triples from these):
- Background / prior-art facts attributed to earlier or cited work \
("X has been shown to…", "it is well established that…", "[ref] reported…"). \
Those relationships belong to the cited work, not this document.
- Methodology or assay setup that states no result (protocols, reagents used, \
instrument settings) — extract the RESULT, not the procedure.
- Motivational or introductory framing about the disease/target landscape that \
this work did not itself establish.

When a sentence mixes background and a new result, extract only the new-result \
portion. If you cannot tell whether a fact is this work's finding or borrowed \
context, treat quantitative results and explicit author conclusions as findings \
and treat general statements as background (skip them).

## Output Format

Return a JSON array of objects. Each object is one triple:

```json
[
  {{
    "subject": "<canonical or as-in-text entity name>",
    "predicate": "<one of the {n} predicates above>",
    "object": "<canonical or as-in-text entity name>",
    "polarity": "<positive or negative>",
    "confidence": "<certain or implied>"
  }}
]
```

## Extraction Rules

1. ONLY extract relationships that are EXPLICITLY STATED or DIRECTLY IMPLIED \
in the text. A relationship is "directly implied" if a single logical step \
from a stated fact makes it unambiguous.

2. Do NOT infer multi-hop relationships. If the text states compound A \
inhibits target B and target B drives disease C, do NOT infer that compound A \
treats disease C.

3. NEGATION: If a relationship is explicitly negated, set polarity to \
"negative". Default polarity is "positive".

4. HEDGING: If the text uses hedging language ("reportedly", "is expected \
to", "may", "is in talks to"), still extract the relationship but set \
confidence to "implied". Use "certain" only when the text directly and \
unambiguously states the relationship as fact.

5. RECALL OVER PRECISION: Once a relationship qualifies as this work's finding \
(see "What to Extract" above), when in doubt about its certainty EXTRACT it \
with confidence "implied" — downstream validation filters false positives. This \
favors recall on FINDINGS; it does NOT override the background/prior-work \
exclusion, which still applies.

6. If the same relationship is stated multiple times, extract it only once.

7. If the text contains no extractable relationships, return an empty \
array: []
"""


def render_user_prompt(chunk: str) -> str:
    return (
        "Extract all factual relationships from the following text as "
        "structured triples. Return ONLY the JSON array, no additional "
        f"commentary.\n\n---\n{chunk}\n---\n"
    )


# ── Chunking (ported from stages.py:168-330) ─────────────────────────────────


def chunk_text(
    text: str,
    target_chars: int = CHUNK_TARGET_CHARS,
    overlap_sentences: int = CHUNK_OVERLAP_SENTENCES,
) -> list[tuple[str, int]]:
    """Split text into paragraph-aligned ~target_chars chunks with offsets."""
    if len(text) <= target_chars:
        return [(text, 0)]

    paragraphs = text.split("\n\n")

    segments: list[tuple[str, int]] = []
    pos = 0
    for i, para in enumerate(paragraphs):
        if len(para) > target_chars:
            for seg_text, seg_off in _split_sentences(para, target_chars):
                segments.append((seg_text, pos + seg_off))
        else:
            segments.append((para, pos))
        pos += len(para)
        if i < len(paragraphs) - 1:
            pos += 2

    chunks: list[tuple[str, int]] = []
    current_parts: list[str] = []
    current_offset = 0
    current_len = 0

    for seg_text, seg_off in segments:
        seg_len = len(seg_text)
        if current_parts and current_len + seg_len + 2 > target_chars:
            chunks.append(("\n\n".join(current_parts), current_offset))
            current_parts = []
            current_len = 0
            current_offset = seg_off
        if not current_parts:
            current_offset = seg_off
        current_parts.append(seg_text)
        current_len += seg_len + (2 if current_len > 0 else 0)

    if current_parts:
        chunks.append(("\n\n".join(current_parts), current_offset))

    if not chunks:
        return [(text, 0)]

    if overlap_sentences > 0 and len(chunks) > 1:
        overlapped: list[tuple[str, int]] = [chunks[0]]
        for i in range(1, len(chunks)):
            tail = _last_n_sentences(chunks[i - 1][0], overlap_sentences)
            chunk_val, chunk_off = chunks[i]
            overlapped.append(
                ((tail + " " + chunk_val) if tail else chunk_val, chunk_off)
            )
        return overlapped

    return chunks


def _split_sentences(paragraph: str, target_chars: int) -> list[tuple[str, int]]:
    boundaries = [m.end() for m in _CHUNK_SENTENCE_BOUNDARY.finditer(paragraph)]
    if not boundaries:
        return [(paragraph, 0)]

    segments: list[tuple[str, int]] = []
    accum_start = 0
    accum: list[str] = []
    accum_len = 0

    prev_end = 0
    for boundary in boundaries:
        sentence = paragraph[prev_end:boundary].rstrip()
        sent_len = len(sentence)
        if accum and accum_len + sent_len + 1 > target_chars:
            segments.append((" ".join(accum), accum_start))
            accum = []
            accum_len = 0
            accum_start = prev_end
        if not accum:
            accum_start = prev_end
        accum.append(sentence)
        accum_len += sent_len + (1 if accum_len > 0 else 0)
        prev_end = boundary

    trailing = paragraph[prev_end:].rstrip()
    if trailing:
        if accum and accum_len + len(trailing) + 1 > target_chars:
            segments.append((" ".join(accum), accum_start))
            segments.append((trailing, prev_end))
        else:
            accum.append(trailing)
            segments.append((" ".join(accum), accum_start))
    elif accum:
        segments.append((" ".join(accum), accum_start))

    return segments if segments else [(paragraph, 0)]


def _last_n_sentences(text: str, n: int) -> str:
    boundaries = [
        m.start() + 1 for m in _CHUNK_SENTENCE_BOUNDARY.finditer(text)
    ]
    if not boundaries:
        return text.strip()

    starts = [0] + boundaries[:-1]
    ends = list(boundaries)
    if boundaries[-1] < len(text.rstrip()):
        starts.append(boundaries[-1])
        ends.append(len(text.rstrip()))

    spans = list(zip(starts, ends))
    tail = spans[-n:]
    return text[tail[0][0] : tail[-1][1]].strip()


# ── Triple parsing + validation ──────────────────────────────────────────────


def _parse_llm_triples(result: dict | list) -> list[dict]:
    """Accept a bare array or {"triples": [...]}."""
    if isinstance(result, list):
        return [item for item in result if isinstance(item, dict)]
    if isinstance(result, dict):
        triples = result.get("triples", [])
        if isinstance(triples, list):
            return [item for item in triples if isinstance(item, dict)]
    return []


def _infon_id(content_hash: str, *parts: str) -> str:
    """Content-addressed id: sha256(content_hash ␟ subject ␟ pred ␟ obj ␟ pol)."""
    digest = hashlib.sha256()
    digest.update(content_hash.encode("utf-8"))
    for part in parts:
        digest.update(b"\x1f")
        digest.update(part.encode("utf-8"))
    return digest.hexdigest()


def _validate_triple(
    triple: dict, ontology: Ontology, content_hash: str
) -> ExtractedInfon | None:
    raw_subject = str(triple.get("subject") or "").strip()
    predicate = str(triple.get("predicate") or "").strip()
    raw_object = str(triple.get("object") or "").strip()
    if not (raw_subject and predicate and raw_object):
        return None

    polarity = str(triple.get("polarity") or "positive").strip().lower()
    if polarity not in ("positive", "negative"):
        polarity = "positive"

    confidence_label = str(triple.get("confidence") or "certain").strip().lower()
    confidence = 1.0 if confidence_label == "certain" else 0.8

    subj = ontology.resolve(raw_subject)
    obj = ontology.resolve(raw_object)
    subject = subj.name if subj else raw_subject
    obj_name = obj.name if obj else raw_object

    pred_record = ontology.predicate_by_name(predicate)
    in_vocab = pred_record is not None

    # Domain/range: only enforceable when the argument resolved to a curated
    # entity; unresolved sides pass open-world.
    domain_range_ok = True
    if pred_record is not None:
        if subj and pred_record.domain_kinds and subj.kind not in pred_record.domain_kinds:
            domain_range_ok = False
        if obj and pred_record.range_kinds and obj.kind not in pred_record.range_kinds:
            domain_range_ok = False

    return ExtractedInfon(
        infon_id=_infon_id(content_hash, subject, predicate, obj_name, polarity),
        subject=subject,
        predicate=predicate,
        object=obj_name,
        polarity=polarity,
        confidence=confidence,
        subject_kind=subj.kind if subj else None,
        object_kind=obj.kind if obj else None,
        subject_canonical_id=subj.canonical_id if subj else None,
        object_canonical_id=obj.canonical_id if obj else None,
        in_vocab=in_vocab,
        domain_range_ok=domain_range_ok,
        raw_subject=raw_subject,
        raw_object=raw_object,
    )


def extract_document(
    text: str, content_hash: str, ontology: Ontology
) -> tuple[list[ExtractedInfon], dict]:
    """Extract, resolve, validate, and dedup infons for one document.

    Returns (infons, stats) where stats records chunk counts and failures.
    """
    system = render_system_prompt(ontology)
    chunks = chunk_text(text)

    seen: dict[str, ExtractedInfon] = {}
    failed_chunks = 0

    for i, (chunk_val, _offset) in enumerate(chunks):
        result = invoke_model(prompt=render_user_prompt(chunk_val), system=system)
        if result is None:
            failed_chunks += 1
            log.warning("Bedrock failed for chunk %d/%d; skipping", i + 1, len(chunks))
            continue

        for triple in _parse_llm_triples(result):
            infon = _validate_triple(triple, ontology, content_hash)
            if infon is None:
                continue
            # Dedup on content-addressed id; keep the higher confidence.
            existing = seen.get(infon.infon_id)
            if existing is None or infon.confidence > existing.confidence:
                seen[infon.infon_id] = infon

    stats = {
        "chunks": len(chunks),
        "failed_chunks": failed_chunks,
        "infons": len(seen),
    }
    return list(seen.values()), stats
