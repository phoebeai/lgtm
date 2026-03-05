from __future__ import annotations

import os
import sys
from typing import Protocol

from scripts.shared.github_client import github_request
from scripts.shared.types import JSONObject


class RequestFunc(Protocol):
    def __call__(
        self,
        *,
        method: str,
        url: str,
        token: str,
        body: JSONObject | None = None,
    ) -> JSONObject | list[JSONObject] | str | int | float | bool | None: ...


def normalize_text(value: str | int | float | bool | None) -> str:
    return str("" if value is None else value).replace("\r\n", "\n").strip()


def parse_repository(repo: str) -> tuple[str, str]:
    parts = repo.split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError("GITHUB_REPOSITORY must be owner/name")
    return parts[0], parts[1]


def parse_pull_number(value: str) -> int:
    try:
        parsed = int(value.strip())
    except ValueError as error:
        raise ValueError("PR_NUMBER must be a positive integer") from error
    if parsed <= 0:
        raise ValueError("PR_NUMBER must be a positive integer")
    return parsed


def is_permission_issue(error_message: str) -> bool:
    message = normalize_text(error_message).lower()
    return (
        "resource not accessible by integration" in message
        or "not permitted to create or approve pull requests" in message
        or "must have write access" in message
    )


def approve_pr_when_clean(
    *,
    token: str,
    repo: str,
    pr_number: str,
    expected_head_sha: str,
    request: RequestFunc = github_request,
) -> None:
    normalized_token = normalize_text(token)
    normalized_repo = normalize_text(repo)
    normalized_expected_head_sha = normalize_text(expected_head_sha)
    normalized_pr_number = parse_pull_number(pr_number)

    if not normalized_token:
        raise ValueError("GITHUB_TOKEN is required")

    owner, name = parse_repository(normalized_repo)
    pull = request(
        method="GET",
        token=normalized_token,
        url=f"https://api.github.com/repos/{owner}/{name}/pulls/{normalized_pr_number}",
    )
    if not isinstance(pull, dict):
        raise ValueError("Unable to load pull request payload")

    current_head_sha = ""
    head_payload = pull.get("head")
    if isinstance(head_payload, dict):
        sha_value = head_payload.get("sha")
        if isinstance(sha_value, str):
            current_head_sha = normalize_text(sha_value)

    if normalized_expected_head_sha and current_head_sha and normalized_expected_head_sha != current_head_sha:
        sys.stderr.write(
            f"[approve-pr-when-clean] skipped: PR head moved from {normalized_expected_head_sha} to {current_head_sha}\n"
        )
        return

    body = "LGTM automation: no open findings in the latest run."
    try:
        request(
            method="POST",
            token=normalized_token,
            url=f"https://api.github.com/repos/{owner}/{name}/pulls/{normalized_pr_number}/reviews",
            body={"event": "APPROVE", "body": body},
        )
    except Exception as error:
        message = str(error)
        if is_permission_issue(message):
            sys.stderr.write(
                f"[approve-pr-when-clean] non-fatal: unable to auto-approve ({normalize_text(message)})\n"
            )
            return
        raise


def main() -> None:
    approve_pr_when_clean(
        token=os.getenv("GITHUB_TOKEN", ""),
        repo=os.getenv("GITHUB_REPOSITORY", ""),
        pr_number=os.getenv("PR_NUMBER", ""),
        expected_head_sha=os.getenv("SHA", ""),
    )


if __name__ == "__main__":
    main()
