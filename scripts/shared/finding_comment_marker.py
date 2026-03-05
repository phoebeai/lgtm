from __future__ import annotations

import hmac
import re
from hashlib import sha256

from .types import JSONScalar

INLINE_FINDING_MARKER_REGEX = re.compile(r"<!--\s*codex-inline-finding\s+sig=([a-f0-9]{64})\s*-->", re.IGNORECASE)
INLINE_FINDING_MARKER_LINE_REGEX = re.compile(
    r"^<!--\s*codex-inline-finding\s+sig=[a-f0-9]{64}\s*-->$", re.IGNORECASE | re.MULTILINE
)


def _normalize_text(value: JSONScalar) -> str:
    return str("" if value is None else value).replace("\r\n", "\n")


def _normalize_hex(value: JSONScalar) -> str:
    return str("" if value is None else value).strip().lower()


def strip_inline_finding_markers(value: JSONScalar) -> str:
    return INLINE_FINDING_MARKER_LINE_REGEX.sub("", _normalize_text(value))


def normalize_inline_finding_comment_body(value: JSONScalar) -> str:
    stripped = strip_inline_finding_markers(value)
    normalized_lines = "\n".join(line.rstrip() for line in stripped.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", normalized_lines).strip()


def extract_inline_finding_signature(value: JSONScalar) -> str:
    match = INLINE_FINDING_MARKER_REGEX.search(_normalize_text(value))
    return _normalize_hex(match.group(1)) if match else ""


def has_inline_finding_marker(value: JSONScalar) -> bool:
    return bool(extract_inline_finding_signature(value))


def sign_inline_finding_body(*, body: JSONScalar, secret: JSONScalar) -> str:
    normalized_secret = str("" if secret is None else secret)
    if not normalized_secret:
        return ""

    normalized_body = normalize_inline_finding_comment_body(body)
    return hmac.new(normalized_secret.encode("utf-8"), normalized_body.encode("utf-8"), sha256).hexdigest()


def build_inline_finding_marker(*, body: JSONScalar, secret: JSONScalar) -> str:
    signature = sign_inline_finding_body(body=body, secret=secret)
    if not signature:
        return ""
    return f"<!-- codex-inline-finding sig={signature} -->"


def _safe_equal_hex(left: JSONScalar, right: JSONScalar) -> bool:
    left_bytes = _normalize_hex(left).encode("utf-8")
    right_bytes = _normalize_hex(right).encode("utf-8")
    if not left_bytes or not right_bytes or len(left_bytes) != len(right_bytes):
        return False
    return hmac.compare_digest(left_bytes, right_bytes)


def verify_inline_finding_comment_signature(*, body: JSONScalar, secret: JSONScalar) -> bool:
    signature = extract_inline_finding_signature(body)
    if not signature:
        return False

    expected = sign_inline_finding_body(body=body, secret=secret)
    if not expected:
        return False

    return _safe_equal_hex(signature, expected)
