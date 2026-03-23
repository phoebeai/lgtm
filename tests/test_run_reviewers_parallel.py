import json
from pathlib import Path
from typing import cast

import pytest

from scripts.run_reviewers_parallel import GLOBAL_ERRORS_FILENAME, load_output_schema, run_reviewers_parallel


def _fake_git_runner(
    *,
    changed_files: list[str],
    changed_lines_by_file: dict[str, int],
    generated_files: set[str] | None = None,
    rename_pairs: dict[str, str] | None = None,
):
    base_sha = "base"
    head_sha = "head"
    generated_paths = generated_files or set()
    renamed_paths = rename_pairs or {}

    def run_git(args: list[str], encoding: str = "utf8") -> str | bytes:
        if args[:3] == ["diff", "-M", "--name-only"] and args[3] == "-z":
            payload = "\x00".join(changed_files) + "\x00"
            return payload.encode("utf-8") if encoding == "buffer" else payload

        if args[:4] == ["diff", "--numstat", "-z", "-M"] and args[4] == f"{base_sha}...{head_sha}":
            entries: list[bytes] = []
            handled_old_paths = set()
            for file_path in changed_files:
                old_path = renamed_paths.get(file_path)
                if old_path is not None:
                    file_total = changed_lines_by_file[file_path]
                    entries.extend(
                        [
                            f"{file_total}\t0\t".encode("utf-8"),
                            old_path.encode("utf-8"),
                            file_path.encode("utf-8"),
                        ]
                    )
                    handled_old_paths.add(old_path)
                    continue

                if file_path in handled_old_paths:
                    continue

                file_total = changed_lines_by_file[file_path]
                entries.append(f"{file_total}\t0\t{file_path}".encode("utf-8"))

            return b"\x00".join(entries) + b"\x00"

        if args[:2] == ["check-attr", "linguist-generated"]:
            target_files = args[4:]
            lines = []
            for file_path in target_files:
                attr_value = "true" if file_path in generated_paths else "unspecified"
                lines.append(f"{file_path}: linguist-generated: {attr_value}")
                lines.append(f"{file_path}: generated: unspecified")
            return "\n".join(lines)

        raise AssertionError(f"Unexpected git args: {args}")

    return run_git


def test_load_output_schema_accepts_object_json(tmp_path: Path) -> None:
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps({"type": "object"}), encoding="utf-8")

    loaded = load_output_schema(str(schema_path))

    assert loaded["type"] == "object"


def test_load_output_schema_rejects_non_object_json(tmp_path: Path) -> None:
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")

    with pytest.raises(ValueError, match="root must be an object"):
        load_output_schema(str(schema_path))


def test_run_reviewers_parallel_short_circuits_when_all_applicable_reviewers_are_oversized(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps({"type": "object"}), encoding="utf-8")
    prompts_dir = tmp_path / "prompts"
    reports_dir = tmp_path / "reports"

    monkeypatch.setattr(
        "scripts.run_reviewers_parallel.make_run_git_for_workspace",
        lambda workspace_dir: _fake_git_runner(
            changed_files=["src/app.py", "src/utils.py"],
            changed_lines_by_file={"src/app.py": 551, "src/utils.py": 550},
        ),
    )
    monkeypatch.setattr(
        "scripts.run_reviewers_parallel.default_run_reviewer_with_openai",
        lambda **kwargs: pytest.fail("reviewers should not execute after global oversized preflight"),
    )

    result = run_reviewers_parallel(
        base_sha="base",
        head_sha="head",
        pr_number="123",
        repository="acme/repo",
        reviewers_json=json.dumps(
            [
                {
                    "id": "security",
                    "display_name": "Security",
                    "prompt_file": "examples/prompts/default/security.md",
                    "scope": "security risk",
                    "paths": ["src/**"],
                },
                {
                    "id": "code_quality",
                    "display_name": "Code Quality",
                    "prompt_file": "examples/prompts/default/code-quality.md",
                    "scope": "code quality",
                    "paths": ["src/**"],
                },
            ]
        ),
        resolved_model="gpt-5.3-codex",
        max_changed_lines="1000",
        schema_file=str(schema_path),
        prompts_dir=str(prompts_dir),
        reports_dir=str(reports_dir),
        reviewer_timeout_minutes="10",
        reviewer_timeout_ms="0",
        prior_ledger_json_path="",
        prior_artifact_dir="",
        prior_run_id="",
        workspace_dir=str(tmp_path),
        github_token="",
        reviewer_filter="",
    )

    assert result["reviewer_count"] == 2
    results = cast(list[dict[str, str]], result["results"])
    assert [entry["run_state"] for entry in results] == ["skipped", "skipped"]

    global_errors = json.loads((reports_dir / GLOBAL_ERRORS_FILENAME).read_text(encoding="utf-8"))
    assert global_errors["errors"] == [
        "Diff exceeds max_changed_lines "
        "(1101 changed lines across 2 files; limit 1000). "
        "Use manual review or break the change into smaller PRs."
    ]

    for reviewer_id in ("security", "code_quality"):
        payload = json.loads((reports_dir / f"{reviewer_id}.json").read_text(encoding="utf-8"))
        assert payload["run_state"] == "skipped"


