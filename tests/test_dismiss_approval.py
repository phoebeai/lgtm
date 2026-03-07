import pytest

from scripts.dismiss_approval import dismiss_approval
from scripts.shared.types import JSONObject


def make_review(
    *,
    review_id: int,
    login: str,
    state: str,
) -> JSONObject:
    return {"id": review_id, "user": {"login": login}, "state": state}


def test_dismisses_most_recent_bot_approval() -> None:
    calls: list[tuple[str, str, JSONObject | None]] = []

    reviews = [
        make_review(review_id=10, login="lgtm-bot[bot]", state="APPROVED"),
        make_review(review_id=20, login="human-user", state="APPROVED"),
    ]

    def fake_request(
        *,
        method: str,
        url: str,
        token: str,
        body: JSONObject | None = None,
    ) -> JSONObject:
        calls.append((method, url, body))
        return {"id": 1}

    def fake_paginated_request(*, url: str, token: str) -> list[JSONObject]:
        return reviews

    dismiss_approval(
        token="token",
        repo="phoebeai/lgtm",
        pr_number="3",
        bot_login="lgtm-bot[bot]",
        request=fake_request,
        paginated_request=fake_paginated_request,
    )

    assert len(calls) == 1
    method, url, body = calls[0]
    assert method == "PUT"
    assert "/reviews/10/dismissals" in url
    assert body is not None
    assert "message" in body


def test_no_op_when_no_bot_approval_exists() -> None:
    calls: list[tuple[str, str, JSONObject | None]] = []

    reviews = [
        make_review(review_id=10, login="human-user", state="APPROVED"),
    ]

    def fake_request(
        *,
        method: str,
        url: str,
        token: str,
        body: JSONObject | None = None,
    ) -> JSONObject:
        calls.append((method, url, body))
        return {"id": 1}

    def fake_paginated_request(*, url: str, token: str) -> list[JSONObject]:
        return reviews

    dismiss_approval(
        token="token",
        repo="phoebeai/lgtm",
        pr_number="3",
        bot_login="lgtm-bot[bot]",
        request=fake_request,
        paginated_request=fake_paginated_request,
    )

    assert len(calls) == 0


def test_no_op_when_bot_most_recent_review_is_not_approved() -> None:
    calls: list[tuple[str, str, JSONObject | None]] = []

    reviews = [
        make_review(review_id=10, login="lgtm-bot[bot]", state="APPROVED"),
        make_review(review_id=20, login="lgtm-bot[bot]", state="DISMISSED"),
    ]

    def fake_request(
        *,
        method: str,
        url: str,
        token: str,
        body: JSONObject | None = None,
    ) -> JSONObject:
        calls.append((method, url, body))
        return {"id": 1}

    def fake_paginated_request(*, url: str, token: str) -> list[JSONObject]:
        return reviews

    dismiss_approval(
        token="token",
        repo="phoebeai/lgtm",
        pr_number="3",
        bot_login="lgtm-bot[bot]",
        request=fake_request,
        paginated_request=fake_paginated_request,
    )

    assert len(calls) == 0


def test_no_op_when_no_reviews_exist() -> None:
    calls: list[tuple[str, str, JSONObject | None]] = []

    def fake_request(
        *,
        method: str,
        url: str,
        token: str,
        body: JSONObject | None = None,
    ) -> JSONObject:
        calls.append((method, url, body))
        return {"id": 1}

    def fake_paginated_request(*, url: str, token: str) -> list[JSONObject]:
        return []

    dismiss_approval(
        token="token",
        repo="phoebeai/lgtm",
        pr_number="3",
        bot_login="lgtm-bot[bot]",
        request=fake_request,
        paginated_request=fake_paginated_request,
    )

    assert len(calls) == 0


def test_permission_error_is_non_fatal(capsys: pytest.CaptureFixture[str]) -> None:
    reviews = [
        make_review(review_id=10, login="lgtm-bot[bot]", state="APPROVED"),
    ]

    def fake_request(
        *,
        method: str,
        url: str,
        token: str,
        body: JSONObject | None = None,
    ) -> JSONObject:
        if method == "PUT":
            raise ValueError("Resource not accessible by integration")
        return {"id": 1}

    def fake_paginated_request(*, url: str, token: str) -> list[JSONObject]:
        return reviews

    dismiss_approval(
        token="token",
        repo="phoebeai/lgtm",
        pr_number="3",
        bot_login="lgtm-bot[bot]",
        request=fake_request,
        paginated_request=fake_paginated_request,
    )

    captured = capsys.readouterr()
    assert "non-fatal" in captured.err


def test_non_permission_error_is_raised() -> None:
    reviews = [
        make_review(review_id=10, login="lgtm-bot[bot]", state="APPROVED"),
    ]

    def fake_request(
        *,
        method: str,
        url: str,
        token: str,
        body: JSONObject | None = None,
    ) -> JSONObject:
        if method == "PUT":
            raise ValueError("Internal server error")
        return {"id": 1}

    def fake_paginated_request(*, url: str, token: str) -> list[JSONObject]:
        return reviews

    with pytest.raises(ValueError, match="Internal server error"):
        dismiss_approval(
            token="token",
            repo="phoebeai/lgtm",
            pr_number="3",
            bot_login="lgtm-bot[bot]",
            request=fake_request,
            paginated_request=fake_paginated_request,
        )


def test_resolves_bot_login_when_not_provided() -> None:
    calls: list[tuple[str, str, JSONObject | None]] = []

    reviews = [
        make_review(review_id=10, login="my-app[bot]", state="APPROVED"),
    ]

    def fake_request(
        *,
        method: str,
        url: str,
        token: str,
        body: JSONObject | None = None,
    ) -> JSONObject:
        calls.append((method, url, body))
        if method == "GET" and "api.github.com/user" in url:
            raise ValueError("Forbidden")
        if method == "GET" and url == "https://api.github.com/app":
            return {"slug": "my-app"}
        return {"id": 1}

    def fake_paginated_request(*, url: str, token: str) -> list[JSONObject]:
        return reviews

    dismiss_approval(
        token="token",
        repo="phoebeai/lgtm",
        pr_number="3",
        bot_login="",
        request=fake_request,
        paginated_request=fake_paginated_request,
    )

    put_calls = [(m, u) for m, u, _ in calls if m == "PUT"]
    assert len(put_calls) == 1
    assert "/reviews/10/dismissals" in put_calls[0][1]


def test_case_insensitive_login_match() -> None:
    calls: list[tuple[str, str, JSONObject | None]] = []

    reviews = [
        make_review(review_id=10, login="LGTM-Bot[bot]", state="APPROVED"),
    ]

    def fake_request(
        *,
        method: str,
        url: str,
        token: str,
        body: JSONObject | None = None,
    ) -> JSONObject:
        calls.append((method, url, body))
        return {"id": 1}

    def fake_paginated_request(*, url: str, token: str) -> list[JSONObject]:
        return reviews

    dismiss_approval(
        token="token",
        repo="phoebeai/lgtm",
        pr_number="3",
        bot_login="lgtm-bot[bot]",
        request=fake_request,
        paginated_request=fake_paginated_request,
    )

    assert len(calls) == 1
    assert calls[0][0] == "PUT"
