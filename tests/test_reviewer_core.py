import json

import pytest

from scripts.shared.reviewer_core import (
    normalize_persisted_reviewer_report,
    normalize_structured_reviewer_payload,
)


def test_normalize_structured_reviewer_payload() -> None:
    payload = normalize_structured_reviewer_payload(
        {
            "reviewer": "security",
            "summary": "looks good",
            "resolved_finding_ids": ["sec-1"],
            "new_findings": [
                {
                    "title": "x",
                    "recommendation": "y",
                    "file": "a.py",
                    "line": 10,
                }
            ],
            "errors": [],
        },
        "security",
    )

    assert payload["reviewer"] == "security"
    assert payload["resolved_finding_ids"] == ["SEC001"]
    assert payload["new_findings"][0]["title"] == "x"


def test_normalize_persisted_reviewer_report_handles_invalid_json() -> None:
    payload = normalize_persisted_reviewer_report("security", "{bad")
    assert payload["run_state"] == "error"
    assert "parse failure" in payload["errors"][0]


def test_normalize_structured_reviewer_payload_rejects_missing_summary() -> None:
    with pytest.raises(ValueError, match="summary is required"):
        normalize_structured_reviewer_payload(
            {
                "reviewer": "security",
                "resolved_finding_ids": [],
                "new_findings": [],
            },
            "security",
        )


def test_normalize_persisted_report_completed_state() -> None:
    raw = json.dumps(
        {
            "reviewer": "security",
            "run_state": "completed",
            "summary": "ok",
            "resolved_finding_ids": [],
            "new_findings": [],
            "errors": [],
        }
    )
    payload = normalize_persisted_reviewer_report("security", raw)
    assert payload["run_state"] == "completed"
