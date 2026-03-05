from __future__ import annotations

from typing import Protocol

from .finding_format import format_finding_body
from .github_client import github_request
from .types import (
    InlineCommentEntry,
    JSONObject,
    PresentationEntry,
    PresentationFinding,
    PublishedInlineComments,
)


class RequestFunc(Protocol):
    def __call__(
        self,
        *,
        method: str,
        url: str,
        token: str,
        body: JSONObject | None = None,
    ) -> JSONObject | list[JSONObject] | str | int | float | bool | None: ...


def _parse_repository(repo: str) -> tuple[str, str] | None:
    parts = repo.strip().split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None
    return parts[0], parts[1]


def _normalize_text(value: str | int | float | bool | None) -> str:
    return " ".join(str("" if value is None else value).replace("\n", " ").split())


def _normalize_finding_line(value: int | None) -> int:
    return value if isinstance(value, int) and value > 0 else 0


def is_line_bound_finding(finding: PresentationFinding) -> bool:
    file_path = _normalize_text(finding.get("file"))
    line = _normalize_finding_line(finding.get("line"))
    return bool(file_path) and line > 0


def build_inline_comment_body(*, reviewer_label: str, finding: PresentationFinding) -> str:
    return format_finding_body(reviewer_label=reviewer_label, finding=finding)


def publish_inline_finding_comments(
    *,
    token: str,
    repo: str,
    pr_number: str,
    head_sha: str,
    entries: list[PresentationEntry],
    labels_by_reviewer_id: dict[str, str],
    request: RequestFunc = github_request,
) -> PublishedInlineComments:
    normalized_token = _normalize_text(token)
    normalized_repo = _normalize_text(repo)
    normalized_pr_number = _normalize_text(pr_number)
    normalized_head_sha = _normalize_text(head_sha)

    if not normalized_token or not normalized_repo or not normalized_pr_number or not normalized_head_sha:
        return PublishedInlineComments(
            attemptedCount=0,
            postedCount=0,
            failedCount=0,
            postedEntries=[],
            failedEntries=[],
        )

    parsed_repo = _parse_repository(normalized_repo)
    if not parsed_repo:
        raise ValueError("GITHUB_REPOSITORY must be owner/name")

    owner, name = parsed_repo
    api_base = f"https://api.github.com/repos/{owner}/{name}"
    line_bound_entries = [entry for entry in entries if is_line_bound_finding(entry["finding"])]

    posted_entries: list[InlineCommentEntry] = []
    failed_entries: list[InlineCommentEntry] = []

    for entry in line_bound_entries:
        finding = entry["finding"]
        reviewer = _normalize_text(entry.get("reviewer", "unknown"))
        reviewer_label = _normalize_text(labels_by_reviewer_id.get(reviewer, reviewer) or "Unknown Reviewer")
        body = build_inline_comment_body(reviewer_label=reviewer_label, finding=finding)

        path = _normalize_text(finding.get("file"))
        line = _normalize_finding_line(finding.get("line"))

        try:
            payload = request(
                method="POST",
                url=f"{api_base}/pulls/{normalized_pr_number}/comments",
                token=normalized_token,
                body={
                    "body": body,
                    "commit_id": normalized_head_sha,
                    "path": path,
                    "line": line,
                    "side": "RIGHT",
                },
            )

            comment_id: int | None = None
            comment_url = ""
            if isinstance(payload, dict):
                payload_id = payload.get("id")
                comment_id = payload_id if isinstance(payload_id, int) and payload_id > 0 else None
                comment_url_value = payload.get("html_url")
                comment_url = _normalize_text(comment_url_value if isinstance(comment_url_value, str) else "")

            posted_entries.append(
                InlineCommentEntry(
                    reviewer=entry["reviewer"],
                    status=entry["status"],
                    finding=entry["finding"],
                    comment_id=comment_id,
                    comment_url=comment_url,
                )
            )
        except Exception as error:
            failed_entries.append(
                InlineCommentEntry(
                    reviewer=entry["reviewer"],
                    status=entry["status"],
                    finding=entry["finding"],
                    error=_normalize_text(str(error)) or "unknown inline comment error",
                )
            )

    return PublishedInlineComments(
        attemptedCount=len(line_bound_entries),
        postedCount=len(posted_entries),
        failedCount=len(failed_entries),
        postedEntries=posted_entries,
        failedEntries=failed_entries,
    )
