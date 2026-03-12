from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

from scripts.shared.consensus_core import compute_consensus
from scripts.shared.consensus_inline_lifecycle import sync_inline_finding_lifecycle
from scripts.shared.consensus_output import write_consensus_outputs
from scripts.shared.consensus_renderer import normalize_reviewers, render_consensus_comment
from scripts.shared.findings_ledger import merge_ledger_with_reports, normalize_ledger
from scripts.shared.reviewer_core import normalize_persisted_reviewer_report
from scripts.shared.types import (
    ConsensusReviewer,
    FindingsLedger,
    LedgerFinding,
    PresentationEntry,
    ReviewerReport,
)

GLOBAL_ERRORS_FILENAME = "global-errors.json"


def normalize_text(value: str | int | float | bool | None) -> str:
    return str("" if value is None else value).replace("\r\n", "\n").strip()


def read_report_input(reports_dir: str, reviewer_id: str) -> str:
    report_path = Path(reports_dir) / f"{reviewer_id}.json"
    if not report_path.exists():
        return ""
    return report_path.read_text(encoding="utf-8")


def read_global_errors(reports_dir: str) -> list[str]:
    global_errors_path = Path(reports_dir) / GLOBAL_ERRORS_FILENAME
    if not global_errors_path.exists():
        return []

    try:
        parsed = json.loads(global_errors_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return [f"global reviewer preflight parse failure: {error}"]

    if not isinstance(parsed, dict):
        return ["global reviewer preflight parse failure: payload is not a JSON object"]

    raw_errors = parsed.get("errors")
    if not isinstance(raw_errors, list):
        return ["global reviewer preflight parse failure: errors must be an array"]

    errors = [normalize_text(entry) for entry in raw_errors if normalize_text(entry)]
    if errors:
        return errors

    return ["global reviewer preflight parse failure: errors array must contain at least one string"]


def ensure_parent_dir(file_path: str) -> None:
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)


def log_non_fatal_github_error(context: str, error: Exception) -> None:
    message = normalize_text(str(error)) or "unknown github api error"
    sys.stderr.write(f"[consensus] non-fatal {context} error: {message}\n")


