import test from "node:test";
import assert from "node:assert/strict";
import {
  collectPriorFindingMemory,
  fetchThreadResolutionByCommentId,
  renderPriorFindingsMarkdown,
} from "../collect-pr-finding-memory.mjs";
import { buildInlineFindingMarker } from "../shared/finding-comment-marker.mjs";

test("fetchThreadResolutionByCommentId paginates review threads and maps comment resolution", async () => {
  const calls = [];
  const resolution = await fetchThreadResolutionByCommentId({
    token: "token",
    owner: "owner",
    name: "repo",
    pullNumber: 13,
    graphqlRequest: async ({ variables }) => {
      calls.push(variables.cursor || null);
      if (!variables.cursor) {
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
                nodes: [
                  {
                    isResolved: false,
                    comments: { nodes: [{ databaseId: 11 }] },
                  },
                ],
              },
            },
          },
        };
      }
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  isResolved: true,
                  comments: { nodes: [{ databaseId: 22 }] },
                },
              ],
            },
          },
        },
      };
    },
  });

  assert.deepEqual(calls, [null, "cursor-2"]);
  assert.equal(resolution.get(11), false);
  assert.equal(resolution.get(22), true);
});

test("collectPriorFindingMemory returns normalized finding-memory entries", async () => {
  const baseFindingBody = "**Security (blocking):** Existing issue\n\nFix now";
  const findingMarker = buildInlineFindingMarker({
    body: baseFindingBody,
    secret: "token",
  });
  const signedFindingBody = `${baseFindingBody}\n\n${findingMarker}`;

  const entries = await collectPriorFindingMemory({
    token: "token",
    repository: "owner/repo",
    prNumber: "13",
    requestAllPages: async () => [
      {
        id: 101,
        path: "src/app.ts",
        line: 9,
        body: signedFindingBody,
        user: { login: "github-actions[bot]" },
        created_at: "2026-02-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
        html_url: "https://example.com/comment/101",
      },
      {
        id: 102,
        path: "src/app.ts",
        line: 10,
        body: signedFindingBody,
        user: { login: "octocat" },
      },
      {
        id: 103,
        path: "src/app.ts",
        line: 11,
        body: "non-finding note",
      },
    ],
    graphqlRequest: async () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                isResolved: true,
                comments: {
                  nodes: [{ databaseId: 101 }],
                },
              },
            ],
          },
        },
      },
    }),
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 101);
  assert.equal(entries[0].path, "src/app.ts");
  assert.equal(entries[0].line, 9);
  assert.equal(entries[0].resolved, true);
  assert.equal(entries[0].author, "github-actions[bot]");
  assert.equal(entries[0].url, "https://example.com/comment/101");
  assert.match(entries[0].body, /Existing issue/);
});

test("renderPriorFindingsMarkdown formats entries for audit/debug", () => {
  const markdown = renderPriorFindingsMarkdown([
    {
      path: "src/app.ts",
      line: 9,
      resolved: false,
      author: "github-actions[bot]",
      url: "https://example.com/comment/101",
      body: "**Security (blocking):** Existing issue\n\nFix now",
    },
  ]);

  assert.match(markdown, /# Prior Finding Memory/);
  assert.match(markdown, /Total findings: 1/);
  assert.match(markdown, /## src\/app.ts:9/);
  assert.match(markdown, /Resolved: unresolved/);
  assert.match(markdown, /Existing issue/);
});