def test_run_reviewers_parallel_ignores_generated_files_when_evaluating_global_preflight(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps({"type": "object"}), encoding="utf-8")
    prompts_dir = tmp_path / "prompts"
    reports_dir = tmp_path / "reports"

    monkeypatch.setattr(
        "scripts.run_reviewers_parallel.make_run_git_for_workspace",
        lambda workspace_dir: _fake_git_runner(
            changed_files=["src/generated/api.ts", "src/app.py"],
            changed_lines_by_file={"src/generated/api.ts": 5000, "src/app.py": 50},
            generated_files={"src/generated/api.ts"},
        ),
    )
    monkeypatch.setattr(
        "scripts.run_reviewers_parallel.run_single_reviewer",
        lambda **kwargs: {
            "reviewer": kwargs["reviewer"]["id"],
            "run_state": "completed",
            "summary": "ok",
            "resolved_finding_ids": [],
            "new_findings": [],
            "errors": [],
        },
    )

    result = run_reviewers_parallel(
        base_sha="base",
        head_sha="head",
        pr_number="123",
        repository="acme/repo",
        reviewers_json=json.dumps(
            [
                {
                    "id": "security",
                    "display_name": "Security",
                    "prompt_file": "examples/prompts/default/security.md",
                    "scope": "security risk",
                }
            ]
        ),
        resolved_model="gpt-5.3-codex",
        max_changed_lines="1000",
        schema_file=str(schema_path),
        prompts_dir=str(prompts_dir),
        reports_dir=str(reports_dir),
        reviewer_timeout_minutes="10",
        reviewer_timeout_ms="0",
        prior_ledger_json_path="",
        prior_artifact_dir="",
        prior_run_id="",
        workspace_dir=str(tmp_path),
        github_token="",
        reviewer_filter="",
    )

    assert result["reviewer_count"] == 1
    assert not (reports_dir / GLOBAL_ERRORS_FILENAME).exists()
    payload = json.loads((reports_dir / "security.json").read_text(encoding="utf-8"))
    assert payload["run_state"] == "completed"


def test_run_reviewers_parallel_does_not_overcount_renamed_files_in_global_preflight(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps({"type": "object"}), encoding="utf-8")
    prompts_dir = tmp_path / "prompts"
    reports_dir = tmp_path / "reports"

    monkeypatch.setattr(
        "scripts.run_reviewers_parallel.make_run_git_for_workspace",
        lambda workspace_dir: _fake_git_runner(
            changed_files=["src/new_name.py", "src/other.py"],
            changed_lines_by_file={
                "src/new_name.py": 900,
                "src/other.py": 100,
            },
            rename_pairs={"src/new_name.py": "src/old_name.py"},
        ),
    )
    monkeypatch.setattr(
        "scripts.run_reviewers_parallel.run_single_reviewer",
        lambda **kwargs: {
            "reviewer": kwargs["reviewer"]["id"],
            "run_state": "completed",
            "summary": "ok",
            "resolved_finding_ids": [],
            "new_findings": [],
            "errors": [],
        },
    )

    result = run_reviewers_parallel(
        base_sha="base",
        head_sha="head",
        pr_number="123",
        repository="acme/repo",
        reviewers_json=json.dumps(
            [
                {
                    "id": "security",
                    "display_name": "Security",
                    "prompt_file": "examples/prompts/default/security.md",
                    "scope": "security risk",
                    "paths": ["src/**"],
                }
            ]
        ),
        resolved_model="gpt-5.3-codex",
        max_changed_lines="1000",
        schema_file=str(schema_path),
        prompts_dir=str(prompts_dir),
        reports_dir=str(reports_dir),
        reviewer_timeout_minutes="10",
        reviewer_timeout_ms="0",
        prior_ledger_json_path="",
        prior_artifact_dir="",
        prior_run_id="",
        workspace_dir=str(tmp_path),
        github_token="",
        reviewer_filter="",
    )

    assert result["reviewer_count"] == 1
    assert not (reports_dir / GLOBAL_ERRORS_FILENAME).exists()
    payload = json.loads((reports_dir / "security.json").read_text(encoding="utf-8"))
    assert payload["run_state"] == "completed"