def read_ledger_input(prior_ledger_json_path: str) -> FindingsLedger:
    normalized_path = normalize_text(prior_ledger_json_path)
    if not normalized_path or not Path(normalized_path).exists():
        return normalize_ledger(None)

    try:
        parsed = json.loads(Path(normalized_path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid PRIOR_LEDGER_JSON at {normalized_path}: {error}") from error

    try:
        return normalize_ledger(parsed)
    except ValueError as error:
        raise ValueError(f"Invalid PRIOR_LEDGER_JSON at {normalized_path}: {error}") from error


def render_failure_reasons(*, reviewer_errors: list[str], open_entries: list[PresentationEntry]) -> list[str]:
    reasons = [*reviewer_errors]
    for entry in open_entries:
        finding = entry["finding"]
        finding_id = normalize_text(finding.get("id"))
        title = normalize_text(finding.get("title")) or "Untitled finding"
        reasons.append(f"open-finding: {'[' + finding_id + '] ' if finding_id else ''}{title}")
    return reasons


def to_presentation_entries(ledger_findings: list[LedgerFinding], status: str) -> list[PresentationEntry]:
    entries: list[PresentationEntry] = []
    for finding in ledger_findings:
        if finding.get("status") != status:
            continue

        entries.append(
            PresentationEntry(
                reviewer=str(finding.get("reviewer", "")),
                status=str(finding.get("status", "")),
                finding={
                    "id": finding["id"],
                    "title": finding["title"],
                    "recommendation": finding["recommendation"],
                    "file": finding["file"],
                    "line": finding["line"],
                },
            )
        )

    return entries


def read_reports_for_reviewers(*, reports_dir: str, reviewers: list[ConsensusReviewer]) -> dict[str, ReviewerReport]:
    reports: dict[str, ReviewerReport] = {}
    for reviewer in reviewers:
        reports[reviewer["id"]] = normalize_persisted_reviewer_report(
            reviewer["id"],
            read_report_input(reports_dir, reviewer["id"]),
        )
    return reports


def evaluate_outcome(*, reviewer_errors_count: int, open_findings_count: int) -> tuple[str, str]:
    if reviewer_errors_count > 0:
        return "FAIL", "FAIL_REVIEWER_ERRORS"

    if open_findings_count > 0:
        return "FAIL", "FAIL_OPEN_FINDINGS"

    return "PASS", "PASS_NO_FINDINGS"


def run_consensus(
    *,
    run_id: str,
    sha: str,
    comment_path: str,
    ledger_path: str,
    token: str,
    repo: str,
    pr_number: str,
    marker: str,
    reports_dir: str,
    reviewers_json: str,
    publish_inline_comments: str,
    prior_ledger_json: str,
) -> dict[str, str | int | dict[str, ReviewerReport] | list[str]]:
    normalized_reports_dir = reports_dir.strip()
    if not normalized_reports_dir:
        raise ValueError("REPORTS_DIR is required")

    normalized_comment_path = comment_path.strip()
    if not normalized_comment_path:
        raise ValueError("COMMENT_PATH is required")

    normalized_ledger_path = ledger_path.strip()
    if not normalized_ledger_path:
        raise ValueError("LEDGER_PATH is required")

    reviewers = normalize_reviewers(reviewers_json or "[]")
    labels_by_reviewer_id = {reviewer["id"]: reviewer["display_name"] for reviewer in reviewers}

    reports = read_reports_for_reviewers(reports_dir=normalized_reports_dir, reviewers=reviewers)
    global_errors = read_global_errors(normalized_reports_dir)

    consensus = compute_consensus(reports, reviewers=reviewers)
    reviewer_errors = [*global_errors, *consensus["reviewerErrors"]]

    prior_ledger = read_ledger_input(prior_ledger_json)
    can_query_github_threads = bool(normalize_text(token) and normalize_text(repo) and normalize_text(pr_number))

    merged = merge_ledger_with_reports(
        prior_ledger=prior_ledger,
        reports=reports,
        reviewers=reviewers,
        run_id=normalize_text(run_id) or "manual",
        timestamp=datetime.now(tz=UTC).isoformat().replace("+00:00", "Z"),
    )

    ledger = merged["ledger"]
    assert isinstance(ledger, dict)

    should_publish_inline_comments = (publish_inline_comments or "true").lower() != "false"
    can_use_github = can_query_github_threads and bool(normalize_text(sha))
    if should_publish_inline_comments and can_use_github:
        ledger = sync_inline_finding_lifecycle(
            ledger=ledger,
            merged=merged,
            token=token,
            repo=repo,
            pr_number=pr_number,
            head_sha=sha,
            labels_by_reviewer_id=labels_by_reviewer_id,
            initial_thread_metadata_by_comment_id={},
            on_non_fatal_error=log_non_fatal_github_error,
        )

    open_entries = to_presentation_entries(ledger["findings"], "open")
    resolved_entries = to_presentation_entries(ledger["findings"], "resolved")

    outcome, outcome_reason = evaluate_outcome(
        reviewer_errors_count=len(reviewer_errors),
        open_findings_count=len(open_entries),
    )

    failure_reasons = render_failure_reasons(reviewer_errors=reviewer_errors, open_entries=open_entries)

    comment_body = render_consensus_comment(
        marker=marker,
        outcome=outcome,
        outcome_reason=outcome_reason,
        open_entries=open_entries,
        resolved_entries=resolved_entries,
        reviewer_errors=reviewer_errors,
        labels_by_reviewer_id=labels_by_reviewer_id,
    )

    ensure_parent_dir(normalized_comment_path)
    ensure_parent_dir(normalized_ledger_path)
    Path(normalized_comment_path).write_text(comment_body, encoding="utf-8")
    Path(normalized_ledger_path).write_text(f"{json.dumps(ledger, indent=2)}\n", encoding="utf-8")

    write_consensus_outputs(
        outcome=outcome,
        outcome_reason=outcome_reason,
        comment_path=normalized_comment_path,
        ledger_path=normalized_ledger_path,
        open_findings_count=len(open_entries),
        reviewer_errors_count=len(reviewer_errors),
        reports=reports,
        failure_reasons=failure_reasons,
    )

    return {
        "outcome": outcome,
        "outcomeReason": outcome_reason,
        "commentPath": normalized_comment_path,
        "ledgerPath": normalized_ledger_path,
        "openFindingsCount": len(open_entries),
        "reviewerErrorsCount": len(reviewer_errors),
        "reports": reports,
        "failureReasons": failure_reasons,
    }


def main() -> None:
    run_consensus(
        run_id=os.getenv("GITHUB_RUN_ID", ""),
        sha=os.getenv("SHA", ""),
        comment_path=os.getenv("COMMENT_PATH", "lgtm-comment.md"),
        ledger_path=os.getenv("LEDGER_PATH", "lgtm-findings-ledger.json"),
        token=os.getenv("GITHUB_TOKEN", ""),
        repo=os.getenv("GITHUB_REPOSITORY", ""),
        pr_number=os.getenv("PR_NUMBER", ""),
        marker="<!-- lgtm-sticky-comment -->",
        reports_dir=os.getenv("REPORTS_DIR", ""),
        reviewers_json=os.getenv("REVIEWERS_JSON", "[]"),
        publish_inline_comments=os.getenv("PUBLISH_INLINE_COMMENTS", "true"),
        prior_ledger_json=os.getenv("PRIOR_LEDGER_JSON", ""),
    )


if __name__ == "__main__":
    main()
