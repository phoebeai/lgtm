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


class PaginatedRequestFunc(Protocol):
    def __call__(
        self,
        *,
        url: str,
        token: str,
    ) -> list[JSONObject]: ...


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


def resolve_authenticated_login(
    token: str,
    request: RequestFunc,
) -> str:
    try:
        result = request(method="GET", url="https://api.github.com/user", token=token)
        if isinstance(result, dict):
            login = result.get("login")
            if isinstance(login, str) and login.strip():
                return login.strip()
    except Exception:
        pass
    # GitHub App installation tokens use /app endpoint instead.
    result = request(method="GET", url="https://api.github.com/app", token=token)
    if isinstance(result, dict):
        slug = result.get("slug")
        if isinstance(slug, str) and slug.strip():
            return f"{slug.strip()}[bot]"
    raise ValueError("Unable to resolve authenticated bot login")


def dismiss_approval(
    *,
    token: str,
    repo: str,
    pr_number: str,
    bot_login: str = "",
    request: RequestFunc = github_request,
    paginated_request: PaginatedRequestFunc = github_request_all_pages,
) -> None:
    normalized_token = normalize_text(token)
    normalized_repo = normalize_text(repo)
    normalized_bot_login = normalize_text(bot_login)
    normalized_pr_number = parse_pull_number(pr_number)

    if not normalized_token:
        raise ValueError("GITHUB_TOKEN is required")

    if not normalized_bot_login:
        normalized_bot_login = resolve_authenticated_login(normalized_token, request)

    owner, name = parse_repository(normalized_repo)
    reviews_url = f"https://api.github.com/repos/{owner}/{name}/pulls/{normalized_pr_number}/reviews"

    reviews = paginated_request(url=reviews_url, token=normalized_token)

    # Find the most recent APPROVED review from the bot.
    # Reviews are returned chronologically; we walk backwards.
    approval_review_id: int | None = None
    for review in reversed(reviews):
        user = review.get("user")
        if not isinstance(user, dict):
            continue
        login = normalize_text(user.get("login"))
        state = normalize_text(review.get("state")).upper()

        if login.lower() != normalized_bot_login.lower():
            continue

        # If the bot's most recent review is already non-APPROVED, nothing to do.
        if state != "APPROVED":
            return

        review_id = review.get("id")
        if isinstance(review_id, int):
            approval_review_id = review_id
            break

    if approval_review_id is None:
        return

    try:
        request(
            method="PUT",
            url=f"{reviews_url}/{approval_review_id}/dismissals",
            token=normalized_token,
            body={"message": "Dismissing prior approval: open findings detected."},
        )
    except Exception as error:
        message = str(error)
        if is_permission_issue(message):
            sys.stderr.write(
                f"[dismiss-approval] non-fatal: unable to dismiss approval ({normalize_text(message)})\n"
            )
            return
        raise


def main() -> None:
    dismiss_approval(
        token=os.getenv("GITHUB_TOKEN", ""),
        repo=os.getenv("GITHUB_REPOSITORY", ""),
        pr_number=os.getenv("PR_NUMBER", ""),
    )


if __name__ == "__main__":
    main()
