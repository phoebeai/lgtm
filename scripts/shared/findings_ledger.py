from __future__ import annotations

import re
from datetime import UTC, datetime

from .finding_id import (
    can_normalize_finding_id,
    format_finding_id,
    normalize_finding_id,
    parse_finding_id_number,
)
from .types import (
    ConsensusReviewer,
    FindingsLedger,
    JSONValue,
    LedgerFinding,
    PresentationEntry,
    PresentationFinding,
    ReviewerReport,
)

KNOWN_PREFIXES = {
    "security": "SEC",
    "test_quality": "TQ",
    "code_quality": "CQ",
    "infrastructure": "INF",
}


def _as_str(value: JSONValue) -> str | None:
    return value if isinstance(value, str) else None


def _as_int(value: JSONValue) -> int | None:
    return value if isinstance(value, int) else None


def _normalize_text(value: str | int | float | bool | None) -> str:
    return str("" if value is None else value).replace("\r\n", "\n").strip()


def _normalize_line(value: JSONValue) -> int | None:
    line = _as_int(value)
    return line if line is not None and line > 0 else None


def _to_iso_string(value: str | None) -> str:
    if value:
        normalized = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=UTC)
            return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")
        except ValueError:
            pass

    return datetime.now(tz=UTC).isoformat().replace("+00:00", "Z")


def _normalize_status(value: str | None) -> str:
    return "resolved" if (value or "").strip().lower() == "resolved" else "open"


def _default_recommendation(value: str | None) -> str:
    normalized = _normalize_text(value)
    return normalized or "No recommendation provided."


def _create_empty_ledger() -> FindingsLedger:
    return FindingsLedger(version=1, findings=[])


def _normalize_ledger_finding(entry: dict[str, JSONValue], index: int) -> LedgerFinding:
    finding_id = normalize_finding_id(_as_str(entry.get("id")))
    reviewer = _normalize_text(_as_str(entry.get("reviewer")))
    title = _normalize_text(_as_str(entry.get("title")))

    if not finding_id or not reviewer or not title:
        raise ValueError(f"findings[{index}] must include non-empty id, reviewer, and title")

    status = _normalize_status(_as_str(entry.get("status")))
    created_at = _to_iso_string(_as_str(entry.get("created_at")))
    updated_at = _to_iso_string(_as_str(entry.get("updated_at")) or created_at)

    recommendation = _default_recommendation(_as_str(entry.get("recommendation")))
    file_path = _normalize_text(_as_str(entry.get("file"))) or None

    created_run_id = _normalize_text(_as_str(entry.get("created_run_id")))
    updated_run_id = _normalize_text(_as_str(entry.get("updated_run_id")))

    resolved_at_raw = _as_str(entry.get("resolved_at"))
    resolved_at = (
        _to_iso_string(resolved_at_raw)
        if status == "resolved" and resolved_at_raw
        else _to_iso_string(updated_at)
        if status == "resolved"
        else None
    )

    inline_comment_id_value = _as_int(entry.get("inline_comment_id"))
    inline_comment_id = inline_comment_id_value if inline_comment_id_value is not None and inline_comment_id_value > 0 else None

    inline_comment_url = _normalize_text(_as_str(entry.get("inline_comment_url")))
    inline_thread_id = _normalize_text(_as_str(entry.get("inline_thread_id")))

    return LedgerFinding(
        id=finding_id,
        reviewer=reviewer,
        status=status,
        title=title,
        recommendation=recommendation,
        file=file_path,
        line=_normalize_line(entry.get("line")),
        created_run_id=created_run_id,
        created_at=created_at,
        updated_run_id=updated_run_id,
        updated_at=updated_at,
        resolved_at=resolved_at,
        inline_comment_id=inline_comment_id,
        inline_comment_url=inline_comment_url,
        inline_thread_id=inline_thread_id,
    )


