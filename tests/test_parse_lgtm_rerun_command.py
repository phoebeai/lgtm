from scripts.parse_lgtm_rerun_command import parse_comment_trigger


def test_parse_issue_comment_rerun_command_for_pr() -> None:
    matched, pr_number, reviewer_filter = parse_comment_trigger(
        event_name="issue_comment",
        payload={
            "issue": {"number": 267, "pull_request": {"url": "https://example.com/pr/267"}},
            "comment": {
                "body": "/lgtm rerun grumpy",
                "author_association": "MEMBER",
                "user": {"type": "User"},
            },
        },
    )

    assert matched is True
    assert pr_number == "267"
    assert reviewer_filter == "grumpy"


def test_parse_review_comment_rerun_command_defaults_to_all_reviewers() -> None:
    matched, pr_number, reviewer_filter = parse_comment_trigger(
        event_name="pull_request_review_comment",
        payload={
            "pull_request": {"number": 267},
            "comment": {
                "body": "/lgtm rerun",
                "author_association": "OWNER",
                "user": {"type": "User"},
            },
        },
    )

    assert matched is True
    assert pr_number == "267"
    assert reviewer_filter == ""


def test_parse_comment_trigger_ignores_unauthorized_author() -> None:
    matched, pr_number, reviewer_filter = parse_comment_trigger(
        event_name="issue_comment",
        payload={
            "issue": {"number": 267, "pull_request": {"url": "https://example.com/pr/267"}},
            "comment": {
                "body": "/lgtm rerun security",
                "author_association": "CONTRIBUTOR",
                "user": {"type": "User"},
            },
        },
    )

    assert matched is False
    assert pr_number == ""
    assert reviewer_filter == ""
