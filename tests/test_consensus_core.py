from scripts.shared.consensus_core import compute_consensus


def test_compute_consensus_surfaces_reviewer_error_details() -> None:
    result = compute_consensus(
        {
            "security": {
                "reviewer": "security",
                "run_state": "error",
                "summary": "",
                "resolved_finding_ids": [],
                "new_findings": [],
                "errors": ["trusted reviewer input build failed"],
            }
        },
        reviewers=[{"id": "security", "display_name": "Security"}],
    )

    assert result["outcome"] == "FAIL"
    assert result["reviewerErrors"] == ["security: trusted reviewer input build failed"]
