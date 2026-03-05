from scripts.shared.consensus_renderer import render_consensus_comment
from scripts.shared.types import PresentationEntry


def _entry(*, reviewer: str, status: str, finding_id: str, title: str) -> PresentationEntry:
    return {
        "reviewer": reviewer,
        "status": status,
        "finding": {
            "id": finding_id,
            "title": title,
            "recommendation": "Fix it",
            "file": "src/app.py",
            "line": 42,
        },
    }


def test_render_consensus_comment_no_findings_is_compact() -> None:
    body = render_consensus_comment(
        marker="<!-- lgtm-sticky-comment -->",
        outcome="PASS",
        outcome_reason="PASS_NO_FINDINGS",
        open_entries=[],
        resolved_entries=[],
        reviewer_errors=[],
        labels_by_reviewer_id={},
    )

    assert body == "\n".join(
        [
            "<!-- lgtm-sticky-comment -->",
            "## ✅ LGTM",
            "No open findings.",
        ]
    )


def test_render_consensus_comment_renders_only_non_empty_findings_sections() -> None:
    body = render_consensus_comment(
        marker="<!-- lgtm-sticky-comment -->",
        outcome="FAIL",
        outcome_reason="FAIL_OPEN_FINDINGS",
        open_entries=[_entry(reviewer="security", status="open", finding_id="f1", title="Issue")],
        resolved_entries=[],
        reviewer_errors=[],
        labels_by_reviewer_id={"security": "Security"},
    )

    assert "### Open Findings" in body
    assert "### Resolved Findings" not in body


def test_render_consensus_comment_renders_reviewer_errors_without_empty_findings_sections() -> None:
    body = render_consensus_comment(
        marker="<!-- lgtm-sticky-comment -->",
        outcome="FAIL",
        outcome_reason="FAIL_REVIEWER_ERRORS",
        open_entries=[],
        resolved_entries=[],
        reviewer_errors=["timeout contacting model provider"],
        labels_by_reviewer_id={},
    )

    assert "### Reviewer Errors" in body
    assert "### Open Findings" not in body
    assert "### Resolved Findings" not in body
