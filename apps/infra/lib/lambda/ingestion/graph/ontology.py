"""Ontology loader + resolver for the graph-ontology experiment.

Adapted from infon_core.ontology (loader.py / resolver.py) on the
feat/extraction-quality-tiers branch, extended with the `predicates` section:
each predicate carries a description and domain/range entity-kind hints so the
ontology can steer extraction (prompt rendering) and validate its output
(vocabulary + domain/range checks).
"""

from __future__ import annotations

import json
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

ONTOLOGY_PATH = Path(__file__).with_name("ontology.json")


def normalize_surface(text: str) -> str:
    """Case-fold + NFKC-normalize + collapse whitespace for alias lookup.

    Korean has no case so this is a no-op there beyond NFKC (which makes
    full/half-width and composed/decomposed jamo compare equal).
    """
    folded = unicodedata.normalize("NFKC", text).casefold().strip()
    return " ".join(folded.split())


@dataclass(frozen=True)
class EntityRecord:
    canonical_id: str
    name: str
    kind: str
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class PredicateRecord:
    name: str
    description: str
    domain_kinds: tuple[str, ...] = ()
    range_kinds: tuple[str, ...] = ()


@dataclass(frozen=True)
class ResolvedEntity:
    canonical_id: str
    name: str
    kind: str


@dataclass(frozen=True)
class DocumentClassification:
    macros: list[str]
    micros: list[str]
    tags: list[str]


@dataclass(frozen=True)
class Ontology:
    """In-memory view of ontology.json.

    macros: macro -> micro -> [tags] taxonomy.
    entity_records: curated canonical entities with KO/EN aliases.
    alias_index: normalized surface form -> canonical_id (O(1) resolution).
    predicates: closed relation vocabulary with domain/range kind hints.
    """

    macros: dict[str, dict[str, list[str]]] = field(default_factory=dict)
    synonyms: dict[str, list[str]] = field(default_factory=dict)
    entity_records: tuple[EntityRecord, ...] = ()
    alias_index: dict[str, str] = field(default_factory=dict)
    predicates: tuple[PredicateRecord, ...] = ()

    def entity_by_id(self, canonical_id: str) -> EntityRecord | None:
        for record in self.entity_records:
            if record.canonical_id == canonical_id:
                return record
        return None

    def predicate_names(self) -> set[str]:
        return {p.name for p in self.predicates}

    def predicate_by_name(self, name: str) -> PredicateRecord | None:
        for p in self.predicates:
            if p.name == name:
                return p
        return None

    def entities_by_kind(self) -> dict[str, list[EntityRecord]]:
        grouped: dict[str, list[EntityRecord]] = {}
        for record in self.entity_records:
            grouped.setdefault(record.kind, []).append(record)
        return grouped

    # ── Resolution ────────────────────────────────────────────────────────

    def resolve(self, span: str) -> ResolvedEntity | None:
        """Resolve a surface span (EN or KO) to its canonical entity, or None."""
        if not span:
            return None
        canonical_id = self.alias_index.get(normalize_surface(span))
        if canonical_id is None:
            return None
        record = self.entity_by_id(canonical_id)
        if record is None:
            return None
        return ResolvedEntity(
            canonical_id=record.canonical_id, name=record.name, kind=record.kind
        )

    def classify(self, text: str) -> DocumentClassification:
        """Classify document text into Macro/Micro/Tag buckets.

        A tag matches when its normalized surface form occurs as a substring
        of the normalized text; micro/macro roll up from tag hits.
        """
        haystack = normalize_surface(text)
        macros: list[str] = []
        micros: list[str] = []
        tags: list[str] = []

        for macro, micro_map in self.macros.items():
            macro_hit = False
            for micro, micro_tags in micro_map.items():
                micro_hit = False
                for tag in micro_tags:
                    needle = normalize_surface(tag)
                    if needle and needle in haystack:
                        if tag not in tags:
                            tags.append(tag)
                        micro_hit = True
                if micro_hit:
                    if micro not in micros:
                        micros.append(micro)
                    macro_hit = True
            if macro_hit and macro not in macros:
                macros.append(macro)

        return DocumentClassification(macros=macros, micros=micros, tags=tags)


def load_ontology(path: Path | None = None) -> Ontology:
    with (path or ONTOLOGY_PATH).open(encoding="utf-8") as f:
        data = json.load(f)

    records: list[EntityRecord] = []
    alias_index: dict[str, str] = {}
    for item in data.get("entities") or []:
        name = str(item.get("name") or item["canonical_id"])
        aliases = tuple(str(a) for a in (item.get("aliases") or []))
        if name not in aliases:
            aliases = (name, *aliases)
        record = EntityRecord(
            canonical_id=str(item["canonical_id"]),
            name=name,
            kind=str(item.get("kind") or "Entity"),
            aliases=aliases,
        )
        records.append(record)
        for alias in record.aliases:
            key = normalize_surface(alias)
            if key:
                # First writer wins: earlier records keep a shared alias.
                alias_index.setdefault(key, record.canonical_id)

    predicates = tuple(
        PredicateRecord(
            name=str(p["name"]),
            description=str(p.get("description") or ""),
            domain_kinds=tuple(p.get("domain_kinds") or ()),
            range_kinds=tuple(p.get("range_kinds") or ()),
        )
        for p in data.get("predicates") or []
    )

    return Ontology(
        macros=dict(data.get("ontology") or {}),
        synonyms=dict(data.get("synonyms") or {}),
        entity_records=tuple(records),
        alias_index=alias_index,
        predicates=predicates,
    )
