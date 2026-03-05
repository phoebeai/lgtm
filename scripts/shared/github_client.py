from __future__ import annotations

import re

import httpx

from .types import JSONObject, JSONValue

GitHubPayload = JSONValue | str | None


def _build_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "phoebe-lgtm",
    }


def _parse_response_payload(response: httpx.Response) -> GitHubPayload:
    if response.status_code == 204:
        return None

    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type or not content_type:
        try:
            parsed = response.json()
            if isinstance(parsed, (dict, list, str, int, float, bool)) or parsed is None:
                return parsed
        except ValueError:
            pass

    return response.text


def github_request(
    *,
    method: str = "GET",
    url: str,
    token: str,
    body: JSONObject | None = None,
) -> GitHubPayload:
    with httpx.Client(timeout=60.0) as client:
        response = client.request(method=method, url=url, headers=_build_headers(token), json=body)

    if response.is_error:
        raise ValueError(f"{method} {url} failed ({response.status_code}): {response.text}")

    return _parse_response_payload(response)


def github_graphql_request(*, token: str, query: str, variables: JSONObject) -> JSONObject | None:
    with httpx.Client(timeout=60.0) as client:
        response = client.post(
            "https://api.github.com/graphql",
            headers=_build_headers(token),
            json={"query": query, "variables": variables},
        )

    if response.is_error:
        raise ValueError(f"GraphQL request failed ({response.status_code}): {response.text}")

    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("GraphQL response payload was not an object")

    errors = payload.get("errors")
    if isinstance(errors, list) and errors:
        first_error = errors[0]
        if isinstance(first_error, dict):
            message = first_error.get("message")
            message_text = str(message) if isinstance(message, str) else "unknown GraphQL error"
        else:
            message_text = "unknown GraphQL error"
        raise ValueError(f"GraphQL request failed: {message_text}")

    data = payload.get("data")
    return data if isinstance(data, dict) else None


def _parse_next_link(link_header: str) -> str:
    match = re.search(r"<([^>]+)>;\s*rel=\"next\"", link_header)
    return match.group(1) if match else ""


def github_request_all_pages(*, url: str, token: str) -> list[JSONObject]:
    next_url = url
    rows: list[JSONObject] = []

    with httpx.Client(timeout=60.0) as client:
        while next_url:
            response = client.get(next_url, headers=_build_headers(token))
            if response.is_error:
                raise ValueError(f"GET {next_url} failed ({response.status_code}): {response.text}")

            payload = response.json()
            if not isinstance(payload, list):
                raise ValueError(f"GET {next_url} expected array payload")

            for row in payload:
                if isinstance(row, dict):
                    rows.append(row)

            next_url = _parse_next_link(response.headers.get("link", ""))

    return rows
