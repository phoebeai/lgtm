from scripts.dismiss_bot_approvals_on_failure import dismiss_bot_approvals_on_failure
from scripts.shared.types import JSONObject


def test_dismiss_bot_approvals_only_dismisses_matching_bot_reviews() -> None:
    calls: list[tuple[str, str, JSONObject | None]] = []

    def fake_request(
        *,
        method: str,
        url: str,
        token: str,
        body: JSONObject | None = None,
    ) -> JSONObject:
        assert token == "token"
        calls.append((method, url, body))

        if method == "GET" and url.endswith("/pulls/7"):
            return {"head": {"sha": "abc123"}}
        if method == "PUT" and url.endswith("/pulls/7/reviews/11/dismissals"):
            assert body == {"message": "dismiss stale approval"}
            return {"id": 11}

        raise AssertionError(f"unexpected request: {method} {url}")

    def fake_list_reviews(*, api_base: str, pr_number: int, token: str) -> list[JSONObject]:
        assert api_base == "https://api.github.com/repos/phoebeai/lgtm"
        assert pr_number == 7
        assert token == "token"
        return [
            {"id": 11, "state": "APPROVED", "user": {"login": "phoebe-lgtm[bot]"}},
            {"id": 12, "state": "APPROVED", "user": {"login": "human-reviewer"}},
            {"id": 13, "state": "COMMENTED", "user": {"login": "phoebe-lgtm[bot]"}},
        ]

    dismissed_count = dismiss_bot_approvals_on_failure(
        token="token",
        repo="phoebeai/lgtm",
        pr_number="7",
        expected_head_sha="abc123",
        message="dismiss stale approval",
        app_slug="phoebe-lgtm",
        request=fake_request,
        list_reviews=fake_list_reviews,
    )

    assert dismissed_count == 1
    assert any(method == "PUT" and "/reviews/11/dismissals" in url for method, url, _ in calls)
    assert not any(method == "PUT" and "/reviews/12/dismissals" in url for method, url, _ in calls)


def test_dismiss_bot_approvals_skips_when_pr_head_moves() -> None:
    calls: list[tuple[str, str, JSONObject | None]] = []

    def fake_request(
        *,
        method: str,
        url: str,
        token: str,
        body: JSONObject | None = None,
    ) -> JSONObject:
        assert token == "token"
        calls.append((method, url, body))
        if method == "GET" and url.endswith("/pulls/7"):
            return {"head": {"sha": "new-head"}}
        raise AssertionError(f"unexpected request: {method} {url}")

    def fake_list_reviews(*, api_base: str, pr_number: int, token: str) -> list[JSONObject]:
        raise AssertionError(f"should not list reviews: {api_base} {pr_number} {token}")

    dismissed_count = dismiss_bot_approvals_on_failure(
        token="token",
        repo="phoebeai/lgtm",
        pr_number="7",
        expected_head_sha="old-head",
        message="dismiss stale approval",
        app_slug="phoebe-lgtm",
        request=fake_request,
        list_reviews=fake_list_reviews,
    )

    assert dismissed_count == 0
    assert len(calls) == 1


def test_dismiss_bot_approvals_requires_app_slug() -> None:
    calls: list[tuple[str, str, JSONObject | None]] = []

    def fake_request(
        *,
        method: str,
        url: str,
        token: str,
        body: JSONObject | None = None,
    ) -> JSONObject:
        assert token == "token"
        calls.append((method, url, body))
        raise AssertionError(f"unexpected request: {method} {url}")

    def fake_list_reviews(*, api_base: str, pr_number: int, token: str) -> list[JSONObject]:
        raise AssertionError(f"should not list reviews: {api_base} {pr_number} {token}")

    try:
        dismiss_bot_approvals_on_failure(
            token="token",
            repo="phoebeai/lgtm",
            pr_number="7",
            expected_head_sha="abc123",
            message="dismiss stale approval",
            app_slug="",
            request=fake_request,
            list_reviews=fake_list_reviews,
        )
    except ValueError as error:
        assert str(error) == "APP_SLUG is required"
    else:
        raise AssertionError("expected ValueError for missing APP_SLUG")

    assert calls == []
