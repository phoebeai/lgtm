from __future__ import annotations

import os
import sys
from typing import Protocol

from scripts.shared.github_client import github_request, github_request_all_pages
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


class ListReviewsFunc(Protocol):
    def __call__(
        self,
        *,
        api_base: str,
        pr_number: int,
        token: str,
    ) -> list[JSONObject]: ...


def normalize_text(value: str | int | float | bool | None) -> str:
    return str("" if value is None else value).replace("\r\n", "\n").strip()


def normalize_login(value: str | None) -> str:
    normalized = normalize_text(value).lower()
    if normalized.endswith("[bot]"):
        return normalized[: -len("[bot]")]
    return normalized


def parse_app_slug(value: str | None) -> set[str]:
    tokens = normalize_text(value).replace(",", " ").split()
    return {normalize_login(token) for token in tokens if normalize_login(token)}


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
        or "must have write access" in message
        or "cannot dismiss review" in message
        or "not permitted to dismiss reviews" in message
    )


def list_pull_reviews(*, api_base: str, pr_number: int, token: str) -> list[JSONObject]:
    return github_request_all_pages(
        token=token,
        url=f"{api_base}/pulls/{pr_number}/reviews?per_page=100&page=1",
    )


def dismiss_bot_approvals_on_failure(
    *,
    token: str,
    repo: str,
    pr_number: str,
    expected_head_sha: str,
    message: str,
    app_slug: str = "",
    request: RequestFunc = github_request,
    list_reviews: ListReviewsFunc = list_pull_reviews,
) -> int:
    normalized_token = normalize_text(token)
    normalized_repo = normalize_text(repo)
    normalized_expected_head_sha = normalize_text(expected_head_sha)
    normalized_pr_number = parse_pull_number(pr_number)
    normalized_message = normalize_text(message) or "LGTM no longer passes for the current PR head."
    normalized_app_slug = parse_app_slug(app_slug)

    if not normalized_token:
        raise ValueError("GITHUB_TOKEN is required")
    if not normalized_app_slug:
        raise ValueError("APP_SLUG is required")

    owner, name = parse_repository(normalized_repo)
    api_base = f"https://api.github.com/repos/{owner}/{name}"

    pull = request(
        method="GET",
        token=normalized_token,
        url=f"{api_base}/pulls/{normalized_pr_number}",
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
            "[dismiss-bot-approvals-on-failure] skipped: "
            f"PR head moved from {normalized_expected_head_sha} to {current_head_sha}\n"
        )
        return 0

    reviews = list_reviews(api_base=api_base, pr_number=normalized_pr_number, token=normalized_token)
    approval_review_ids: list[int] = []
    for review in reviews:
        review_id = review.get("id")
        state_value = review.get("state")
        state = normalize_text(state_value) if isinstance(state_value, str) else ""
        user_payload = review.get("user")
        user_login = (
            user_payload.get("login")
            if isinstance(user_payload, dict) and isinstance(user_payload.get("login"), str)
            else None
        )
        if not isinstance(review_id, int) or review_id <= 0:
            continue
        if state.upper() != "APPROVED":
            continue
        if normalize_login(user_login) not in normalized_app_slug:
            continue
        approval_review_ids.append(review_id)

    dismissed_count = 0
    for review_id in approval_review_ids:
        try:
            request(
                method="PUT",
                token=normalized_token,
                url=f"{api_base}/pulls/{normalized_pr_number}/reviews/{review_id}/dismissals",
                body={"message": normalized_message},
            )
            dismissed_count += 1
        except Exception as error:
            message_text = str(error)
            if is_permission_issue(message_text):
                sys.stderr.write(
                    "[dismiss-bot-approvals-on-failure] non-fatal: "
                    f"unable to dismiss review {review_id} ({normalize_text(message_text)})\n"
                )
                continue
            raise

    return dismissed_count


def main() -> None:
    dismissed_count = dismiss_bot_approvals_on_failure(
        token=os.getenv("GITHUB_TOKEN", ""),
        repo=os.getenv("GITHUB_REPOSITORY", ""),
        pr_number=os.getenv("PR_NUMBER", ""),
        expected_head_sha=os.getenv("SHA", ""),
        message=os.getenv(
            "DISMISS_APPROVAL_MESSAGE",
            "Dismissing prior LGTM approval because the latest run reported reviewer errors or open findings.",
        ),
        app_slug=os.getenv("APP_SLUG", ""),
    )
    print(f"dismissed_count={dismissed_count}")


if __name__ == "__main__":
    main()
