import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInlineCommentBody,
  isLineBoundFinding,
  publishInlineFindingComments,
} from "../shared/inline-review-comments.mjs";

function makeEntry({
  reviewer = "security",
  title = "Issue",
  file = "src/app.ts",
  line = 12,
  recommendation = "Fix this",
  blocking = true,
} = {}) {
  return {
    reviewer,
    finding: {
      title,
      file,
      line,
      recommendation,
      blocking,
    },
  };
}

test("isLineBoundFinding validates file+line shape", () => {
  assert.equal(isLineBoundFinding({ file: "src/app.ts", line: 1 }), true);
  assert.equal(isLineBoundFinding({ file: "src/app.ts", line: 0 }), false);
  assert.equal(isLineBoundFinding({ file: "", line: 1 }), false);
  assert.equal(isLineBoundFinding({ file: "src/app.ts", line: null }), false);
});

test("publishInlineFindingComments posts all line-bound findings", async (t) => {
  const first = makeEntry({ title: "Existing finding", line: 12 });
  const second = makeEntry({ title: "New finding", line: 30 });

  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url: String(url), method, body: options.body });

    if (method === "POST" && /\/pulls\/7\/comments$/.test(String(url))) {
      return new Response(JSON.stringify({ id: 202 }), {
        status: 201,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const result = await publishInlineFindingComments({
    token: "token",
    repo: "owner/repo",
    prNumber: "7",
    headSha: "abc123",
    entries: [first, second],
    labelsByReviewerId: new Map([["security", "Security"]]),
    actor: "github-actions[bot]",
  });

  assert.equal(result.attemptedCount, 2);
  assert.equal(result.postedCount, 2);
  assert.equal(result.failedCount, 0);

  const postCalls = calls.filter((call) => call.method === "POST");
  assert.equal(postCalls.length, 2);

  const firstPayload = JSON.parse(postCalls[0].body);
  assert.equal(firstPayload.commit_id, "abc123");
  assert.equal(firstPayload.path, "src/app.ts");
  assert.equal(firstPayload.line, 12);
  assert.equal(firstPayload.side, "RIGHT");
  assert.match(firstPayload.body, /\*\*Security \(blocking\):\*\* Existing finding/);
  assert.match(firstPayload.body, /<!-- codex-inline-finding sig=[a-f0-9]{64} -->/);

  const secondPayload = JSON.parse(postCalls[1].body);
  assert.equal(secondPayload.commit_id, "abc123");
  assert.equal(secondPayload.path, "src/app.ts");
  assert.equal(secondPayload.line, 30);
  assert.equal(secondPayload.side, "RIGHT");
  assert.match(secondPayload.body, /\*\*Security \(blocking\):\*\* New finding/);
  assert.match(secondPayload.body, /\n\nFix this/);
  assert.match(secondPayload.body, /<!-- codex-inline-finding sig=[a-f0-9]{64} -->/);
});

test("publishInlineFindingComments reports posting failures without throwing", async (t) => {
  const entry = makeEntry({ title: "Fails to post" });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    if (method !== "POST") throw new Error(`Unexpected request ${method} ${url}`);
    return new Response("line is not part of the diff", {
      status: 422,
      headers: {
        "content-type": "text/plain",
      },
    });
  };

  const result = await publishInlineFindingComments({
    token: "token",
    repo: "owner/repo",
    prNumber: "7",
    headSha: "abc123",
    entries: [entry],
    labelsByReviewerId: new Map([["security", "Security"]]),
    actor: "github-actions[bot]",
  });

  assert.equal(result.attemptedCount, 1);
  assert.equal(result.postedCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(result.failedEntries[0].reviewer, "security");
  assert.match(result.failedEntries[0].error, /failed \(422\)/);
});
