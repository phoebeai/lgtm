#!/usr/bin/env node

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "phoebe-lgtm",
  };
}

async function parseResponsePayload(response) {
  if (response.status === 204) {
    return null;
  }

  const contentType =
    typeof response?.headers?.get === "function"
      ? response.headers.get("content-type") || ""
      : "";
  if (contentType.includes("application/json") && typeof response.json === "function") {
    return response.json();
  }

  if (!contentType && typeof response.json === "function") {
    return response.json();
  }

  const text = typeof response.text === "function" ? await response.text() : "";
  return text;
}

export async function githubRequest({ method = "GET", url, token, body }) {
  const response = await fetch(url, {
    method,
    headers: buildHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${url} failed (${response.status}): ${text}`);
  }

  return parseResponsePayload(response);
}

export async function githubGraphqlRequest({ token, query, variables }) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GraphQL request failed (${response.status}): ${text}`);
  }

  const payload = await response.json();
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const firstError = payload.errors[0];
    throw new Error(`GraphQL request failed: ${firstError?.message || "unknown GraphQL error"}`);
  }

  return payload?.data || null;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return "";
  const match = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  return match ? match[1] : "";
}

export async function githubRequestAllPages({ url, token }) {
  let nextUrl = url;
  const rows = [];

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      method: "GET",
      headers: buildHeaders(token),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GET ${nextUrl} failed (${response.status}): ${text}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error(`GET ${nextUrl} expected array payload`);
    }
    rows.push(...payload);

    nextUrl = parseNextLink(response.headers.get("link") || "");
  }

  return rows;
}
