from __future__ import annotations

from .types import ConsensusResult, ConsensusReviewer, Finding, PresentationEntry, ReviewerReport


def _normalize_new_findings(findings: list[Finding] | None) -> list[Finding]:
    return findings or []


def compute_consensus(
    reports: dict[str, ReviewerReport],
    *,
    reviewers: list[ConsensusReviewer],
) -> ConsensusResult:
    if not reviewers:
        raise ValueError("computeConsensus requires a non-empty reviewers array")

    active_reviewers = [
        reviewer for reviewer in reviewers if reports.get(reviewer["id"], {}).get("run_state") != "skipped"
    ]

    reviewer_errors: list[str] = []
    reviewer_new_findings: list[PresentationEntry] = []

    for reviewer in active_reviewers:
        report = reports.get(reviewer["id"])
        if not report:
            continue

        if report["run_state"] == "error":
            reviewer_errors.append(f"{reviewer['id']}: reviewer execution/output error")
            continue

        if report["run_state"] != "completed":
            continue

        for finding in _normalize_new_findings(report.get("new_findings")):
            reviewer_new_findings.append(
                PresentationEntry(
                    reviewer=reviewer["id"],
                    status="open",
                    finding={
                        "id": finding.get("reopen_finding_id") or "",
                        "title": finding["title"],
                        "recommendation": finding["recommendation"],
                        "file": finding["file"],
                        "line": finding["line"],
                    },
                )
            )

    failure_reasons = [*reviewer_errors]
    outcome = "FAIL" if reviewer_errors else "PASS"

    return ConsensusResult(
        activeReviewers=active_reviewers,
        reviewerErrors=reviewer_errors,
        reviewerNewFindings=reviewer_new_findings,
        failureReasons=failure_reasons,
        outcome=outcome,
    )
