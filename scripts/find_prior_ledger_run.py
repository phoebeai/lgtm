from __future__ import annotations

import json
import os

from scripts.shared.github_client import github_request
from scripts.shared.github_output import write_github_output
from scripts.shared.types import JSONValue


def normalize_text(value: str | int | float | bool | None) -> str:
    return str("" if value is None else value).strip()


def parse_repository(repo: str) -> tuple[str, str]:
    parts = normalize_text(repo).split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError("GITHUB_REPOSITORY must be owner/name")
    return parts[0], parts[1]


def parse_positive_int(value: str, label: str) -> int:
    try:
        parsed = int(normalize_text(value))
    except ValueError as error:
        raise ValueError(f"{label} must be a positive integer") from error

    if parsed <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return parsed


def parse_optional_positive_int(value: str | None) -> int | None:
    try:
        parsed = int(normalize_text(value or ""))
    except ValueError:
        return None

    return parsed if parsed > 0 else None


def run_belongs_to_pull_request(run_payload: dict[str, JSONValue], pull_number: int) -> bool:
    pull_requests = run_payload.get("pull_requests")
    if not isinstance(pull_requests, list):
        return False

    for pull_request in pull_requests:
        if isinstance(pull_request, dict):
            number = pull_request.get("number")
            if isinstance(number, int) and number == pull_number:
                return True
    return False


def parse_max_pages(value: str | None) -> int:
    try:
        parsed = int(normalize_text(value or ""))
    except ValueError:
        return 100

    return parsed if parsed > 0 else 100


def find_prior_ledger_run(
    *,
    token: str,
    repo: str,
    pr_number: str,
    current_run_id: str,
    max_pages: str | None = None,
) -> tuple[str, str]:
    owner, name = parse_repository(repo)
    normalized_pr_number = parse_positive_int(pr_number, "PR_NUMBER")
    normalized_current_run_id = parse_positive_int(current_run_id, "GITHUB_RUN_ID")
    normalized_max_pages = parse_max_pages(max_pages)

    current_run_payload = github_request(
        method="GET",
        token=token,
        url=f"https://api.github.com/repos/{owner}/{name}/actions/runs/{normalized_current_run_id}",
    )
    if not isinstance(current_run_payload, dict):
        raise ValueError("Unable to resolve current workflow run")

    current_workflow_id = parse_optional_positive_int(
        str(current_run_payload.get("workflow_id")) if current_run_payload.get("workflow_id") is not None else None
    )

    for page in range(1, normalized_max_pages + 1):
        if current_workflow_id is not None:
            runs_url = (
                f"https://api.github.com/repos/{owner}/{name}/actions/workflows/{current_workflow_id}"
                f"/runs?status=completed&per_page=100&page={page}"
            )
        else:
            runs_url = (
                f"https://api.github.com/repos/{owner}/{name}/actions/runs?status=completed&per_page=100&page={page}"
            )

        runs_payload = github_request(method="GET", token=token, url=runs_url)
        if not isinstance(runs_payload, dict):
            raise ValueError("GitHub runs payload must be an object")

        workflow_runs = runs_payload.get("workflow_runs")
        if not isinstance(workflow_runs, list) or not workflow_runs:
            break

        candidates: list[dict[str, JSONValue]] = []
        for run in workflow_runs:
            if not isinstance(run, dict):
                continue

            run_id = run.get("id")
            if not isinstance(run_id, int) or run_id >= normalized_current_run_id:
                continue
            if not run_belongs_to_pull_request(run, normalized_pr_number):
                continue

            if current_workflow_id is not None:
                workflow_id = run.get("workflow_id")
                if not isinstance(workflow_id, int) or workflow_id != current_workflow_id:
                    continue

            candidates.append(run)

        candidates.sort(
            key=lambda run: normalize_text(run.get("created_at") if isinstance(run.get("created_at"), str) else ""),
            reverse=True,
        )

        for candidate in candidates:
            run_id = candidate.get("id")
            if not isinstance(run_id, int) or run_id <= 0:
                continue

            expected_artifact_name = f"lgtm-{run_id}"
            artifacts_payload = github_request(
                method="GET",
                token=token,
                url=f"https://api.github.com/repos/{owner}/{name}/actions/runs/{run_id}/artifacts?per_page=100",
            )
            if not isinstance(artifacts_payload, dict):
                continue

            artifacts = artifacts_payload.get("artifacts")
            if not isinstance(artifacts, list):
                continue

            for artifact in artifacts:
                if not isinstance(artifact, dict):
                    continue

                artifact_name = artifact.get("name")
                artifact_expired = artifact.get("expired")
                if (
                    isinstance(artifact_name, str)
                    and artifact_name == expected_artifact_name
                    and artifact_expired is False
                ):
                    return str(run_id), expected_artifact_name

    return "", ""


def main() -> None:
    token = normalize_text(os.getenv("GITHUB_TOKEN", ""))
    if not token:
        raise ValueError("GITHUB_TOKEN is required")

    prior_run_id, prior_artifact_name = find_prior_ledger_run(
        token=token,
        repo=os.getenv("GITHUB_REPOSITORY", ""),
        pr_number=os.getenv("PR_NUMBER", ""),
        current_run_id=os.getenv("GITHUB_RUN_ID", ""),
        max_pages=os.getenv("PRIOR_LEDGER_MAX_PAGES", ""),
    )

    output_path = os.getenv("GITHUB_OUTPUT")
    write_github_output("prior_run_id", prior_run_id, output_path)
    write_github_output("prior_artifact_name", prior_artifact_name, output_path)

    print(json.dumps({"prior_run_id": prior_run_id, "prior_artifact_name": prior_artifact_name}))


if __name__ == "__main__":
    main()
