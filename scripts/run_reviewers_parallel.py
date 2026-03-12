from __future__ import annotations

import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

from openai import OpenAI

from scripts.build_trusted_reviewer_inputs import (
    build_trusted_reviewer_inputs,
    count_changed_lines_for_files,
    exclude_generated_files,
    read_changed_files,
)
from scripts.normalize_reviewer_output import process_reviewer_output
from scripts.shared.findings_ledger import normalize_ledger
from scripts.shared.reviewer_core import ReviewerReport, make_base_payload
from scripts.shared.reviewers_json import parse_reviewers_for_runner
from scripts.shared.types import FindingsLedger, ReviewerConfig

GLOBAL_ERRORS_FILENAME = "global-errors.json"


@dataclass(frozen=True)
class ReviewExecutionResult:
    raw_output: str
    outcome: str
    conclusion: str
    error: str


@dataclass(frozen=True)
class ReviewerRunResult:
    reviewer: str
    run_state: str
    report_path: str


def read_required_env(name: str) -> str:
    value = (os.getenv(name, "") or "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


def make_empty_ledger() -> FindingsLedger:
    return FindingsLedger(version=1, findings=[])


def read_prior_ledger(file_path: str) -> FindingsLedger:
    normalized_path = file_path.strip()
    if not normalized_path or not Path(normalized_path).exists():
        return make_empty_ledger()

    try:
        parsed = json.loads(Path(normalized_path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid PRIOR_LEDGER_JSON ({normalized_path}): {error}") from error

    try:
        return normalize_ledger(parsed)
    except ValueError as error:
        raise ValueError(f"Invalid PRIOR_LEDGER_JSON ({normalized_path}): {error}") from error


def make_run_git_for_workspace(workspace_dir: str):
    def run_git(args: list[str], encoding: str = "utf8") -> str | bytes:
        completed = subprocess.run(
            ["git", *args],
            cwd=workspace_dir,
            check=True,
            capture_output=True,
            text=encoding == "utf8",
        )
        if encoding == "buffer":
            assert isinstance(completed.stdout, bytes)
            return completed.stdout
        assert isinstance(completed.stdout, str)
        return completed.stdout

    return run_git


def resolve_timeout_ms(*, reviewer_timeout_minutes: str, reviewer_timeout_ms: str) -> int:
    timeout_minutes = int(reviewer_timeout_minutes or "10")
    fallback_timeout_ms = max(1, timeout_minutes) * 60 * 1000

    try:
        explicit_timeout_ms = int(reviewer_timeout_ms)
    except ValueError:
        explicit_timeout_ms = 0

    return explicit_timeout_ms if explicit_timeout_ms > 0 else fallback_timeout_ms


def load_output_schema(schema_path: str) -> dict[str, object]:
    try:
        parsed = json.loads(Path(schema_path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid reviewer output schema at {schema_path}: {error}") from error

    if not isinstance(parsed, dict):
        raise ValueError(f"Invalid reviewer output schema at {schema_path}: root must be an object")

    return parsed


def build_global_oversized_message(*, changed_lines: int, files_count: int, max_changed_lines: int) -> str:
    return (
        "Diff exceeds max_changed_lines "
        f"({changed_lines} changed lines across {files_count} files; "
        f"limit {max_changed_lines}). Use manual review or break the change into smaller PRs."
    )


def evaluate_global_preflight(
    *,
    base_sha: str,
    head_sha: str,
    max_changed_lines: int,
    run_git,
) -> str | None:
    if not isinstance(max_changed_lines, int) or isinstance(max_changed_lines, bool) or max_changed_lines <= 0:
        raise ValueError("MAX_CHANGED_LINES must be an integer greater than 0")

    changed_files = read_changed_files(base_sha, head_sha, run_git)
    if not changed_files:
        return None

    reviewable_files = exclude_generated_files(changed_files, run_git)
    if not reviewable_files:
        return None

    changed_lines = count_changed_lines_for_files(base_sha, head_sha, reviewable_files, run_git)
    if changed_lines <= max_changed_lines:
        return None

    return build_global_oversized_message(
        changed_lines=changed_lines,
        files_count=len(reviewable_files),
        max_changed_lines=max_changed_lines,
    )


def write_global_preflight_reports(
    *,
    reviewers: list[ReviewerConfig],
    reports_dir: str,
    global_error: str,
) -> list[dict[str, str]]:
    Path(reports_dir).mkdir(parents=True, exist_ok=True)
    (Path(reports_dir) / GLOBAL_ERRORS_FILENAME).write_text(
        f'{json.dumps({"errors": [global_error]})}\n',
        encoding="utf-8",
    )

    results: list[dict[str, str]] = []
    for reviewer in reviewers:
        payload = make_base_payload(
            reviewer=reviewer["id"],
            run_state="skipped",
            summary="Skipped (global preflight failed: diff exceeds max_changed_lines)",
            resolved_finding_ids=[],
            new_findings=[],
            errors=[],
        )
        report_path = Path(reports_dir) / f"{reviewer['id']}.json"
        report_path.write_text(f"{json.dumps(payload)}\n", encoding="utf-8")
        results.append(
            {
                "reviewer": reviewer["id"],
                "run_state": payload["run_state"],
                "report_path": str(report_path),
            }
        )

    results.sort(key=lambda entry: entry["reviewer"])
    return results


def default_run_reviewer_with_openai(
    *,
    model: str,
    prompt_path: str,
    output_schema: dict[str, object],
    timeout_ms: int,
) -> ReviewExecutionResult:
    prompt = Path(prompt_path).read_text(encoding="utf-8")
    timeout_seconds = max(1.0, timeout_ms / 1000)

    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    try:
        response = client.responses.create(
            model=model,
            input=prompt,
            text={
                "format": {
                    "type": "json_schema",
                    "name": "reviewer_output",
                    "schema": output_schema,
                    "strict": True,
                }
            },
            timeout=timeout_seconds,
        )
        raw_output = response.output_text or ""
        return ReviewExecutionResult(
            raw_output=raw_output,
            outcome="success",
            conclusion="success",
            error="",
        )
    except Exception as error:
        timeout_seconds_int = round(timeout_seconds)
        message = str(error)
        timeout_hint = "timed out" in message.lower() or "timeout" in message.lower()
        return ReviewExecutionResult(
            raw_output="",
            outcome="failure",
            conclusion="failure",
            error=(
                f"review timed out after {timeout_seconds_int}s"
                if timeout_hint
                else message or "review execution failed"
            ),
        )


def run_single_reviewer(
    *,
    reviewer: ReviewerConfig,
    base_sha: str,
    head_sha: str,
    pr_number: str,
    repository: str,
    resolved_model: str,
    schema_file: str,
    prompts_dir: str,
    timeout_ms: int,
    workspace_dir: str,
    prior_ledger: FindingsLedger,
    run_git,
) -> ReviewerReport:
    reviewer_id = reviewer["id"].strip()
    if not reviewer_id:
        raise ValueError("Each reviewer must include a non-empty id")

    reviewer_active = True
    reviewer_has_inputs = True
    prompt_step_outcome = "success"
    prompt_step_conclusion = "success"
    prompt_skip_reason = ""
    raw_output = ""
    review_step_outcome = ""
    review_step_conclusion = ""
    review_step_error = ""

    try:
        prepared = build_trusted_reviewer_inputs(
            base_sha=base_sha,
            head_sha=head_sha,
            reviewer=reviewer_id,
            review_scope=reviewer["scope"],
            pr_number=pr_number,
            repository=repository,
            prompt_rel=reviewer["prompt_file"],
            schema_file=schema_file,
            path_filters_json=reviewer["paths_json"],
            prior_ledger=prior_ledger,
            output_dir=prompts_dir,
            run_git=run_git,
        )

        reviewer_active = prepared.reviewer_active
        reviewer_has_inputs = prepared.reviewer_active
        prompt_skip_reason = prepared.skip_reason

        if prepared.reviewer_active:
            output_schema = load_output_schema(prepared.schema_path)
            review_result = default_run_reviewer_with_openai(
                model=resolved_model,
                prompt_path=prepared.prompt_path,
                output_schema=output_schema,
                timeout_ms=timeout_ms,
            )
            raw_output = review_result.raw_output
            review_step_outcome = review_result.outcome
            review_step_conclusion = review_result.conclusion
            review_step_error = review_result.error.strip()
    except Exception as error:
        reviewer_active = True
        reviewer_has_inputs = True
        prompt_step_outcome = "failure"
        prompt_step_conclusion = "failure"
        prompt_skip_reason = str(error) or "trusted reviewer input build failed"
        raw_output = ""
        review_step_outcome = ""
        review_step_conclusion = ""
        review_step_error = ""

    return process_reviewer_output(
        reviewer=reviewer_id,
        reviewer_active="true" if reviewer_active else "false",
        reviewer_has_inputs="true" if reviewer_has_inputs else "false",
        prompt_step_outcome=prompt_step_outcome,
        prompt_step_conclusion=prompt_step_conclusion,
        prompt_skip_reason=prompt_skip_reason,
        raw_output=raw_output,
        step_outcome=review_step_outcome,
        step_conclusion=review_step_conclusion,
        step_error=review_step_error,
    )


def run_reviewers_parallel(
    *,
    base_sha: str,
    head_sha: str,
    pr_number: str,
    repository: str,
    reviewers_json: str,
    resolved_model: str,
    max_changed_lines: str,
    schema_file: str,
    prompts_dir: str,
    reports_dir: str,
    reviewer_timeout_minutes: str,
    reviewer_timeout_ms: str,
    prior_ledger_json_path: str,
    workspace_dir: str,
) -> dict[str, str | int | list[dict[str, str]]]:
    reviewers = parse_reviewers_for_runner(reviewers_json)
    timeout_ms = resolve_timeout_ms(
        reviewer_timeout_minutes=reviewer_timeout_minutes,
        reviewer_timeout_ms=reviewer_timeout_ms,
    )
    run_git = make_run_git_for_workspace(workspace_dir)
    prior_ledger = read_prior_ledger(prior_ledger_json_path)

    Path(prompts_dir).mkdir(parents=True, exist_ok=True)
    Path(reports_dir).mkdir(parents=True, exist_ok=True)

    global_preflight_error = evaluate_global_preflight(
        base_sha=base_sha,
        head_sha=head_sha,
        max_changed_lines=int(max_changed_lines),
        run_git=run_git,
    )
    if global_preflight_error:
        return {
            "reviewer_count": len(reviewers),
            "reports_dir": reports_dir,
            "results": write_global_preflight_reports(
                reviewers=reviewers,
                reports_dir=reports_dir,
                global_error=global_preflight_error,
            ),
        }

    results: list[dict[str, str]] = []
    futures = {}
    with ThreadPoolExecutor(max_workers=max(1, len(reviewers))) as executor:
        for reviewer in reviewers:
            future = executor.submit(
                run_single_reviewer,
                reviewer=reviewer,
                base_sha=base_sha,
                head_sha=head_sha,
                pr_number=pr_number,
                repository=repository,
                resolved_model=resolved_model,
                schema_file=schema_file,
                prompts_dir=prompts_dir,
                timeout_ms=timeout_ms,
                workspace_dir=workspace_dir,
                prior_ledger=prior_ledger,
                run_git=run_git,
            )
            futures[future] = reviewer["id"]

        for future in as_completed(futures):
            reviewer_id = futures[future]
            payload = future.result()
            report_path = Path(reports_dir) / f"{reviewer_id}.json"
            report_path.write_text(f"{json.dumps(payload)}\n", encoding="utf-8")

            results.append(
                {
                    "reviewer": reviewer_id,
                    "run_state": payload["run_state"],
                    "report_path": str(report_path),
                }
            )

    results.sort(key=lambda entry: entry["reviewer"])
    return {
        "reviewer_count": len(reviewers),
        "reports_dir": reports_dir,
        "results": results,
    }


def main() -> None:
    result = run_reviewers_parallel(
        base_sha=read_required_env("BASE_SHA"),
        head_sha=read_required_env("HEAD_SHA"),
        pr_number=read_required_env("PR_NUMBER"),
        repository=read_required_env("REPOSITORY"),
        reviewers_json=read_required_env("REVIEWERS_JSON"),
        resolved_model=read_required_env("RESOLVED_MODEL"),
        max_changed_lines=read_required_env("MAX_CHANGED_LINES"),
        schema_file=read_required_env("SCHEMA_FILE"),
        prompts_dir=read_required_env("PROMPTS_DIR"),
        reports_dir=read_required_env("REPORTS_DIR"),
        reviewer_timeout_minutes=os.getenv("REVIEWER_TIMEOUT_MINUTES", "10"),
        reviewer_timeout_ms=os.getenv("REVIEWER_TIMEOUT_MS", "0"),
        prior_ledger_json_path=os.getenv("PRIOR_LEDGER_JSON", ""),
        workspace_dir=read_required_env("WORKSPACE_DIR"),
    )

    print(json.dumps(result))


if __name__ == "__main__":
    main()
