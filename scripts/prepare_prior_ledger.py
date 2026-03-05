from __future__ import annotations

import json
import os
from pathlib import Path

from scripts.shared.github_output import write_github_output
from scripts.shared.types import FindingsLedger


def normalize_text(value: str | int | float | bool | None) -> str:
    return str("" if value is None else value).strip()


def ensure_parent_dir(file_path: str) -> None:
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)


def empty_ledger() -> FindingsLedger:
    return FindingsLedger(version=1, findings=[])


def load_prior_ledger(source_dir: str) -> tuple[FindingsLedger, str]:
    normalized_source_dir = normalize_text(source_dir)
    if not normalized_source_dir:
        return empty_ledger(), "empty"

    source_path = Path(normalized_source_dir) / "findings-ledger.json"
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

    ledger, source = load_prior_ledger(os.getenv("PRIOR_ARTIFACT_DIR", ""))

    ensure_parent_dir(output_path)
    Path(output_path).write_text(f"{json.dumps(ledger, indent=2)}\n", encoding="utf-8")

    github_output = os.getenv("GITHUB_OUTPUT")
    write_github_output("prior_ledger_json", output_path, github_output)
    write_github_output("prior_ledger_source", source, github_output)

    print(json.dumps({"prior_ledger_json": output_path, "prior_ledger_source": source}))


if __name__ == "__main__":
    main()
