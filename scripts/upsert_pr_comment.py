from __future__ import annotations

import os
from pathlib import Path
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


def normalize_login(value: str | None) -> str:
    normalized = (value or "").strip().lower()
    if normalized.endswith("[bot]"):
        return normalized[: -len("[bot]")]
    return normalized


def parse_trusted_owner_logins(value: str) -> list[str]:
    tokens = [token for token in value.replace(",", " ").split() if token]
    return [normalize_login(token) for token in tokens]


def is_trusted_sticky_owner(login: str | None, trusted_owners: set[str]) -> bool:
    return normalize_login(login) in trusted_owners


def parse_comment_updated_at(comment: JSONObject) -> str:
    updated = comment.get("updated_at")
    created = comment.get("created_at")
    if isinstance(updated, str) and updated.strip():
        return updated
    if isinstance(created, str) and created.strip():
        return created
    return ""


def select_most_recently_updated_comment(comments: list[JSONObject]) -> JSONObject | None:
    if not comments:
        return None

    return sorted(comments, key=parse_comment_updated_at, reverse=True)[0]


def resolve_trusted_sticky_owners(
    *,
    api_base: str,
    token: str,
    trusted_owner_logins: str,
    request: RequestFunc = github_request,
) -> set[str]:
    owners = set(parse_trusted_owner_logins(trusted_owner_logins))
    if owners:
        return owners

    try:
        installation = request(method="GET", url=f"{api_base}/installation", token=token)
        if isinstance(installation, dict):
            app_slug = installation.get("app_slug")
            if isinstance(app_slug, str) and app_slug.strip():
                owners.add(normalize_login(app_slug))
    except Exception:
        pass

    try:
        viewer = request(method="GET", url="https://api.github.com/user", token=token)
        if isinstance(viewer, dict):
            viewer_login = viewer.get("login")
            if isinstance(viewer_login, str) and viewer_login.strip():
                owners.add(normalize_login(viewer_login))
    except Exception:
        pass

    return owners


def list_issue_comments(*, api_base: str, pr_number: str, token: str) -> list[JSONObject]:
    return github_request_all_pages(
        token=token,
        url=f"{api_base}/issues/{pr_number}/comments?per_page=100&page=1",
    )


def upsert_pr_comment(
    *,
    token: str,
    repo: str,
    pr_number: str,
    marker: str,
    comment_path: str,
    trusted_owner_logins: str,
) -> tuple[str, int]:
    normalized_token = token.strip()
    normalized_repo = repo.strip()
    normalized_pr_number = pr_number.strip()
    normalized_comment_path = comment_path.strip()

    if not normalized_token:
        raise ValueError("GITHUB_TOKEN is required")
    if not normalized_repo:
        raise ValueError("GITHUB_REPOSITORY is required")
    if not normalized_pr_number:
        raise ValueError("PR_NUMBER is required")
    if not normalized_comment_path:
        raise ValueError("COMMENT_PATH is required")

    parts = normalized_repo.split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError("GITHUB_REPOSITORY must be owner/name")

    owner, name = parts
    body = Path(normalized_comment_path).read_text(encoding="utf-8")
    api_base = f"https://api.github.com/repos/{owner}/{name}"

    trusted_owners = resolve_trusted_sticky_owners(
        api_base=api_base,
        token=normalized_token,
        trusted_owner_logins=trusted_owner_logins,
    )

    comments = list_issue_comments(api_base=api_base, pr_number=normalized_pr_number, token=normalized_token)

    candidates: list[JSONObject] = []
    for comment in comments:
        body_value = comment.get("body")
        user_value = comment.get("user")
        login = user_value.get("login") if isinstance(user_value, dict) and isinstance(user_value.get("login"), str) else None

        if isinstance(body_value, str) and marker in body_value and is_trusted_sticky_owner(login, trusted_owners):
            candidates.append(comment)

    existing = select_most_recently_updated_comment(candidates)

    if existing:
        comment_id = existing.get("id")
        if not isinstance(comment_id, int):
            raise ValueError("Existing comment is missing numeric id")

        github_request(
            method="PATCH",
            url=f"{api_base}/issues/comments/{comment_id}",
            token=normalized_token,
            body={"body": body},
        )
        return "updated", comment_id

    created = github_request(
        method="POST",
        url=f"{api_base}/issues/{normalized_pr_number}/comments",
        token=normalized_token,
        body={"body": body},
    )
    if not isinstance(created, dict):
        raise ValueError("Create comment payload was not an object")

    comment_id = created.get("id")
    if not isinstance(comment_id, int):
        raise ValueError("Created comment payload is missing numeric id")

    return "created", comment_id


def main() -> None:
    action, comment_id = upsert_pr_comment(
        token=os.getenv("GITHUB_TOKEN", ""),
        repo=os.getenv("GITHUB_REPOSITORY", ""),
        pr_number=os.getenv("PR_NUMBER", ""),
        marker="<!-- lgtm-sticky-comment -->",
        comment_path=os.getenv("COMMENT_PATH", ""),
        trusted_owner_logins=os.getenv("STICKY_COMMENT_TRUSTED_OWNERS", ""),
    )

    if action == "updated":
        print(f"Updated existing LGTM comment {comment_id}")
    else:
        print(f"Created LGTM comment {comment_id}")


if __name__ == "__main__":
    main()
