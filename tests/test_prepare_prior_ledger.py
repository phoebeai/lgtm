import json
from pathlib import Path

from scripts.prepare_prior_ledger import ARTIFACT_METADATA_FILENAME, FINDINGS_LEDGER_FILENAME, load_prior_ledger


def test_load_prior_ledger_ignores_stale_directory_when_prior_run_id_is_missing(tmp_path: Path) -> None:
    (tmp_path / FINDINGS_LEDGER_FILENAME).write_text(json.dumps({"version": 1, "findings": [{"id": "SEC001"}]}), encoding="utf-8")

    ledger, source = load_prior_ledger(
        str(tmp_path),
        expected_repository="phoebeai/adp",
        expected_pr_number="301",
        expected_run_id="",
    )

    assert source == "empty"
    assert ledger == {"version": 1, "findings": []}


def test_load_prior_ledger_rejects_mismatched_artifact_metadata(tmp_path: Path) -> None:
    (tmp_path / ARTIFACT_METADATA_FILENAME).write_text(
        json.dumps({"repository": "phoebeai/adp", "pr_number": "300", "run_id": "999"}),
        encoding="utf-8",
    )
    (tmp_path / FINDINGS_LEDGER_FILENAME).write_text(json.dumps({"version": 1, "findings": [{"id": "SEC001"}]}), encoding="utf-8")

    ledger, source = load_prior_ledger(
        str(tmp_path),
        expected_repository="phoebeai/adp",
        expected_pr_number="301",
        expected_run_id="1000",
    )

    assert source == "empty"
    assert ledger == {"version": 1, "findings": []}


def test_load_prior_ledger_accepts_matching_artifact_metadata(tmp_path: Path) -> None:
    (tmp_path / ARTIFACT_METADATA_FILENAME).write_text(
        json.dumps({"repository": "phoebeai/adp", "pr_number": "301", "run_id": "1000"}),
        encoding="utf-8",
    )
    (tmp_path / FINDINGS_LEDGER_FILENAME).write_text(
        json.dumps({"version": 1, "findings": [{"id": "SEC001", "reviewer": "security", "title": "Issue"}]}),
        encoding="utf-8",
    )

    ledger, source = load_prior_ledger(
        str(tmp_path),
        expected_repository="phoebeai/adp",
        expected_pr_number="301",
        expected_run_id="1000",
    )

    assert source == "artifact"
    assert ledger["findings"][0]["id"] == "SEC001"
