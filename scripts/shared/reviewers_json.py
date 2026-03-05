from __future__ import annotations

import json
from dataclasses import dataclass

from .reviewer_core import is_valid_reviewer_id
from .types import ConsensusReviewer, ReviewerConfig


@dataclass(frozen=True)
class _ReviewerRow:
    entry: dict[str, str | list[str]]
    reviewer_id: str
    index: int


def _parse_reviewer_entries(reviewers_json: str | None, require_non_empty: bool = True) -> list[_ReviewerRow]:
    try:
        parsed = json.loads(reviewers_json or "[]")
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid REVIEWERS_JSON: {error}") from error

    if not isinstance(parsed, list):
        raise ValueError("REVIEWERS_JSON must be a JSON array")

    if require_non_empty and not parsed:
        raise ValueError("REVIEWERS_JSON must contain at least one reviewer")

    ids: set[str] = set()
    rows: list[_ReviewerRow] = []

    for index, entry in enumerate(parsed):
        if not isinstance(entry, dict):
            raise ValueError(f"REVIEWERS_JSON[{index}] must be an object")

        typed_entry: dict[str, str | list[str]] = {}
        for key, value in entry.items():
            if isinstance(value, str) or (isinstance(value, list) and all(isinstance(item, str) for item in value)):
                typed_entry[key] = value

        reviewer_id = str(typed_entry.get("id", "")).strip()
        if not is_valid_reviewer_id(reviewer_id):
            raise ValueError(f"REVIEWERS_JSON[{index}].id must match ^[a-z0-9_]+$")
        if reviewer_id in ids:
            raise ValueError(f"Duplicate reviewer id in REVIEWERS_JSON: {reviewer_id}")

        ids.add(reviewer_id)
        rows.append(_ReviewerRow(entry=typed_entry, reviewer_id=reviewer_id, index=index))

    return rows


def parse_reviewers_for_runner(reviewers_json: str | None) -> list[ReviewerConfig]:
    rows = _parse_reviewer_entries(reviewers_json, require_non_empty=True)
    reviewers: list[ReviewerConfig] = []

    for row in rows:
        label = f"REVIEWERS_JSON[{row.index}]"
        prompt_file = str(row.entry.get("prompt_file", "")).strip()
        if not prompt_file:
            raise ValueError(f"{label}.prompt_file must be a non-empty string")

        scope = str(row.entry.get("scope", "")).strip()
        if not scope:
            raise ValueError(f"{label}.scope must be a non-empty string")

        display_name = str(row.entry.get("display_name", row.reviewer_id)).strip() or row.reviewer_id

        paths_json_value = row.entry.get("paths_json")
        if isinstance(paths_json_value, str):
            paths_json = paths_json_value
        else:
            paths = row.entry.get("paths")
            paths_json = json.dumps(paths) if isinstance(paths, list) else "[]"

        reviewers.append(
            ReviewerConfig(
                id=row.reviewer_id,
                display_name=display_name,
                prompt_file=prompt_file,
                scope=scope,
                paths_json=paths_json,
            )
        )

    return reviewers


def parse_reviewers_for_consensus(reviewers_json: str | None) -> list[ConsensusReviewer]:
    rows = _parse_reviewer_entries(reviewers_json, require_non_empty=True)
    reviewers: list[ConsensusReviewer] = []

    for row in rows:
        display_name = str(row.entry.get("display_name", row.reviewer_id)).strip() or row.reviewer_id
        reviewers.append(ConsensusReviewer(id=row.reviewer_id, display_name=display_name))

    return reviewers


def parse_reviewer_ids(reviewers_json: str | None) -> list[str]:
    return [row.reviewer_id for row in _parse_reviewer_entries(reviewers_json, require_non_empty=False)]
