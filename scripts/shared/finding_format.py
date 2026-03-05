from __future__ import annotations

from .finding_id import normalize_finding_id
from .types import PresentationFinding


def _normalize_inline(value: str | int | float | bool | None) -> str:
    return " ".join(str("" if value is None else value).replace("\n", " ").split())


def format_finding_headline(*, reviewer_label: str, finding: PresentationFinding) -> str:
    finding_id = _normalize_inline(normalize_finding_id(finding.get("id")))
    title = _normalize_inline(finding.get("title", "Untitled finding"))
    if finding_id:
        return f"**[{finding_id}]** {title}"

    normalized_reviewer = _normalize_inline(reviewer_label or "Unknown Reviewer")
    return f"**{normalized_reviewer}:** {title}"


def format_finding_recommendation(finding: PresentationFinding) -> str:
    return _normalize_inline(finding.get("recommendation", "No recommendation provided."))


def format_finding_body(*, reviewer_label: str, finding: PresentationFinding) -> str:
    return "\n".join(
        [
            format_finding_headline(reviewer_label=reviewer_label, finding=finding),
            "",
            format_finding_recommendation(finding),
        ]
    )
