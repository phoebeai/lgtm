from __future__ import annotations

import json
import os

from scripts.shared.github_client import github_request
from scripts.shared.github_output import write_github_output
from scripts.shared.types import JSONValue


def normalize_text(value: object | None) -> str:
    return str("" if value is None else value).strip()


def parse_positive_int(value: object | None, label: str) -> int:
    try:
        parsed = int(normalize_text(value))
    except ValueError as error:
        raise ValueError(f"{label} must be a positive integer") from error

    if parsed <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return parsed


def parse_repository(repo: str) -> tuple[str, str]:
    parts = normalize_text(repo).split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError("REPOSITORY must be owner/name")
    return parts[0], parts[1]


def parse_pr_payload(payload: JSONValue) -> tuple[str, str, str]:
    if not isinstance(payload, dict):
        raise ValueError("Pull request payload must be an object")

    number = payload.get("number")
    base = payload.get("base")
    head = payload.get("head")
    if not isinstance(number, int) or number <= 0:
        raise ValueError("Pull request number missing from payload")
    if not isinstance(base, dict) or not isinstance(head, dict):
        raise ValueError("Pull request base/head missing from payload")

    base_sha = normalize_text(base.get("sha"))
    head_sha = normalize_text(head.get("sha"))
    if not base_sha or not head_sha:
        raise ValueError("Pull request base/head sha missing from payload")

    return str(number), base_sha, head_sha


def fetch_pull_request_metadata(*, token: str, api_url: str, repository: str, pr_number: int) -> tuple[str, str, str]:
    owner, name = parse_repository(repository)
    payload = github_request(
        method="GET",
        token=token,
        url=f"{normalize_text(api_url)}/repos/{owner}/{name}/pulls/{pr_number}",
    )
    return parse_pr_payload(payload)


def resolve_pull_request_metadata(
    *,
    event_name: str,
    caller_event_name: str,
    event_pr_number: object | None,
    event_base_sha: object | None,
    event_head_sha: object | None,
    input_pr_number: object | None,
    parsed_pr_number: object | None,
    token: str,
    api_url: str,
    repository: str,
) -> tuple[str, str, str]:
    effective_event_name = normalize_text(caller_event_name) or normalize_text(event_name)

    if effective_event_name == "pull_request":
        pr_number = str(parse_positive_int(event_pr_number, "EVENT_PR_NUMBER"))
        base_sha = normalize_text(event_base_sha)
        head_sha = normalize_text(event_head_sha)
        if not base_sha or not head_sha:
            raise ValueError("Unable to resolve pull request metadata.")
        return pr_number, base_sha, head_sha

    resolved_pr_number = normalize_text(parsed_pr_number) or normalize_text(input_pr_number)
    if not resolved_pr_number:
        raise ValueError("This reusable workflow requires pull_request context or a pull_request_number input.")

    return fetch_pull_request_metadata(
        token=normalize_text(token),
        api_url=normalize_text(api_url),
        repository=repository,
        pr_number=parse_positive_int(resolved_pr_number, "PR number"),
    )


def main() -> None:
    token = normalize_text(os.getenv("GITHUB_TOKEN", ""))
    if not token:
        raise ValueError("GITHUB_TOKEN is required")

    pr_number, base_sha, head_sha = resolve_pull_request_metadata(
        event_name=os.getenv("GITHUB_EVENT_NAME", ""),
        caller_event_name=os.getenv("CALLER_EVENT_NAME", ""),
        event_pr_number=os.getenv("EVENT_PR_NUMBER", ""),
        event_base_sha=os.getenv("EVENT_BASE_SHA", ""),
        event_head_sha=os.getenv("EVENT_HEAD_SHA", ""),
        input_pr_number=os.getenv("INPUT_PR_NUMBER", ""),
        parsed_pr_number=os.getenv("PARSED_PR_NUMBER", ""),
        token=token,
        api_url=os.getenv("API_URL", ""),
        repository=os.getenv("REPOSITORY", ""),
    )

    output_path = os.getenv("GITHUB_OUTPUT")
    write_github_output("pr_number", pr_number, output_path)
    write_github_output("base_sha", base_sha, output_path)
    write_github_output("head_sha", head_sha, output_path)

    print(json.dumps({"pr_number": pr_number, "base_sha": base_sha, "head_sha": head_sha}))


if __name__ == "__main__":
    main()
