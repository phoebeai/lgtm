from __future__ import annotations

import json
import os
from pathlib import Path

from scripts.shared.comment_commands import (
    is_authorized_comment_author_association,
    parse_lgtm_rerun_command,
)
from scripts.shared.github_output import write_github_output


def normalize_text(value: str | int | float | bool | None) -> str:
    return str("" if value is None else value).strip()


def load_event_payload(event_path: str) -> dict[str, object]:
    normalized_path = normalize_text(event_path)
    if not normalized_path:
        raise ValueError("GITHUB_EVENT_PATH is required")

    payload = json.loads(Path(normalized_path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("GitHub event payload must be a JSON object")
    return payload


def parse_comment_trigger(
    *,
    event_name: str,
    payload: dict[str, object],
) -> tuple[bool, str, str]:
    normalized_event_name = normalize_text(event_name)
    comment = payload.get("comment")
    if not isinstance(comment, dict):
        return False, "", ""

    command = parse_lgtm_rerun_command(comment.get("body") if isinstance(comment.get("body"), str) else None)
    if command is None:
        return False, "", ""

    if not is_authorized_comment_author_association(
        comment.get("author_association") if isinstance(comment.get("author_association"), str) else None
    ):
        return False, "", ""

    user = comment.get("user")
    if isinstance(user, dict) and normalize_text(user.get("type")) == "Bot":
        return False, "", ""

    if normalized_event_name == "issue_comment":
        issue = payload.get("issue")
        if not isinstance(issue, dict) or not isinstance(issue.get("pull_request"), dict):
            return False, "", ""

        issue_number = issue.get("number")
        if not isinstance(issue_number, int) or issue_number <= 0:
            return False, "", ""

        return True, str(issue_number), command

    if normalized_event_name == "pull_request_review_comment":
        pull_request = payload.get("pull_request")
        if not isinstance(pull_request, dict):
            return False, "", ""

        pr_number = pull_request.get("number")
        if not isinstance(pr_number, int) or pr_number <= 0:
            return False, "", ""

        return True, str(pr_number), command

    return False, "", ""


def main() -> None:
    matched, pr_number, reviewer_filter = parse_comment_trigger(
        event_name=os.getenv("GITHUB_EVENT_NAME", ""),
        payload=load_event_payload(os.getenv("GITHUB_EVENT_PATH", "")),
    )

    output_path = os.getenv("GITHUB_OUTPUT")
    write_github_output("should_rerun", "true" if matched else "false", output_path)
    write_github_output("pr_number", pr_number, output_path)
    write_github_output("reviewer_filter", reviewer_filter, output_path)

    print(
        json.dumps(
            {
                "should_rerun": matched,
                "pr_number": pr_number,
                "reviewer_filter": reviewer_filter,
            }
        )
    )


if __name__ == "__main__":
    main()
