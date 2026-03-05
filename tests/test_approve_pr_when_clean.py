from scripts.approve_pr_when_clean import approve_pr_when_clean
from scripts.shared.types import JSONObject


def test_approve_pr_when_clean_posts_approval_without_comment_body() -> None:
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

        if method == "GET":
            return {"head": {"sha": "abc123"}}

        assert method == "POST"
        assert body == {"event": "APPROVE"}
        return {"id": 1}

    approve_pr_when_clean(
        token="token",
        repo="phoebeai/lgtm",
        pr_number="3",
        expected_head_sha="abc123",
        request=fake_request,
    )

    assert len(calls) == 2