def normalize_ledger(raw_ledger: FindingsLedger | JSONValue | None) -> FindingsLedger:
    if raw_ledger in (None, ""):
        return _create_empty_ledger()

    if not isinstance(raw_ledger, dict):
        raise ValueError("ledger root must be an object")

    findings_value = raw_ledger.get("findings")
    if not isinstance(findings_value, list):
        raise ValueError("ledger must include findings array")

    seen_ids: set[str] = set()
    normalized_findings: list[LedgerFinding] = []

    for index, entry in enumerate(findings_value):
        if not isinstance(entry, dict):
            raise ValueError(f"findings[{index}] must be an object")
        normalized = _normalize_ledger_finding(entry, index)
        if normalized["id"] in seen_ids:
            raise ValueError(f"duplicate finding id in ledger: {normalized['id']}")
        seen_ids.add(normalized["id"])
        normalized_findings.append(normalized)

    return FindingsLedger(version=1, findings=normalized_findings)


def build_finding_id_prefix(reviewer_id: str) -> str:
    normalized = _normalize_text(reviewer_id).lower()
    if normalized in KNOWN_PREFIXES:
        return KNOWN_PREFIXES[normalized]

    tokens = [token for token in re.split(r"[^a-z0-9]+", normalized) if token]
    if not tokens:
        return "F"

    if len(tokens) == 1:
        return tokens[0][:3].upper()

    return "".join(token[0].upper() for token in tokens)[:4]


def _find_next_number(findings: list[LedgerFinding], reviewer: str) -> int:
    prefix = build_finding_id_prefix(reviewer)
    max_value = 0
    for finding in findings:
        if finding["reviewer"] != reviewer:
            continue
        parsed = parse_finding_id_number(finding["id"], prefix)
        if parsed > max_value:
            max_value = parsed
    return max_value + 1


def _to_presentation_entry(entry: LedgerFinding) -> PresentationEntry:
    finding = PresentationFinding(
        id=entry["id"],
        title=entry["title"],
        recommendation=entry["recommendation"],
        file=entry["file"],
        line=entry["line"],
    )
    return PresentationEntry(reviewer=entry["reviewer"], status=entry["status"], finding=finding)


def _sort_findings(findings: list[LedgerFinding]) -> list[LedgerFinding]:
    return sorted(findings, key=lambda item: (item["reviewer"], item["id"]))


