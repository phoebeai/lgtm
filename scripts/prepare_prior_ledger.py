from __future__ import annotations

import json
import os
from pathlib import Path

from scripts.shared.github_output import write_github_output
from scripts.shared.types import FindingsLedger

ARTIFACT_METADATA_FILENAME = "artifact-metadata.json"
FINDINGS_LEDGER_FILENAME = "findings-ledger.json"


def normalize_text(value: str | int | float | bool | None) -> str:
    return str("" if value is None else value).strip()


def ensure_parent_dir(file_path: str) -> None:
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)


def empty_ledger() -> FindingsLedger:
    return FindingsLedger(version=1, findings=[])


def load_artifact_metadata(source_dir: str) -> dict[str, object] | None:
    metadata_path = Path(source_dir) / ARTIFACT_METADATA_FILENAME
    if not metadata_path.exists():
        return None

    try:
        parsed = json.loads(metadata_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid prior artifact metadata JSON at {metadata_path}: {error}") from error

    if not isinstance(parsed, dict):
        raise ValueError(f"Invalid prior artifact metadata at {metadata_path}: expected JSON object")

    return parsed


def artifact_metadata_matches(
    *,
    metadata: dict[str, object] | None,
    expected_repository: str,
    expected_pr_number: str,
    expected_run_id: str,
) -> bool:
    if metadata is None:
        return True

    repository = normalize_text(metadata.get("repository"))
    pr_number = normalize_text(metadata.get("pr_number"))
    run_id = normalize_text(metadata.get("run_id"))

    return (
        repository == expected_repository
        and pr_number == expected_pr_number
        and run_id == expected_run_id
    )


def load_prior_ledger(
    source_dir: str,
    *,
    expected_repository: str,
    expected_pr_number: str,
    expected_run_id: str,
) -> tuple[FindingsLedger, str]:
    normalized_source_dir = normalize_text(source_dir)
    normalized_expected_run_id = normalize_text(expected_run_id)
    if not normalized_expected_run_id:
        return empty_ledger(), "empty"

    if not normalized_source_dir:
        return empty_ledger(), "empty"

    metadata = load_artifact_metadata(normalized_source_dir)
    if not artifact_metadata_matches(
        metadata=metadata,
        expected_repository=normalize_text(expected_repository),
        expected_pr_number=normalize_text(expected_pr_number),
        expected_run_id=normalized_expected_run_id,
    ):
        return empty_ledger(), "empty"

    source_path = Path(normalized_source_dir) / FINDINGS_LEDGER_FILENAME
    if not source_path.exists():
        return empty_ledger(), "empty"

    source_body = source_path.read_text(encoding="utf-8")
    try:
        parsed = json.loads(source_body)
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid prior ledger JSON at {source_path}: {error}") from error

    if not isinstance(parsed, dict):
        raise ValueError(f"Invalid prior ledger format at {source_path}: expected object with findings array")

    findings = parsed.get("findings")
    if not isinstance(findings, list):
        raise ValueError(f"Invalid prior ledger format at {source_path}: expected object with findings array")

    return FindingsLedger(version=1, findings=findings), "artifact"


def main() -> None:
    output_path = normalize_text(os.getenv("PRIOR_LEDGER_JSON", ""))
    if not output_path:
        raise ValueError("PRIOR_LEDGER_JSON is required")

    ledger, source = load_prior_ledger(
        os.getenv("PRIOR_ARTIFACT_DIR", ""),
        expected_repository=os.getenv("GITHUB_REPOSITORY", ""),
        expected_pr_number=os.getenv("PR_NUMBER", ""),
        expected_run_id=os.getenv("PRIOR_RUN_ID", ""),
    )

    ensure_parent_dir(output_path)
    Path(output_path).write_text(f"{json.dumps(ledger, indent=2)}\n", encoding="utf-8")

    github_output = os.getenv("GITHUB_OUTPUT")
    write_github_output("prior_ledger_json", output_path, github_output)
    write_github_output("prior_ledger_source", source, github_output)

    print(json.dumps({"prior_ledger_json": output_path, "prior_ledger_source": source}))


if __name__ == "__main__":
    main()
