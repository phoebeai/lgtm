from scripts.resolve_pull_request_metadata import (
    fetch_pull_request_metadata,
    resolve_pull_request_metadata,
)


def test_resolve_pull_request_metadata_uses_event_payload_for_pull_request() -> None:
    pr_number, base_sha, head_sha = resolve_pull_request_metadata(
        event_name="pull_request",
        caller_event_name="pull_request",
        event_pr_number="12",
        event_base_sha="base123",
        event_head_sha="head456",
        input_pr_number="0",
        parsed_pr_number="0",
        token="token",
        api_url="https://api.github.com",
        repository="phoebeai/lgtm",
    )

    assert pr_number == "12"
    assert base_sha == "base123"
    assert head_sha == "head456"


def test_resolve_pull_request_metadata_prefers_parsed_pr_number(monkeypatch) -> None:
    def fake_github_request(*, method: str, token: str, url: str, body=None):
        assert method == "GET"
        assert token == "token"
        assert url == "https://api.github.com/repos/phoebeai/lgtm/pulls/12"
        return {
            "number": 12,
            "base": {"sha": "base123"},
            "head": {"sha": "head456"},
        }

    monkeypatch.setattr("scripts.resolve_pull_request_metadata.github_request", fake_github_request)

    pr_number, base_sha, head_sha = resolve_pull_request_metadata(
        event_name="workflow_call",
        caller_event_name="issue_comment",
        event_pr_number="0",
        event_base_sha="",
        event_head_sha="",
        input_pr_number="99",
        parsed_pr_number="12",
        token="token",
        api_url="https://api.github.com",
        repository="phoebeai/lgtm",
    )

    assert pr_number == "12"
    assert base_sha == "base123"
    assert head_sha == "head456"


def test_fetch_pull_request_metadata_rejects_invalid_payload(monkeypatch) -> None:
    monkeypatch.setattr(
        "scripts.resolve_pull_request_metadata.github_request",
        lambda **_: {"number": 12, "base": {}, "head": {"sha": "head456"}},
    )

    try:
        fetch_pull_request_metadata(
            token="token",
            api_url="https://api.github.com",
            repository="phoebeai/lgtm",
            pr_number=12,
        )
    except ValueError as error:
        assert str(error) == "Pull request base/head sha missing from payload"
    else:
        raise AssertionError("Expected ValueError")
