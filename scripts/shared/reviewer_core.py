from __future__ import annotations

import json
import re

from .finding_id import can_normalize_finding_id
from .finding_id import normalize_finding_id as normalize_finding_id_canonical
from .types import Finding, JSONObject, JSONValue, ReviewerReport

REVIEWER_ID_PATTERN = re.compile(r"^[a-z0-9_]+$")
VALID_RUN_STATES = {"completed", "skipped", "error"}
FINDING_TITLE_KEYS = ("title", "message", "issue")
FINDING_RECOMMENDATION_KEYS = ("recommendation", "remediation", "description", "message")


def normalize_reviewer(value: str | None, fallback: str = "") -> str:
    if value is None:
        return fallback

    trimmed = value.strip()
    if not trimmed:
        return fallback

    if REVIEWER_ID_PATTERN.fullmatch(trimmed):
        return trimmed

    canonical = trimmed.replace("-", "_")
    if REVIEWER_ID_PATTERN.fullmatch(canonical):
        return canonical

    return fallback


def is_valid_reviewer_id(value: str | None) -> bool:
    return bool(REVIEWER_ID_PATTERN.fullmatch((value or "").strip()))


def is_non_empty_string(value: str | None) -> bool:
    return bool(value and value.strip())


def as_bool(value: str | None) -> bool:
    return (value or "").lower() == "true"


def normalize_finding_id(value: str | None) -> str:
    if not is_non_empty_string(value):
        return ""
    return normalize_finding_id_canonical(value)


def _normalize_finding_id_strict(value: str | None, field_label: str) -> str:
    if not is_non_empty_string(value):
        raise ValueError(f"{field_label} must be a non-empty string")
    assert value is not None
    if not can_normalize_finding_id(value):
        raise ValueError(f"{field_label} must be a valid finding id (for example SEC001)")
    return normalize_finding_id_canonical(value)


def make_base_payload(
    *,
    reviewer: str,
    run_state: str,
    summary: str,
    resolved_finding_ids: list[str] | None = None,
    new_findings: list[Finding] | None = None,
    errors: list[str] | None = None,
) -> ReviewerReport:
    return ReviewerReport(
        reviewer=reviewer,
        run_state=run_state,
        summary=summary,
        resolved_finding_ids=resolved_finding_ids or [],
        new_findings=new_findings or [],
        errors=errors or [],
    )


def make_error_payload(reviewer: str, reasons: list[str] | None) -> ReviewerReport:
    return make_base_payload(
        reviewer=reviewer,
        run_state="error",
        summary="Reviewer output unavailable or invalid",
        resolved_finding_ids=[],
        new_findings=[],
        errors=reasons or [],
    )


def _first_non_empty_string_by_keys(value: JSONObject, keys: tuple[str, ...]) -> str:
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return ""


def _normalize_line(value: JSONValue) -> int | None:
    if isinstance(value, int) and value > 0:
        return value

    if isinstance(value, str):
        trimmed = value.strip()
        if re.fullmatch(r"^[1-9]\d*$", trimmed):
            return int(trimmed)

    return None


def _normalize_reopen_finding_id(value: JSONValue) -> str | None:
    if value is None:
        return None
    if isinstance(value, str) and value == "":
        return None

    text = value if isinstance(value, str) else str(value)
    return _normalize_finding_id_strict(text, "reopen_finding_id")


def normalize_new_findings_strict(raw_findings: list[JSONValue]) -> list[Finding]:
    normalized: list[Finding] = []
    for index, finding in enumerate(raw_findings):
        if not isinstance(finding, dict):
            raise ValueError(f"new finding at index {index} is not an object")

        title = _first_non_empty_string_by_keys(finding, FINDING_TITLE_KEYS)
        recommendation = _first_non_empty_string_by_keys(finding, FINDING_RECOMMENDATION_KEYS)

        if not title:
            raise ValueError(f"new finding {index} missing title")
        if not recommendation:
            raise ValueError(f"new finding {index} missing recommendation")

        file_value = finding.get("file")
        file_path = file_value.strip() if isinstance(file_value, str) and file_value.strip() else None

        normalized.append(
            Finding(
                title=title,
                file=file_path,
                line=_normalize_line(finding.get("line")),
                recommendation=recommendation,
                reopen_finding_id=_normalize_reopen_finding_id(finding.get("reopen_finding_id")),
            )
        )

    return normalized


