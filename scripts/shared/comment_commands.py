from __future__ import annotations

import re

AUTHORIZED_COMMAND_AUTHOR_ASSOCIATIONS = {"OWNER", "MEMBER", "COLLABORATOR"}
RERUN_COMMAND_PATTERN = re.compile(r"^\s*/lgtm\s+rerun(?:\s+([a-z0-9_]+))?\s*$", re.IGNORECASE)


def normalize_text(value: str | int | float | bool | None) -> str:
    return str("" if value is None else value).replace("\r\n", "\n").strip()


def parse_lgtm_rerun_command(body: str | None) -> str | None:
    normalized_body = normalize_text(body)
    if not normalized_body:
        return None

    for line in normalized_body.splitlines():
        match = RERUN_COMMAND_PATTERN.match(line)
        if not match:
            continue

        reviewer_filter = normalize_text(match.group(1))
        return reviewer_filter.lower() if reviewer_filter else ""

    return None


def is_authorized_comment_author_association(value: str | None) -> bool:
    normalized = normalize_text(value).upper()
    return normalized in AUTHORIZED_COMMAND_AUTHOR_ASSOCIATIONS
