from __future__ import annotations

from .finding_format import format_finding_headline, format_finding_recommendation
from .reviewers_json import parse_reviewers_for_consensus
from .types import ConsensusReviewer, PresentationEntry, PresentationFinding


def _sanitize_inline(value: str | int | float | bool | None) -> str:
    return " ".join(str("" if value is None else value).replace("\n", " ").split())


def _finding_location(finding: PresentationFinding) -> str:
    file_value = finding.get("file")
    file_path = _sanitize_inline(file_value) if isinstance(file_value, str) else ""
    if not file_path:
        return ""

    line_value = finding.get("line")
    if isinstance(line_value, int) and line_value > 0:
        return f"{file_path}:{line_value}"
    return file_path


def _format_finding(entry: PresentationEntry, labels_by_reviewer_id: dict[str, str]) -> str:
    finding = entry["finding"]
    reviewer = _sanitize_inline(entry.get("reviewer", "unknown"))
    reviewer_label = _sanitize_inline(labels_by_reviewer_id.get(reviewer, reviewer) or "Unknown Reviewer")
    headline = format_finding_headline(reviewer_label=reviewer_label, finding=finding)
    recommendation = format_finding_recommendation(finding)
    location = _finding_location(finding)
    location_text = f"`{location}`" if location else "`global / unknown location`"

    return "\n".join([f"- {headline}", f"  Location: {location_text}", f"  {recommendation}"])


def _push_findings_section(
    lines: list[str],
    title: str,
    entries: list[PresentationEntry],
    labels: dict[str, str],
) -> None:
    if not entries:
        return

    lines.append(f"### {title}")

    for entry in entries:
        lines.append(_format_finding(entry, labels))
    lines.append("")


def _push_reviewer_errors_section(lines: list[str], reviewer_errors: list[str]) -> None:
    if not reviewer_errors:
        return

    lines.append("### Reviewer Errors")
    for reason in reviewer_errors:
        lines.append(f"- {_sanitize_inline(reason)}")
    lines.append("")


def _normalize_outcome_reason(value: str | None) -> str:
    normalized = (value or "").strip().upper()
    if normalized in {"PASS_NO_FINDINGS", "FAIL_OPEN_FINDINGS", "FAIL_REVIEWER_ERRORS"}:
        return normalized
    return "FAIL_OPEN_FINDINGS"


def _render_outcome_summary(
    *,
    outcome_reason: str | None,
    open_findings_count: int,
    reviewer_errors_count: int,
) -> str:
    normalized = _normalize_outcome_reason(outcome_reason)
    if normalized == "PASS_NO_FINDINGS":
        return "No open findings."
    if normalized == "FAIL_REVIEWER_ERRORS":
        suffix = "" if reviewer_errors_count == 1 else "s"
        return f"{reviewer_errors_count} reviewer error{suffix} detected."

    suffix = "" if open_findings_count == 1 else "s"
    return f"{open_findings_count} open finding{suffix} detected."


def normalize_reviewers(reviewers_json: str | None) -> list[ConsensusReviewer]:
    return parse_reviewers_for_consensus(reviewers_json)


def render_consensus_comment(
    *,
    marker: str,
    outcome: str,
    outcome_reason: str,
    open_entries: list[PresentationEntry],
    resolved_entries: list[PresentationEntry],
    reviewer_errors: list[str],
    labels_by_reviewer_id: dict[str, str],
) -> str:
    lines: list[str] = [marker]

    lines.append("## ✅ LGTM" if outcome.upper() == "PASS" else "## ❌ LGTM")
    lines.append(
        _render_outcome_summary(
            outcome_reason=outcome_reason,
            open_findings_count=len(open_entries),
            reviewer_errors_count=len(reviewer_errors),
        )
    )

    has_details_sections = bool(reviewer_errors or open_entries or resolved_entries)
    if has_details_sections:
        lines.append("")
        _push_reviewer_errors_section(lines, reviewer_errors)
        _push_findings_section(lines, "Open Findings", open_entries, labels_by_reviewer_id)
        _push_findings_section(lines, "Resolved Findings", resolved_entries, labels_by_reviewer_id)

    while lines and lines[-1] == "":
        lines.pop()

    return "\n".join(lines)
