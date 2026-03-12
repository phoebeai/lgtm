import json
from pathlib import Path

from scripts.build_trusted_reviewer_inputs import build_trusted_reviewer_inputs
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

        if args == ["diff", "--name-only", "-z", f"{base_sha}...{head_sha}"]:
            payload = "\x00".join(changed_files) + "\x00"
            return payload.encode("utf-8") if encoding == "buffer" else payload

        if args[:3] == ["diff", "--numstat", f"{base_sha}...{head_sha}"]:
            target_files = args[4:]
            per_file = changed_lines // max(1, len(target_files))
            remainder = changed_lines - (per_file * len(target_files))
            lines = []
            for index, file_path in enumerate(target_files):
                file_total = per_file + (1 if index < remainder else 0)
                lines.append(f"{file_total}\t0\t{file_path}")
            return "\n".join(lines)

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
