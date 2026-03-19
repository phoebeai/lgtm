from scripts.parse_lgtm_rerun_command import parse_comment_trigger


def test_parse_issue_comment_rerun_command_for_pr() -> None:
    should_run, pr_number, reviewer_filter = parse_comment_trigger(
        event_name="issue_comment",
        comment_body="/lgtm rerun grumpy",
        comment_author_association="MEMBER",
        comment_user_type="User",
        comment_issue_number=267,
        comment_issue_is_pull_request=True,
        comment_review_pr_number=0,
    )

    assert should_run is True
    assert pr_number == "267"
    assert reviewer_filter == "grumpy"


def test_parse_review_comment_rerun_command_defaults_to_all_reviewers() -> None:
    should_run, pr_number, reviewer_filter = parse_comment_trigger(
        event_name="pull_request_review_comment",
        comment_body="/lgtm rerun",
        comment_author_association="OWNER",
        comment_user_type="User",
        comment_issue_number=0,
        comment_issue_is_pull_request=False,
        comment_review_pr_number=267,
    )

    assert should_run is True
    assert pr_number == "267"
    assert reviewer_filter == ""


def test_parse_comment_trigger_ignores_unauthorized_author() -> None:
    should_run, pr_number, reviewer_filter = parse_comment_trigger(
        event_name="issue_comment",
        comment_body="/lgtm rerun security",
        comment_author_association="CONTRIBUTOR",
        comment_user_type="User",
        comment_issue_number=267,
        comment_issue_is_pull_request=True,
        comment_review_pr_number=0,
    )

    assert should_run is False
    assert pr_number == ""
    assert reviewer_filter == ""


def test_parse_comment_trigger_allows_non_comment_events_to_run() -> None:
    should_run, pr_number, reviewer_filter = parse_comment_trigger(
        event_name="pull_request",
        comment_body="",
        comment_author_association="",
        comment_user_type="",
        comment_issue_number=0,
        comment_issue_is_pull_request=False,
        comment_review_pr_number=0,
    )

    assert should_run is True
    assert pr_number == ""
    assert reviewer_filter == ""
