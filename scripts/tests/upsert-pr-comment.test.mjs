import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { upsertPrComment } from "../upsert-pr-comment.mjs";

function createTempCommentFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lgtm-comment-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const filePath = path.join(dir, "comment.md");
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("upsertPrComment paginates comment list and updates existing bot comment", async (t) => {
  const commentPath = createTempCommentFile(t, "<!-- codex-lgtm -->\nupdated body");
  const originalFetch = globalThis.fetch;
  const calls = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url, method, body: options.body });

    if (method === "GET" && /[?&]page=1(?:&|$)/.test(String(url))) {
      return new Response(JSON.stringify([{ id: 1, body: "plain", user: { login: "octocat" } }]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          link: '<https://api.github.com/repos/owner/repo/issues/7/comments?per_page=100&page=2>; rel="next"',
        },
      });
    }

    if (method === "GET" && /[?&]page=2(?:&|$)/.test(String(url))) {
      return new Response(JSON.stringify([
        {
          id: 999,
          body: "<!-- codex-lgtm --> old body",
          user: { login: "github-actions[bot]" },
        },
      ]), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    if (method === "PATCH") {
      return new Response(JSON.stringify({ id: 999 }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    throw new Error(`Unexpected request ${method} ${url}`);
  };

  const result = await upsertPrComment({
    token: "token",
    repo: "owner/repo",
    prNumber: "7",
    commentPath,
    actor: "github-actions[bot]",
  });

  assert.deepEqual(result, {
    action: "updated",
    commentId: 999,
  });

  assert.equal(calls[0].method, "GET");
  assert.match(String(calls[0].url), /page=1/);
  assert.equal(calls[1].method, "GET");
  assert.match(String(calls[1].url), /page=2/);
  assert.equal(calls[2].method, "PATCH");
  assert.equal(calls[2].url, "https://api.github.com/repos/owner/repo/issues/comments/999");

  const patchBody = JSON.parse(calls[2].body);
  assert.equal(patchBody.body, "<!-- codex-lgtm -->\nupdated body");
});

test("upsertPrComment creates a new comment when no matching marker exists", async (t) => {
  const commentPath = createTempCommentFile(t, "<!-- codex-lgtm -->\nnew body");
  const originalFetch = globalThis.fetch;
  const calls = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url, method, body: options.body });

    if (method === "GET") {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    if (method === "POST") {
      return new Response(JSON.stringify({ id: 321 }), {
        status: 201,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    throw new Error(`Unexpected request ${method} ${url}`);
  };

  const result = await upsertPrComment({
    token: "token",
    repo: "owner/repo",
    prNumber: "7",
    commentPath,
    actor: "github-actions[bot]",
  });

  assert.deepEqual(result, {
    action: "created",
    commentId: 321,
  });

  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url, "https://api.github.com/repos/owner/repo/issues/7/comments");
});

test("upsertPrComment ignores legacy markers and creates a new LGTM marker comment", async (t) => {
  const commentPath = createTempCommentFile(t, "<!-- codex-lgtm -->\nnew body");
  const originalFetch = globalThis.fetch;
  const calls = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url, method, body: options.body });

    if (method === "GET") {
      return new Response(JSON.stringify([
        {
          id: 222,
          body: "<!-- codex-counsel -->\nlegacy body",
          user: { login: "github-actions[bot]" },
        },
      ]), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    if (method === "POST") {
      return new Response(JSON.stringify({ id: 333 }), {
        status: 201,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    throw new Error(`Unexpected request ${method} ${url}`);
  };

  const result = await upsertPrComment({
    token: "token",
    repo: "owner/repo",
    prNumber: "7",
    commentPath,
    actor: "github-actions[bot]",
  });

  assert.deepEqual(result, {
    action: "created",
    commentId: 333,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "POST");
});
