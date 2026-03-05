from typing import cast

from scripts.shared.findings_ledger import build_finding_id_prefix, merge_ledger_with_reports
from scripts.shared.types import FindingsLedger


def test_build_finding_id_prefix_known_and_unknown() -> None:
    assert build_finding_id_prefix("security") == "SEC"
    assert build_finding_id_prefix("test_quality") == "TQ"
    assert build_finding_id_prefix("custom_review") == "CR"


def test_merge_ledger_with_reports_creates_and_resolves() -> None:
    merged = merge_ledger_with_reports(
        prior_ledger={"version": 1, "findings": []},
        reports={
            "security": {
                "reviewer": "security",
                "run_state": "completed",
                "summary": "done",
                "resolved_finding_ids": [],
                "new_findings": [
                    {
                        "title": "Issue",
                        "recommendation": "Fix",
                        "file": "src/a.py",
                        "line": 12,
                        "reopen_finding_id": None,
                    }
                ],
                "errors": [],
            }
        },
        reviewers=[{"id": "security", "display_name": "Security"}],
        run_id="1",
        timestamp="2026-03-05T00:00:00Z",
    )

    ledger = cast(FindingsLedger, merged["ledger"])
    assert ledger["findings"][0]["id"] == "SEC001"
    assert ledger["findings"][0]["status"] == "open"

    merged_again = merge_ledger_with_reports(
        prior_ledger=ledger,
        reports={
            "security": {
                "reviewer": "security",
                "run_state": "completed",
                "summary": "done",
                "resolved_finding_ids": ["sec-1"],
                "new_findings": [],
                "errors": [],
            }
        },
        reviewers=[{"id": "security", "display_name": "Security"}],
        run_id="2",
        timestamp="2026-03-05T00:01:00Z",
    )

    resolved_ledger = cast(FindingsLedger, merged_again["ledger"])
    assert resolved_ledger["findings"][0]["status"] == "resolved"
