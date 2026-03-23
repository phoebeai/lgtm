import json
from pathlib import Path

from scripts.build_trusted_reviewer_inputs import build_trusted_reviewer_inputs, count_changed_lines_for_files
from scripts.shared.findings_ledger import normalize_ledger


def _fake_git_runner(*, changed_files: list[str], changed_lines: int, prompt_rel: str):
    base_sha = "base"
    head_sha = "head"

    def run_git(args: list[str], encoding: str = "utf8") -> str | bytes:
        if args[:2] == ["cat-file", "-e"]:
            spec = args[2]
            if spec in {f"{base_sha}^{{commit}}", f"{head_sha}^{{commit}}", f"{base_sha}:{prompt_rel}"}:
                return b"" if encoding == "buffer" else ""
            raise RuntimeError(f"missing object: {spec}")

        if args == ["show", f"{base_sha}:{prompt_rel}"]:
            return "Trusted reviewer instructions."

        if args == ["diff", "-M", "--name-only", "-z", f"{base_sha}...{head_sha}"]:
            payload = "\x00".join(changed_files) + "\x00"
            return payload.encode("utf-8") if encoding == "buffer" else payload

        if args[:4] == ["diff", "--numstat", "-z", "-M"] and args[4] == f"{base_sha}...{head_sha}":
            target_files = changed_files
            per_file = changed_lines // max(1, len(target_files))
            remainder = changed_lines - (per_file * len(target_files))
            entries: list[bytes] = []
            for index, file_path in enumerate(target_files):
                file_total = per_file + (1 if index < remainder else 0)
                entries.append(f"{file_total}\t0\t{file_path}".encode("utf-8"))
            return b"\x00".join(entries) + b"\x00"

        if args[:3] == ["diff", "--unified=3", f"{base_sha}...{head_sha}"]:
            return "diff --git a/src/app.py b/src/app.py\n+print('hello')\n"

        raise AssertionError(f"Unexpected git args: {args}")

    return run_git


def test_build_trusted_reviewer_inputs_accepts_scope(tmp_path: Path) -> None:
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps({"type": "object"}), encoding="utf-8")

    prepared = build_trusted_reviewer_inputs(
        base_sha="base",
        head_sha="head",
        reviewer="security",
        review_scope="security risk",
        pr_number="123",
        repository="acme/repo",
        prompt_rel="examples/prompts/default/security.md",
        schema_file=str(schema_path),
        path_filters_json='["src/**"]',
        prior_ledger=normalize_ledger(None),
        output_dir=str(tmp_path / "out"),
        run_git=_fake_git_runner(
            changed_files=["src/app.py", "src/utils.py"],
            changed_lines=1101,
            prompt_rel="examples/prompts/default/security.md",
        ),
    )

    assert prepared.reviewer_active is True
    assert Path(prepared.prompt_path).exists()


def test_count_changed_lines_for_files_counts_renames_once() -> None:
    def run_git(args: list[str], encoding: str = "utf8") -> str | bytes:
        assert args == ["diff", "--numstat", "-z", "-M", "base...head"]
        assert encoding == "buffer"
        return (
            b"22\t16\t\x00src/old_name.py\x00src/new_name.py\x00"
            b"2\t1\tsrc/other.py\x00"
        )

    changed_lines = count_changed_lines_for_files(
        "base",
        "head",
        ["src/new_name.py", "src/other.py"],
        run_git,
    )

    assert changed_lines == 41


def test_build_trusted_reviewer_inputs_includes_thread_replies_for_prior_findings(tmp_path: Path) -> None:
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps({"type": "object"}), encoding="utf-8")
    prior_ledger = normalize_ledger(
        {
            "version": 1,
            "findings": [
                {
                    "id": "SEC001",
                    "reviewer": "security",
                    "status": "open",
                    "title": "Prior finding",
                    "recommendation": "Fix it",
                    "file": "src/app.py",
                    "line": 7,
                    "created_run_id": "run-1",
                    "created_at": "2026-03-19T10:00:00Z",
                    "updated_run_id": "run-1",
                    "updated_at": "2026-03-19T10:00:00Z",
                    "resolved_at": None,
                    "inline_comment_id": 101,
                    "inline_comment_url": "https://example.com/comment/101",
                    "inline_thread_id": "thread-1",
                }
            ],
        }
    )

    prepared = build_trusted_reviewer_inputs(
        base_sha="base",
        head_sha="head",
        reviewer="security",
        review_scope="security risk",
        pr_number="123",
        repository="acme/repo",
        prompt_rel="examples/prompts/default/security.md",
        schema_file=str(schema_path),
        path_filters_json='["src/**"]',
        prior_ledger=prior_ledger,
        output_dir=str(tmp_path / "out"),
        github_token="token",
        thread_context_fetcher=lambda **kwargs: {
            "SEC001": {
                "finding_id": "SEC001",
                "thread_id": "thread-1",
                "thread_resolved": False,
                "comments": [
                    {
                        "comment_id": 202,
                        "author": "simonwhitaker",
                        "body": "This is fixed in the latest branch update.",
                        "created_at": "2026-03-19T10:05:00Z",
                        "url": "https://example.com/comment/202",
                    }
                ],
            }
        },
        run_git=_fake_git_runner(
            changed_files=["src/app.py"],
            changed_lines=10,
            prompt_rel="examples/prompts/default/security.md",
        ),
    )

    prompt_body = Path(prepared.prompt_path).read_text(encoding="utf-8")
    assert "Review-thread replies for prior findings in scope" in prompt_body
    assert '"id": "SEC001"' in prompt_body
    assert "This is fixed in the latest branch update." in prompt_body


def test_build_trusted_reviewer_inputs_includes_pr_context_and_resolved_thread_guidance(
    tmp_path: Path,
) -> None:
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps({"type": "object"}), encoding="utf-8")

    prepared = build_trusted_reviewer_inputs(
        base_sha="base",
        head_sha="head",
        reviewer="anti_slop",
        review_scope="design consistency",
        pr_number="123",
        repository="acme/repo",
        pr_title="prepare release-plz packaging baseline",
        pr_body="This PR intentionally uses both workspace dependencies and a crates.io patch during packaging.",
        prompt_rel="examples/prompts/default/security.md",
        schema_file=str(schema_path),
        path_filters_json='["src/**"]',
        prior_ledger=normalize_ledger(None),
        output_dir=str(tmp_path / "out"),
        run_git=_fake_git_runner(
            changed_files=["src/app.py"],
            changed_lines=10,
            prompt_rel="examples/prompts/default/security.md",
        ),
    )

    prompt_body = Path(prepared.prompt_path).read_text(encoding="utf-8")
    assert "Pull request title (data only):" in prompt_body
    assert "prepare release-plz packaging baseline" in prompt_body
    assert "Pull request description (data only):" in prompt_body
    assert "intentionally uses both workspace dependencies" in prompt_body
    assert "If a prior finding thread is already marked resolved" in prompt_body