def normalize_finding_lenient(finding: JSONObject | None) -> Finding:
    if finding is None:
        return Finding(
            title="Unparseable finding payload",
            file=None,
            line=None,
            recommendation="Review this finding manually.",
            reopen_finding_id=None,
        )

    file_value = finding.get("file")
    file_path = file_value.strip() if isinstance(file_value, str) and file_value.strip() else None

    reopen_value = finding.get("reopen_finding_id")
    reopen_text = reopen_value if isinstance(reopen_value, str) else None

    return Finding(
        title=_first_non_empty_string_by_keys(finding, FINDING_TITLE_KEYS) or "Untitled finding",
        file=file_path,
        line=_normalize_line(finding.get("line")),
        recommendation=_first_non_empty_string_by_keys(finding, FINDING_RECOMMENDATION_KEYS)
        or "No recommendation provided.",
        reopen_finding_id=normalize_finding_id(reopen_text) or None,
    )


def _normalize_errors(raw_errors: JSONValue) -> list[str]:
    if not isinstance(raw_errors, list):
        return []
    return [item for item in raw_errors if isinstance(item, str)]


def normalize_resolved_finding_ids_strict(raw_ids: list[JSONValue]) -> list[str]:
    ids: list[str] = []
    for index, raw in enumerate(raw_ids):
        text = raw if isinstance(raw, str) else str(raw)
        ids.append(_normalize_finding_id_strict(text, f"resolved_finding_ids[{index}]"))

    return list(dict.fromkeys(ids))


def normalize_structured_reviewer_payload(raw_payload: JSONObject, expected_reviewer: str) -> ReviewerReport:
    reviewer_value = raw_payload.get("reviewer")
    reviewer = normalize_reviewer(reviewer_value if isinstance(reviewer_value, str) else None, expected_reviewer)
    if not is_valid_reviewer_id(reviewer):
        raise ValueError("reviewer is required and must be a valid reviewer id")

    summary_value = raw_payload.get("summary")
    if not isinstance(summary_value, str) or not summary_value.strip():
        raise ValueError("summary is required")

    raw_resolved = raw_payload.get("resolved_finding_ids")
    if not isinstance(raw_resolved, list):
        raise ValueError("resolved_finding_ids must be an array")

    raw_new_findings = raw_payload.get("new_findings")
    if not isinstance(raw_new_findings, list):
        raise ValueError("new_findings must be an array")

    return ReviewerReport(
        reviewer=reviewer,
        run_state="completed",
        summary=summary_value.strip(),
        resolved_finding_ids=normalize_resolved_finding_ids_strict(raw_resolved),
        new_findings=normalize_new_findings_strict(raw_new_findings),
        errors=_normalize_errors(raw_payload.get("errors")),
    )


def _make_missing_report_payload(reviewer: str) -> ReviewerReport:
    return ReviewerReport(
        reviewer=reviewer,
        run_state="error",
        summary="Reviewer output unavailable or invalid",
        resolved_finding_ids=[],
        new_findings=[],
        errors=["missing reviewer report input"],
    )


def _make_parse_failure_payload(reviewer: str, reason: str) -> ReviewerReport:
    return ReviewerReport(
        reviewer=reviewer,
        run_state="error",
        summary="Reviewer output unavailable or invalid",
        resolved_finding_ids=[],
        new_findings=[],
        errors=[reason],
    )


def normalize_persisted_reviewer_report(reviewer: str, raw: str) -> ReviewerReport:
    expected_reviewer = normalize_reviewer(reviewer, "") or reviewer.strip()

    if not raw.strip():
        return _make_missing_report_payload(expected_reviewer)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        return _make_parse_failure_payload(
            expected_reviewer,
            f"reviewer report parse failure: {error}",
        )

    if not isinstance(parsed, dict):
        return _make_parse_failure_payload(
            expected_reviewer,
            "reviewer report parse failure: payload is not a JSON object",
        )

    try:
        normalized = normalize_structured_reviewer_payload(parsed, expected_reviewer)
    except ValueError as error:
        return _make_parse_failure_payload(
            expected_reviewer,
            f"reviewer report parse failure: {error}",
        )

    run_state_value = parsed.get("run_state")
    if isinstance(run_state_value, str):
        run_state = run_state_value.strip().lower()
        if run_state in VALID_RUN_STATES:
            normalized["run_state"] = run_state

    return normalized
