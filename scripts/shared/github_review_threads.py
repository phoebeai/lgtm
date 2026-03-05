from __future__ import annotations

from dataclasses import dataclass

from .findings_ledger import apply_inline_comment_metadata
from .github_client import github_graphql_request, github_request
from .types import FindingsLedger, JSONValue, LedgerFinding, PresentationFinding

RESOLVE_REVIEW_THREAD_MUTATION = """
  mutation ResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
"""

UNRESOLVE_REVIEW_THREAD_MUTATION = """
  mutation UnresolveReviewThread($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
"""

REVIEW_THREADS_QUERY = """
  query PullRequestReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
                databaseId
              }
            }
          }
        }
      }
    }
  }
"""


@dataclass
class ThreadMetadata:
    thread_id: str
    is_resolved: bool


def _normalize_text(value: str | int | float | bool | None) -> str:
    return str("" if value is None else value).replace("\r\n", "\n").strip()


def _parse_repository(repo: str) -> tuple[str, str]:
    parts = repo.split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError("GITHUB_REPOSITORY must be owner/name")
    return parts[0], parts[1]


def _parse_pull_number(value: str) -> int:
    try:
        parsed = int(value.strip())
    except ValueError as error:
        raise ValueError("PR_NUMBER must be a positive integer") from error
    if parsed <= 0:
        raise ValueError("PR_NUMBER must be a positive integer")
    return parsed


def normalize_comment_id(value: int | None) -> int | None:
    return value if isinstance(value, int) and value > 0 else None


def format_resolved_status_suffix(head_sha: str) -> str:
    normalized_head_sha = _normalize_text(head_sha)
    if not normalized_head_sha:
        return "Status: Resolved in latest run."
    return f"Status: Resolved in {normalized_head_sha[:7]}."


def collect_findings_with_inline_comments(ledger: FindingsLedger) -> list[LedgerFinding]:
    findings: list[LedgerFinding] = []
    for finding in ledger["findings"]:
        if normalize_comment_id(finding["inline_comment_id"]):
            findings.append(finding)
    return findings


def build_inline_comment_finding_shape(finding: LedgerFinding) -> PresentationFinding:
    line_value = finding["line"]
    line = line_value if isinstance(line_value, int) and line_value > 0 else None

    return PresentationFinding(
        id=_normalize_text(finding["id"]),
        title=_normalize_text(finding["title"]) or "Untitled finding",
        recommendation=_normalize_text(finding["recommendation"]) or "No recommendation provided.",
        file=_normalize_text(finding["file"]) or None,
        line=line,
    )


def update_inline_finding_comment(*, token: str, repo: str, comment_id: int | None, body: str) -> bool:
    normalized_comment_id = normalize_comment_id(comment_id)
    if not normalized_comment_id:
        return False

    owner, name = _parse_repository(repo)
    github_request(
        method="PATCH",
        token=token,
        url=f"https://api.github.com/repos/{owner}/{name}/pulls/comments/{normalized_comment_id}",
        body={"body": body},
    )
    return True


def fetch_review_thread_metadata_by_comment_id(
    *,
    token: str,
    repo: str,
    pr_number: str,
) -> dict[int, ThreadMetadata]:
    owner, name = _parse_repository(repo)
    number = _parse_pull_number(pr_number)
    metadata_by_comment_id: dict[int, ThreadMetadata] = {}
    cursor: str | None = None

    while True:
        data = github_graphql_request(
            token=token,
            query=REVIEW_THREADS_QUERY,
            variables={"owner": owner, "name": name, "number": number, "cursor": cursor},
        )
        if data is None:
            break

        repository = data.get("repository")
        if not isinstance(repository, dict):
            break
        pull_request = repository.get("pullRequest")
        if not isinstance(pull_request, dict):
            break
        connection = pull_request.get("reviewThreads")
        if not isinstance(connection, dict):
            break

        nodes_value = connection.get("nodes")
        nodes = nodes_value if isinstance(nodes_value, list) else []

        for thread in nodes:
            if not isinstance(thread, dict):
                continue

            thread_id = _normalize_text(thread.get("id") if isinstance(thread.get("id"), str) else None)
            resolved = thread.get("isResolved") is True

            comments_container = thread.get("comments")
            comments_nodes: list[JSONValue] = []
            if isinstance(comments_container, dict):
                comments_value = comments_container.get("nodes")
                if isinstance(comments_value, list):
                    comments_nodes = comments_value

            for comment in comments_nodes:
                if not isinstance(comment, dict):
                    continue
                database_id = comment.get("databaseId")
                if isinstance(database_id, int) and database_id > 0:
                    metadata_by_comment_id[database_id] = ThreadMetadata(
                        thread_id=thread_id,
                        is_resolved=resolved,
                    )

        page_info = connection.get("pageInfo")
        if not isinstance(page_info, dict) or page_info.get("hasNextPage") is not True:
            break

        end_cursor = page_info.get("endCursor")
        cursor = end_cursor if isinstance(end_cursor, str) else None

    return metadata_by_comment_id


def backfill_missing_inline_thread_ids(
    *,
    ledger: FindingsLedger,
    thread_metadata_by_comment_id: dict[int, ThreadMetadata],
) -> FindingsLedger:
    candidates: list[LedgerFinding] = []
    for finding in ledger["findings"]:
        inline_comment_id = finding["inline_comment_id"]
        if (
            isinstance(inline_comment_id, int)
            and inline_comment_id > 0
            and not _normalize_text(finding["inline_thread_id"])
        ):
            candidates.append(finding)

    if not candidates:
        return ledger

    metadata_entries: list[dict[str, JSONValue]] = []
    for finding in candidates:
        inline_comment_id = finding["inline_comment_id"]
        if not isinstance(inline_comment_id, int):
            continue

        metadata = thread_metadata_by_comment_id.get(inline_comment_id)
        thread_id = _normalize_text(metadata.thread_id if metadata else None)
        if not thread_id:
            continue

        metadata_entries.append({"finding": {"id": finding["id"]}, "inline_thread_id": thread_id})

    if not metadata_entries:
        return ledger

    return apply_inline_comment_metadata(ledger=ledger, entries=metadata_entries)


def _set_review_thread_resolved(*, token: str, thread_id: str, resolved: bool) -> bool:
    normalized_thread_id = _normalize_text(thread_id)
    if not normalized_thread_id:
        return False

    github_graphql_request(
        token=token,
        query=RESOLVE_REVIEW_THREAD_MUTATION if resolved else UNRESOLVE_REVIEW_THREAD_MUTATION,
        variables={"threadId": normalized_thread_id},
    )
    return True


def set_finding_thread_resolved(
    *,
    token: str,
    finding: LedgerFinding,
    desired_resolved: bool,
    thread_metadata_by_comment_id: dict[int, ThreadMetadata],
) -> bool:
    comment_id = normalize_comment_id(finding["inline_comment_id"])
    if not comment_id:
        return False

    metadata = thread_metadata_by_comment_id.get(comment_id)
    metadata_thread_id = _normalize_text(metadata.thread_id if metadata else None)
    thread_id = _normalize_text(finding["inline_thread_id"]) or metadata_thread_id
    if not thread_id:
        return False

    if metadata and metadata.is_resolved is desired_resolved:
        return True

    _set_review_thread_resolved(token=token, thread_id=thread_id, resolved=desired_resolved)
    thread_metadata_by_comment_id[comment_id] = ThreadMetadata(
        thread_id=thread_id,
        is_resolved=desired_resolved,
    )
    return True