def merge_ledger_with_reports(
    *,
    prior_ledger: FindingsLedger | JSONValue | None,
    reports: dict[str, ReviewerReport],
    reviewers: list[ConsensusReviewer],
    run_id: str,
    timestamp: str,
) -> dict[str, FindingsLedger | list[PresentationEntry]]:
    normalized_ledger = normalize_ledger(prior_ledger)
    normalized_run_id = _normalize_text(run_id)
    normalized_timestamp = _to_iso_string(timestamp)

    findings_by_id: dict[str, LedgerFinding] = {
        entry["id"]: entry.copy() for entry in normalized_ledger["findings"]
    }

    newly_opened_entries: list[PresentationEntry] = []
    reopened_entries: list[PresentationEntry] = []
    newly_resolved_entries: list[PresentationEntry] = []

    for reviewer in reviewers:
        reviewer_id = _normalize_text(reviewer.get("id"))
        if not reviewer_id:
            continue

        report = reports.get(reviewer_id)
        if report is None or report["run_state"] != "completed":
            continue

        resolved_ids: set[str] = set()
        for raw_resolved_id in report.get("resolved_finding_ids", []):
            if not can_normalize_finding_id(raw_resolved_id):
                raise ValueError(
                    f"{reviewer_id}: resolved_finding_ids includes invalid finding id {raw_resolved_id!r}"
                )
            resolved_ids.add(normalize_finding_id(raw_resolved_id))

        for resolved_id in resolved_ids:
            existing = findings_by_id.get(resolved_id)
            if existing is None or existing["reviewer"] != reviewer_id or existing["status"] != "open":
                continue

            existing["status"] = "resolved"
            existing["updated_run_id"] = normalized_run_id
            existing["updated_at"] = normalized_timestamp
            existing["resolved_at"] = normalized_timestamp
            newly_resolved_entries.append(_to_presentation_entry(existing))

        next_number = _find_next_number(list(findings_by_id.values()), reviewer_id)
        prefix = build_finding_id_prefix(reviewer_id)

        for raw_finding in report.get("new_findings", []):
            title = _normalize_text(raw_finding.get("title")) or "Untitled finding"
            recommendation = _default_recommendation(raw_finding.get("recommendation"))
            file_path = _normalize_text(raw_finding.get("file")) or None

            line_value = raw_finding.get("line")
            line = line_value if isinstance(line_value, int) and line_value > 0 else None

            raw_reopen_finding_id = raw_finding.get("reopen_finding_id")
            if raw_reopen_finding_id not in (None, "") and not can_normalize_finding_id(raw_reopen_finding_id):
                raise ValueError(
                    f"{reviewer_id}: reopen_finding_id must be a valid finding id (received {raw_reopen_finding_id!r})"
                )

            reopen_finding_id = normalize_finding_id(raw_reopen_finding_id)
            if reopen_finding_id:
                existing = findings_by_id.get(reopen_finding_id)
                if existing is None:
                    raise ValueError(
                        f"{reviewer_id}: reopen_finding_id {reopen_finding_id} does not exist in prior ledger"
                    )

                if existing["reviewer"] != reviewer_id:
                    raise ValueError(
                        f"{reviewer_id}: reopen_finding_id {reopen_finding_id} belongs to reviewer {existing['reviewer']}"
                    )

                if existing["status"] != "resolved":
                    raise ValueError(
                        f"{reviewer_id}: reopen_finding_id {reopen_finding_id} must reference a resolved finding"
                    )

                was_resolved = existing["status"] == "resolved"
                existing["status"] = "open"
                existing["title"] = title
                existing["recommendation"] = recommendation
                existing["file"] = file_path
                existing["line"] = line
                existing["updated_run_id"] = normalized_run_id
                existing["updated_at"] = normalized_timestamp
                existing["resolved_at"] = None

                if was_resolved:
                    presentation = _to_presentation_entry(existing)
                    reopened_entries.append(presentation)
                    newly_opened_entries.append(presentation)
                continue

            new_id = format_finding_id(prefix, next_number)
            while new_id in findings_by_id:
                next_number += 1
                new_id = format_finding_id(prefix, next_number)

            created = LedgerFinding(
                id=new_id,
                reviewer=reviewer_id,
                status="open",
                title=title,
                recommendation=recommendation,
                file=file_path,
                line=line,
                created_run_id=normalized_run_id,
                created_at=normalized_timestamp,
                updated_run_id=normalized_run_id,
                updated_at=normalized_timestamp,
                resolved_at=None,
                inline_comment_id=None,
                inline_comment_url="",
                inline_thread_id="",
            )
            findings_by_id[new_id] = created
            newly_opened_entries.append(_to_presentation_entry(created))
            next_number += 1

    findings = _sort_findings(list(findings_by_id.values()))
    open_entries = [_to_presentation_entry(entry) for entry in findings if entry["status"] == "open"]
    resolved_entries = [_to_presentation_entry(entry) for entry in findings if entry["status"] == "resolved"]

    return {
        "ledger": FindingsLedger(version=1, findings=findings),
        "openEntries": open_entries,
        "resolvedEntries": resolved_entries,
        "newlyOpenedEntries": newly_opened_entries,
        "reopenedEntries": reopened_entries,
        "newlyResolvedEntries": newly_resolved_entries,
    }


def apply_inline_comment_metadata(
    *,
    ledger: FindingsLedger | JSONValue | None,
    entries: list[dict[str, JSONValue]],
) -> FindingsLedger:
    normalized_ledger = normalize_ledger(ledger)
    finding_map: dict[str, LedgerFinding] = {
        finding["id"]: finding.copy() for finding in normalized_ledger["findings"]
    }

    for entry in entries:
        finding_value = entry.get("finding")
        if not isinstance(finding_value, dict):
            continue

        finding_id = normalize_finding_id(_as_str(finding_value.get("id")))
        if not finding_id or finding_id not in finding_map:
            continue

        finding = finding_map[finding_id]

        comment_id_value = _as_int(entry.get("comment_id"))
        if comment_id_value is not None and comment_id_value > 0:
            finding["inline_comment_id"] = comment_id_value

        comment_url = _normalize_text(_as_str(entry.get("comment_url")))
        if comment_url:
            finding["inline_comment_url"] = comment_url

        inline_thread_id = _normalize_text(_as_str(entry.get("inline_thread_id")))
        if inline_thread_id:
            finding["inline_thread_id"] = inline_thread_id

    return FindingsLedger(version=1, findings=_sort_findings(list(finding_map.values())))
