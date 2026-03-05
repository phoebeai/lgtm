from scripts.shared.types import JSONObject
from scripts.upsert_pr_comment import is_trusted_sticky_owner, resolve_trusted_sticky_owners


def test_resolve_trusted_sticky_owners_uses_app_slug_without_bot_suffix() -> None:
    def fake_request(
        *,
        method: str,
        url: str,
        token: str,
        body: JSONObject | None = None,
    ) -> JSONObject:
        del body
        assert method == "GET"
        assert token == "token"
        if url.endswith("/installation"):
            return {"app_slug": "phoebe-lgtm"}
        if url == "https://api.github.com/user":
            return {"login": "phoebe-lgtm"}
        raise AssertionError(f"unexpected URL: {url}")

    owners = resolve_trusted_sticky_owners(
        api_base="https://api.github.com/repos/phoebeai/lgtm",
        token="token",
        trusted_owner_logins="",
        request=fake_request,
    )

    assert "phoebe-lgtm" in owners
    assert "phoebe-lgtm[bot]" not in owners


def test_is_trusted_sticky_owner_matches_bot_suffix_variant() -> None:
    trusted_owners = {"phoebe-lgtm"}
    assert is_trusted_sticky_owner("phoebe-lgtm[bot]", trusted_owners)
