from __future__ import annotations

import re

from .types import JSONScalar


def _normalize_inline(value: JSONScalar) -> str:
    return str("" if value is None else value).replace("\r\n", "\n").strip()


def _normalize_prefix(value: JSONScalar) -> str:
    return re.sub(r"[^A-Z0-9]", "", _normalize_inline(value).upper())


def _parse_positive_int(value: JSONScalar) -> int:
    text = str("" if value is None else value).strip()
    try:
        parsed = int(text)
    except ValueError:
        return 0
    return parsed if parsed > 0 else 0


def _parse_finding_id_parts(value: str) -> tuple[str, str] | None:
    compact = re.sub(r"\s+", "", value).replace("_", "-")
    match = re.match(r"^([A-Z][A-Z0-9]{0,15})-(\d+)$", compact)
    if match:
        return match.group(1), match.group(2)

    match = re.match(r"^([A-Z][A-Z0-9]{0,15}?)(\d+)$", compact)
    if match:
        return match.group(1), match.group(2)

    return None


def normalize_finding_id(value: JSONScalar) -> str:
    raw = _normalize_inline(value).upper()
    if not raw:
        return ""

    parts = _parse_finding_id_parts(raw)
    if not parts:
        return raw

    prefix = _normalize_prefix(parts[0])
    number = _parse_positive_int(parts[1])
    if not prefix or number <= 0:
        return raw

    return f"{prefix}{number:03d}"


def can_normalize_finding_id(value: JSONScalar) -> bool:
    raw = _normalize_inline(value).upper()
    return bool(raw and _parse_finding_id_parts(raw))


def format_finding_id(prefix: JSONScalar, number: JSONScalar) -> str:
    normalized_prefix = _normalize_prefix(prefix)
    numeric = _parse_positive_int(number)
    if not normalized_prefix or numeric <= 0:
        return ""
    return f"{normalized_prefix}{numeric:03d}"


def parse_finding_id_number(finding_id: JSONScalar, prefix: JSONScalar) -> int:
    normalized_id = normalize_finding_id(finding_id)
    normalized_prefix = _normalize_prefix(prefix)
    if not normalized_id or not normalized_prefix:
        return 0

    match = re.match(rf"^{re.escape(normalized_prefix)}(\d+)$", normalized_id)
    if not match:
        return 0

    return _parse_positive_int(match.group(1))
