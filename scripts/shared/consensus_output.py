from __future__ import annotations

import json
import os

from .github_output import write_github_output
from .types import ReviewerReport


def write_consensus_outputs(
    *,
    outcome: str,
    outcome_reason: str,
    comment_path: str,
    ledger_path: str,
    open_findings_count: int,
    reviewer_errors_count: int,
    reports: dict[str, ReviewerReport],
    failure_reasons: list[str],
) -> None:
    output_path = os.getenv("GITHUB_OUTPUT")

    write_github_output("outcome", outcome, output_path)
    write_github_output("outcome_reason", outcome_reason, output_path)
    write_github_output("comment_path", comment_path, output_path)
    write_github_output("ledger_path", ledger_path, output_path)
    write_github_output("open_findings_count", str(open_findings_count), output_path)
    write_github_output("reviewer_errors_count", str(reviewer_errors_count), output_path)
    write_github_output("reports_json", json.dumps(reports), output_path)
    write_github_output("failure_reasons", json.dumps(failure_reasons), output_path)
