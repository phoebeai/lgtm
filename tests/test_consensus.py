import json
from pathlib import Path

from scripts.consensus import GLOBAL_ERRORS_FILENAME, run_consensus


def test_run_consensus_includes_global_preflight_errors(tmp_path: Path) -> None:
    reports_dir = tmp_path / "reports"
    reports_dir.mkdir()
    comment_path = tmp_path / "comment.md"
    ledger_path = tmp_path / "ledger.json"

    (reports_dir / GLOBAL_ERRORS_FILENAME).write_text(
        json.dumps(
            {
                "errors": [
                    "Diff exceeds max_changed_lines "
                    "(1101 changed lines across 2 files; limit 1000). "
                    "Use manual review or break the change into smaller PRs."
                ]
            }
        ),
        encoding="utf-8",
    )
    (reports_dir / "security.json").write_text(
        json.dumps(
            {
                "reviewer": "security",
                "run_state": "skipped",
                "summary": "Skipped (global preflight failed: diff exceeds max_changed_lines)",
                "resolved_finding_ids": [],
                "new_findings": [],
                "errors": [],
            }
        ),
        encoding="utf-8",
    )

    result = run_consensus(
        run_id="run-123",
        sha="head",
        comment_path=str(comment_path),
        ledger_path=str(ledger_path),
        token="",
        repo="",
        pr_number="",
        marker="<!-- lgtm-sticky-comment -->",
        reports_dir=str(reports_dir),
        reviewers_json=json.dumps([{"id": "security", "display_name": "Security"}]),
        publish_inline_comments="false",
        prior_ledger_json="",
    )

    assert result["outcome"] == "FAIL"
    assert result["reviewerErrorsCount"] == 1
    assert result["failureReasons"] == [
        "Diff exceeds max_changed_lines "
        "(1101 changed lines across 2 files; limit 1000). "
        "Use manual review or break the change into smaller PRs."
    ]
    assert "### Reviewer Errors" in comment_path.read_text(encoding="utf-8")
