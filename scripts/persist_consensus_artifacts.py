from __future__ import annotations

import os
from pathlib import Path

from scripts.shared.reviewers_json import parse_reviewer_ids


def write_text_file(file_path: Path, value: str) -> None:
    file_path.write_text(f"{value}\n", encoding="utf-8")


def copy_or_create_empty_file(source_path: Path, target_path: Path) -> None:
    if source_path.exists():
        target_path.write_bytes(source_path.read_bytes())
        return

    write_text_file(target_path, "")


def persist_consensus_artifacts(
    *,
    runner_temp: str,
    reviewers_json: str,
    consensus_reports: str,
    outcome: str,
    open_findings_count: str,
    reviewer_errors_count: str,
    comment_path: str,
    ledger_path: str,
) -> None:
    normalized_runner_temp = runner_temp.strip()
    if not normalized_runner_temp:
        raise ValueError("RUNNER_TEMP is required")

    normalized_comment_path = comment_path.strip()
    if not normalized_comment_path:
        raise ValueError("COMMENT_PATH is required")

    normalized_ledger_path = ledger_path.strip()
    if not normalized_ledger_path:
        raise ValueError("LEDGER_PATH is required")

    reviewer_ids = parse_reviewer_ids(reviewers_json)
    source_reports_dir = Path(normalized_runner_temp) / "lgtm-reports"
    target_dir = Path(normalized_runner_temp) / "lgtm"
    target_dir.mkdir(parents=True, exist_ok=True)

    for reviewer_id in reviewer_ids:
        source_path = source_reports_dir / f"{reviewer_id}.json"
        target_path = target_dir / f"{reviewer_id}.json"
        copy_or_create_empty_file(source_path, target_path)

    write_text_file(target_dir / "reports-merged.json", consensus_reports)
    write_text_file(target_dir / "outcome.txt", outcome)
    write_text_file(target_dir / "open-findings-count.txt", open_findings_count)
    write_text_file(target_dir / "reviewer-errors-count.txt", reviewer_errors_count)

    (target_dir / "comment.md").write_bytes(Path(normalized_comment_path).read_bytes())
    (target_dir / "findings-ledger.json").write_bytes(Path(normalized_ledger_path).read_bytes())


def main() -> None:
    persist_consensus_artifacts(
        runner_temp=os.getenv("RUNNER_TEMP", ""),
        reviewers_json=os.getenv("REVIEWERS_JSON", "[]"),
        consensus_reports=os.getenv("CONSENSUS_REPORTS", ""),
        outcome=os.getenv("OUTCOME", ""),
        open_findings_count=os.getenv("OPEN_FINDINGS_COUNT", "0"),
        reviewer_errors_count=os.getenv("REVIEWER_ERRORS_COUNT", "0"),
        comment_path=os.getenv("COMMENT_PATH", ""),
        ledger_path=os.getenv("LEDGER_PATH", ""),
    )


if __name__ == "__main__":
    main()