def test_run_reviewers_parallel_can_target_single_reviewer_and_seed_prior_reports(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps({"type": "object"}), encoding="utf-8")
    prompts_dir = tmp_path / "prompts"
    reports_dir = tmp_path / "reports"
    prior_artifact_dir = tmp_path / "prior-artifact"
    prior_artifact_dir.mkdir()
    (prior_artifact_dir / "code_quality.json").write_text(
        json.dumps(
            {
                "reviewer": "code_quality",
                "run_state": "error",
                "summary": "Reviewer output unavailable or invalid",
                "resolved_finding_ids": [],
                "new_findings": [],
                "errors": ["prior failure"],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        "scripts.run_reviewers_parallel.make_run_git_for_workspace",
        lambda workspace_dir: _fake_git_runner(
            changed_files=["src/app.py"],
            changed_lines_by_file={"src/app.py": 10},
        ),
    )

    executed_reviewers: list[str] = []

    def fake_run_single_reviewer(**kwargs):
        executed_reviewers.append(kwargs["reviewer"]["id"])
        return {
            "reviewer": kwargs["reviewer"]["id"],
            "run_state": "completed",
            "summary": "ok",
            "resolved_finding_ids": [],
            "new_findings": [],
            "errors": [],
        }

    monkeypatch.setattr("scripts.run_reviewers_parallel.run_single_reviewer", fake_run_single_reviewer)

    result = run_reviewers_parallel(
        base_sha="base",
        head_sha="head",
        pr_number="123",
        repository="acme/repo",
        reviewers_json=json.dumps(
            [
                {
                    "id": "security",
                    "display_name": "Security",
                    "prompt_file": "examples/prompts/default/security.md",
                    "scope": "security risk",
                },
                {
                    "id": "code_quality",
                    "display_name": "Code Quality",
                    "prompt_file": "examples/prompts/default/code-quality.md",
                    "scope": "code quality",
                },
            ]
        ),
        resolved_model="gpt-5.3-codex",
        max_changed_lines="1000",
        schema_file=str(schema_path),
        prompts_dir=str(prompts_dir),
        reports_dir=str(reports_dir),
        reviewer_timeout_minutes="10",
        reviewer_timeout_ms="0",
        prior_ledger_json_path="",
        prior_artifact_dir=str(prior_artifact_dir),
        prior_run_id="456",
        workspace_dir=str(tmp_path),
        github_token="token",
        reviewer_filter="security",
    )

    assert result["reviewer_count"] == 2
    assert executed_reviewers == ["security"]
    seeded_payload = json.loads((reports_dir / "code_quality.json").read_text(encoding="utf-8"))
    assert seeded_payload["run_state"] == "error"
    assert seeded_payload["errors"] == ["prior failure"]

def test_run_reviewers_parallel_does_not_seed_prior_reports_without_prior_run_id(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps({"type": "object"}), encoding="utf-8")
    prompts_dir = tmp_path / "prompts"
    reports_dir = tmp_path / "reports"
    prior_artifact_dir = tmp_path / "prior-artifact"
    prior_artifact_dir.mkdir()
    (prior_artifact_dir / "code_quality.json").write_text(
        json.dumps(
            {
                "reviewer": "code_quality",
                "run_state": "completed",
                "summary": "stale",
                "resolved_finding_ids": [],
                "new_findings": [],
                "errors": [],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        "scripts.run_reviewers_parallel.make_run_git_for_workspace",
        lambda workspace_dir: _fake_git_runner(
            changed_files=["src/app.py"],
            changed_lines_by_file={"src/app.py": 10},
        ),
    )
    monkeypatch.setattr(
        "scripts.run_reviewers_parallel.run_single_reviewer",
        lambda **kwargs: {
            "reviewer": kwargs["reviewer"]["id"],
            "run_state": "completed",
            "summary": "ok",
            "resolved_finding_ids": [],
            "new_findings": [],
            "errors": [],
        },
    )

    run_reviewers_parallel(
        base_sha="base",
        head_sha="head",
        pr_number="123",
        repository="acme/repo",
        reviewers_json=json.dumps(
            [
                {
                    "id": "security",
                    "display_name": "Security",
                    "prompt_file": "examples/prompts/default/security.md",
                    "scope": "security risk",
                },
                {
                    "id": "code_quality",
                    "display_name": "Code Quality",
                    "prompt_file": "examples/prompts/default/code-quality.md",
                    "scope": "code quality",
                }
            ]
        ),
        resolved_model="gpt-5.3-codex",
        max_changed_lines="1000",
        schema_file=str(schema_path),
        prompts_dir=str(prompts_dir),
        reports_dir=str(reports_dir),
        reviewer_timeout_minutes="10",
        reviewer_timeout_ms="0",
        prior_ledger_json_path="",
        prior_artifact_dir=str(prior_artifact_dir),
        prior_run_id="",
        workspace_dir=str(tmp_path),
        github_token="token",
        reviewer_filter="security",
    )

    seeded_payload = json.loads((reports_dir / "code_quality.json").read_text(encoding="utf-8"))
    assert seeded_payload["run_state"] == "skipped"
    assert seeded_payload["summary"] == "Skipped (slash-command rerun targeted reviewer security)"


def test_run_reviewers_parallel_fetches_pr_context_once_and_passes_it_to_reviewers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps({"type": "object"}), encoding="utf-8")
    prompts_dir = tmp_path / "prompts"
    reports_dir = tmp_path / "reports"

    monkeypatch.setattr(
        "scripts.run_reviewers_parallel.make_run_git_for_workspace",
        lambda workspace_dir: _fake_git_runner(
            changed_files=["src/app.py"],
            changed_lines_by_file={"src/app.py": 10},
        ),
    )
    monkeypatch.setattr(
        "scripts.run_reviewers_parallel.fetch_pull_request_context",
        lambda **kwargs: ("PR title", "PR body"),
    )

    captured_contexts: list[tuple[str, str]] = []

    def fake_run_single_reviewer(**kwargs):
        captured_contexts.append((kwargs["pr_title"], kwargs["pr_body"]))
        return {
            "reviewer": kwargs["reviewer"]["id"],
            "run_state": "completed",
            "summary": "ok",
            "resolved_finding_ids": [],
            "new_findings": [],
            "errors": [],
        }

    monkeypatch.setattr("scripts.run_reviewers_parallel.run_single_reviewer", fake_run_single_reviewer)

    result = run_reviewers_parallel(
        base_sha="base",
        head_sha="head",
        pr_number="123",
        repository="acme/repo",
        reviewers_json=json.dumps(
            [
                {
                    "id": "security",
                    "display_name": "Security",
                    "prompt_file": "examples/prompts/default/security.md",
                    "scope": "security risk",
                }
            ]
        ),
        resolved_model="gpt-5.3-codex",
        max_changed_lines="1000",
        schema_file=str(schema_path),
        prompts_dir=str(prompts_dir),
        reports_dir=str(reports_dir),
        reviewer_timeout_minutes="10",
        reviewer_timeout_ms="0",
        prior_ledger_json_path="",
        prior_artifact_dir="",
        prior_run_id="",
        workspace_dir=str(tmp_path),
        github_token="token",
        reviewer_filter="",
    )

    assert result["reviewer_count"] == 1
    assert captured_contexts == [("PR title", "PR body")]
