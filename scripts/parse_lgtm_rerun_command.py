from __future__ import annotations

import json
import os
from pathlib import Path
from typing import cast

from scripts.shared.comment_commands import (
    is_authorized_comment_author_association,
    parse_lgtm_rerun_command,
)
from scripts.shared.github_output import write_github_output


def normalize_text(value: object | None) -> str:
    return str("" if value is None else value).strip()


def parse_positive_int(value: object | None) -> int:
    text = normalize_text(value)
    try:
        parsed = int(text)
    except ValueError:
        return 0
    return parsed if parsed > 0 else 0


def parse_bool(value: object | None) -> bool:
    if isinstance(value, bool):
        return value
    return normalize_text(value).lower() == "true"


def load_event_payload(event_path: str) -> dict[str, object]:
    normalized_path = normalize_text(event_path)
    if not normalized_path:
        return {}

    payload = json.loads(Path(normalized_path).read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


def _payload_nested(payload: dict[str, object], *path: str) -> object | None:
    current: object = payload
    for key in path:
        if not isinstance(current, dict):
            return None
        current = cast(dict[str, object], current).get(key)
    return current


def parse_comment_trigger(
    *,
    event_name: str,
    comment_body: str,
    comment_author_association: str,
    comment_user_type: str,
    comment_issue_number: int,
    comment_issue_is_pull_request: bool,
    comment_review_pr_number: int,
) -> tuple[bool, str, str]:
    normalized_event_name = normalize_text(event_name)
    if normalized_event_name not in {"issue_comment", "pull_request_review_comment"}:
        return True, "", ""

    command = parse_lgtm_rerun_command(comment_body)
    if command is None:
        return False, "", ""

    if not is_authorized_comment_author_association(comment_author_association):
        return False, "", ""

    if normalize_text(comment_user_type).lower() == "bot":
        return False, "", ""

    if normalized_event_name == "issue_comment":
        if not comment_issue_is_pull_request or comment_issue_number <= 0:
            return False, "", ""
        return True, str(comment_issue_number), command

    if comment_review_pr_number <= 0:
        return False, "", ""
    return True, str(comment_review_pr_number), command


def parse_comment_trigger_from_env() -> tuple[bool, str, str]:
    event_name = normalize_text(os.getenv("CALLER_EVENT_NAME", "")) or normalize_text(os.getenv("GITHUB_EVENT_NAME", ""))
    comment_body = normalize_text(os.getenv("COMMENT_BODY", ""))
    comment_author_association = normalize_text(os.getenv("COMMENT_AUTHOR_ASSOCIATION", ""))
    comment_user_type = normalize_text(os.getenv("COMMENT_USER_TYPE", ""))
    comment_issue_number = parse_positive_int(os.getenv("COMMENT_ISSUE_NUMBER", "0"))
    comment_issue_is_pull_request = parse_bool(os.getenv("COMMENT_ISSUE_IS_PULL_REQUEST", "false"))
    comment_review_pr_number = parse_positive_int(os.getenv("COMMENT_REVIEW_PR_NUMBER", "0"))

    if (
        event_name in {"issue_comment", "pull_request_review_comment"}
        and not comment_body
        and not comment_author_association
        and comment_issue_number <= 0
        and comment_review_pr_number <= 0
    ):
        payload = load_event_payload(os.getenv("GITHUB_EVENT_PATH", ""))
        comment_body = normalize_text(_payload_nested(payload, "comment", "body"))
        comment_author_association = normalize_text(_payload_nested(payload, "comment", "author_association"))
        comment_user_type = normalize_text(_payload_nested(payload, "comment", "user", "type"))
        comment_issue_number = parse_positive_int(_payload_nested(payload, "issue", "number"))
        comment_issue_is_pull_request = isinstance(_payload_nested(payload, "issue", "pull_request"), dict)
        comment_review_pr_number = parse_positive_int(_payload_nested(payload, "pull_request", "number"))

    return parse_comment_trigger(
        event_name=event_name,
        comment_body=comment_body,
        comment_author_association=comment_author_association,
        comment_user_type=comment_user_type,
        comment_issue_number=comment_issue_number,
        comment_issue_is_pull_request=comment_issue_is_pull_request,
        comment_review_pr_number=comment_review_pr_number,
    )


def main() -> None:
    should_run, pr_number, reviewer_filter = parse_comment_trigger_from_env()

    output_path = os.getenv("GITHUB_OUTPUT")
    write_github_output("should_run", "true" if should_run else "false", output_path)
    write_github_output("pr_number", pr_number, output_path)
    write_github_output("reviewer_filter", reviewer_filter, output_path)

    print(
        json.dumps(
            {
                "should_run": should_run,
                "pr_number": pr_number,
                "reviewer_filter": reviewer_filter,
            }
        )
    )


if __name__ == "__main__":
    main()
