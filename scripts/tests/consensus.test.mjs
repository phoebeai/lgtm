import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runConsensus } from "../consensus.mjs";
import { renderConsensusComment } from "../shared/consensus-renderer.mjs";
import {
  commitAll,
  createRepo,
  parseGithubOutput,
  writeRepoFile,
} from "./test-utils.mjs";

function createTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeReport(reportsDir, reviewerId, payload) {
  fs.writeFileSync(path.join(reportsDir, `${reviewerId}.json`), JSON.stringify(payload), "utf8");
}

function baseReport(overrides = {}) {
  return {
    reviewer: "security",
    run_state: "completed",
    summary: "ok",
    resolved_finding_ids: [],
    new_findings: [],
    errors: [],
    ...overrides,
  };
}

function createWorkspaceWithFileChange({
  t,
  relativePath,
  baseContents,
  headContents,
  prefix = "consensus-workspace-",
}) {
  const workspaceDir = createRepo(t, prefix);
  writeRepoFile(workspaceDir, relativePath, baseContents);
  const baseSha = commitAll(workspaceDir, "base");
  writeRepoFile(workspaceDir, relativePath, headContents);
  const headSha = commitAll(workspaceDir, "head");
  return { workspaceDir, baseSha, headSha };
}

test("renderConsensusComment includes open and resolved sections", () => {
  const comment = renderConsensusComment({
    marker: "<!-- marker -->",
    outcome: "FAIL",
    outcomeReason: "FAIL_OPEN_FINDINGS",
    openEntries: [
      {
        reviewer: "security",
        status: "open",
        finding: {
          id: "SEC001",
          title: "Critical issue",
          recommendation: "Fix now",
          file: "src/app.ts",
          line: 42,
        },
      },
    ],
    resolvedEntries: [
      {
        reviewer: "security",
        status: "resolved",
        finding: {
          id: "SEC002",
          title: "Old issue",
          recommendation: "Already fixed",
          file: "src/app.ts",
          line: 44,
        },
      },
    ],
    reviewerErrors: ["security: reviewer execution/output error"],
    labelsByReviewerId: new Map([["security", "Security"]]),
  });

  assert.match(comment, /## ❌ LGTM/);
  assert.match(comment, /1 open finding detected\./);
  assert.match(comment, /### Reviewer Errors/);
  assert.match(comment, /### Open Findings/);
  assert.match(comment, /\*\*\[SEC001\]\*\* Critical issue/);
  assert.match(comment, /### Resolved Findings/);
  assert.match(comment, /\*\*\[SEC002\]\*\* Old issue/);
  assert.doesNotMatch(comment, /Status: (open|resolved)/i);
});

test("runConsensus writes comment, ledger, and outputs for PASS_NO_FINDINGS", async (t) => {
  const tempDir = createTempDir(t, "consensus-pass-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  writeReport(reportsDir, "security", baseReport());

  const outputPath = path.join(tempDir, "github-output.txt");
  const previousGithubOutput = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = outputPath;
  t.after(() => {
    if (previousGithubOutput === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = previousGithubOutput;
    }
  });

  const commentPath = path.join(tempDir, "comment.md");
  const ledgerPath = path.join(tempDir, "ledger.json");
  const result = await runConsensus({
    runId: "100",
    sha: "abc123",
    commentPath,
    ledgerPath,
    token: "",
    repo: "",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
      },
    ]),
    publishInlineComments: "true",
    priorLedgerJson: "",
  });

  assert.equal(result.outcome, "PASS");
  assert.equal(result.outcomeReason, "PASS_NO_FINDINGS");
  assert.equal(fs.existsSync(commentPath), true);
  assert.equal(fs.existsSync(ledgerPath), true);

  const comment = fs.readFileSync(commentPath, "utf8");
  assert.match(comment, /## ✅ LGTM/);
  assert.match(comment, /No open findings\./);
  assert.match(comment, /### Open Findings/);
  assert.match(comment, /- None/);

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.deepEqual(ledger.findings, []);

  const outputs = parseGithubOutput(fs.readFileSync(outputPath, "utf8"));
  assert.equal(outputs.outcome, "PASS");
  assert.equal(outputs.outcome_reason, "PASS_NO_FINDINGS");
  assert.equal(outputs.open_findings_count, "0");
  assert.equal(outputs.reviewer_errors_count, "0");
});

test("runConsensus fails with open findings and assigns reviewer-prefixed finding IDs", async (t) => {
  const tempDir = createTempDir(t, "consensus-open-fail-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  writeReport(
    reportsDir,
    "security",
    baseReport({
      new_findings: [
        {
          title: "SQL injection",
          file: "src/db.ts",
          line: 10,
          recommendation: "Use parameterized query",
          reopen_finding_id: null,
        },
      ],
    }),
  );

  const commentPath = path.join(tempDir, "comment.md");
  const ledgerPath = path.join(tempDir, "ledger.json");
  const result = await runConsensus({
    runId: "101",
    sha: "abc123",
    commentPath,
    ledgerPath,
    token: "",
    repo: "",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
      },
    ]),
    publishInlineComments: "true",
    priorLedgerJson: "",
  });

  assert.equal(result.outcome, "FAIL");
  assert.equal(result.outcomeReason, "FAIL_OPEN_FINDINGS");
  assert.equal(result.openFindingsCount, 1);

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(ledger.findings.length, 1);
  assert.equal(ledger.findings[0].id, "SEC001");
  assert.equal(ledger.findings[0].status, "open");

  const comment = fs.readFileSync(commentPath, "utf8");
  assert.match(comment, /\*\*\[SEC001\]\*\* SQL injection/);
});

test("runConsensus resolves prior open findings and keeps history in resolved section", async (t) => {
  const tempDir = createTempDir(t, "consensus-resolved-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const { workspaceDir, baseSha, headSha } = createWorkspaceWithFileChange({
    t,
    relativePath: "src/a.ts",
    baseContents: "export const value = 1;\n",
    headContents: "export const value = 2;\n",
    prefix: "consensus-resolved-workspace-",
  });

  writeReport(
    reportsDir,
    "security",
    baseReport({
      resolved_finding_ids: ["SEC001"],
      new_findings: [],
    }),
  );

  const priorLedgerPath = path.join(tempDir, "prior-ledger.json");
  fs.writeFileSync(
    priorLedgerPath,
    `${JSON.stringify(
      {
        version: 1,
        findings: [
          {
            id: "SEC001",
            reviewer: "security",
            status: "open",
            title: "Existing blocker",
            recommendation: "Fix it",
            file: "src/a.ts",
            line: 12,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const commentPath = path.join(tempDir, "comment.md");
  const ledgerPath = path.join(tempDir, "ledger.json");
  const result = await runConsensus({
    runId: "102",
    baseSha,
    sha: headSha,
    workspaceDir,
    commentPath,
    ledgerPath,
    token: "",
    repo: "",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
      },
    ]),
    publishInlineComments: "true",
    priorLedgerJson: priorLedgerPath,
  });

  assert.equal(result.outcome, "PASS");
  assert.equal(result.outcomeReason, "PASS_NO_FINDINGS");

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(ledger.findings.length, 1);
  assert.equal(ledger.findings[0].id, "SEC001");
  assert.equal(ledger.findings[0].status, "resolved");

  const comment = fs.readFileSync(commentPath, "utf8");
  assert.match(comment, /### Resolved Findings/);
  assert.match(comment, /\*\*\[SEC001\]\*\* Existing blocker/);
});

test("runConsensus reopens resolved findings with reopen_finding_id using same finding id", async (t) => {
  const tempDir = createTempDir(t, "consensus-reopen-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  writeReport(
    reportsDir,
    "security",
    baseReport({
      new_findings: [
        {
          title: "Existing blocker (reopened)",
          file: "src/a.ts",
          line: 12,
          recommendation: "Fix it again",
          reopen_finding_id: "SEC003",
        },
      ],
    }),
  );

  const priorLedgerPath = path.join(tempDir, "prior-ledger.json");
  fs.writeFileSync(
    priorLedgerPath,
    `${JSON.stringify(
      {
        version: 1,
        findings: [
          {
            id: "SEC003",
            reviewer: "security",
            status: "resolved",
            title: "Existing blocker",
            recommendation: "Fix it",
            file: "src/a.ts",
            line: 12,
            inline_thread_id: "thread-123",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const commentPath = path.join(tempDir, "comment.md");
  const ledgerPath = path.join(tempDir, "ledger.json");
  const result = await runConsensus({
    runId: "103",
    sha: "abc123",
    commentPath,
    ledgerPath,
    token: "",
    repo: "",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
      },
    ]),
    publishInlineComments: "true",
    priorLedgerJson: priorLedgerPath,
  });

  assert.equal(result.outcome, "FAIL");
  assert.equal(result.outcomeReason, "FAIL_OPEN_FINDINGS");

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(ledger.findings.length, 1);
  assert.equal(ledger.findings[0].id, "SEC003");
  assert.equal(ledger.findings[0].status, "open");
  assert.equal(ledger.findings[0].title, "Existing blocker (reopened)");
});

test("runConsensus does not use review approvals for bypass and fails on reviewer errors", async (t) => {
  const tempDir = createTempDir(t, "consensus-no-bypass-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  writeReport(
    reportsDir,
    "security",
    {
      reviewer: "security",
      run_state: "error",
      summary: "boom",
      resolved_finding_ids: [],
      new_findings: [],
      errors: ["timeout"],
    },
  );
  writeReport(
    reportsDir,
    "test_quality",
    {
      reviewer: "test_quality",
      run_state: "completed",
      summary: "needs work",
      resolved_finding_ids: [],
      new_findings: [
        {
          title: "Missing tests",
          file: "src/test.js",
          line: 5,
          recommendation: "Add tests",
          reopen_finding_id: null,
        },
      ],
      errors: [],
    },
  );

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    throw new Error(`Unexpected request ${method} ${String(url)}`);
  };

  const result = await runConsensus({
    runId: "104",
    sha: "abc123",
    commentPath: path.join(tempDir, "comment.md"),
    ledgerPath: path.join(tempDir, "ledger.json"),
    token: "token",
    repo: "owner/repo",
    prNumber: "7",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
      },
      {
        id: "test_quality",
        display_name: "Test Quality",
      },
    ]),
    publishInlineComments: "false",
    priorLedgerJson: "",
  });

  assert.equal(result.outcome, "FAIL");
  assert.equal(result.outcomeReason, "FAIL_REVIEWER_ERRORS");
});

test("runConsensus updates existing inline comments for resolved/reopened findings and avoids duplicate reopen comments", async (t) => {
  const tempDir = createTempDir(t, "consensus-inline-lifecycle-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const { workspaceDir, baseSha, headSha } = createWorkspaceWithFileChange({
    t,
    relativePath: "src/old.ts",
    baseContents: "export const oldValue = 1;\n",
    headContents: "export const oldValue = 2;\n",
    prefix: "consensus-inline-lifecycle-workspace-",
  });

  writeReport(
    reportsDir,
    "security",
    baseReport({
      resolved_finding_ids: ["SEC001"],
      new_findings: [
        {
          title: "Reopened issue",
          file: "src/reopen.ts",
          line: 22,
          recommendation: "Re-fix",
          reopen_finding_id: "SEC002",
        },
        {
          title: "New issue",
          file: "src/new.ts",
          line: 9,
          recommendation: "Fix new issue",
          reopen_finding_id: null,
        },
      ],
    }),
  );

  const priorLedgerPath = path.join(tempDir, "prior-ledger.json");
  fs.writeFileSync(
    priorLedgerPath,
    `${JSON.stringify(
      {
        version: 1,
        findings: [
          {
            id: "SEC001",
            reviewer: "security",
            status: "open",
            title: "Old open issue",
            recommendation: "Fix old issue",
            file: "src/old.ts",
            line: 3,
            inline_comment_id: 401,
            inline_thread_id: "thread-resolve",
          },
          {
            id: "SEC002",
            reviewer: "security",
            status: "resolved",
            title: "Previously resolved issue",
            recommendation: "Keep fixed",
            file: "src/reopen.ts",
            line: 22,
            inline_comment_id: 402,
            inline_thread_id: "thread-reopen",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const postedInlineBodies = [];
  const patchedInlineComments = [];
  const threadMutations = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const target = String(url);

    if (method === "POST" && /\/pulls\/8\/comments$/.test(target)) {
      const body = JSON.parse(String(options.body || "{}"));
      postedInlineBodies.push(body);
      return new Response(
        JSON.stringify({
          id: 501,
          html_url: "https://github.com/owner/repo/pull/8#discussion_r501",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (method === "PATCH" && /\/pulls\/comments\/(401|402)$/.test(target)) {
      const body = JSON.parse(String(options.body || "{}"));
      const commentId = Number(target.match(/\/pulls\/comments\/(\d+)$/)?.[1] || "0");
      patchedInlineComments.push({
        commentId,
        body: String(body?.body || ""),
      });
      return new Response(
        JSON.stringify({
          id: commentId,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (method === "POST" && target === "https://api.github.com/graphql") {
      const payload = JSON.parse(String(options.body || "{}"));
      const query = String(payload.query || "");
      const threadId = String(payload?.variables?.threadId || "");

      if (query.includes("PullRequestReviewThreads")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [],
                  },
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (query.includes("ResolveReviewThread")) {
        threadMutations.push({ action: "resolve", threadId });
        return new Response(
          JSON.stringify({
            data: {
              resolveReviewThread: {
                thread: {
                  id: threadId,
                  isResolved: true,
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (query.includes("UnresolveReviewThread")) {
        threadMutations.push({ action: "unresolve", threadId });
        return new Response(
          JSON.stringify({
            data: {
              unresolveReviewThread: {
                thread: {
                  id: threadId,
                  isResolved: false,
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
    }

    if (method === "GET" && /\/pulls\/8$/.test(target)) {
      return new Response(
        JSON.stringify({
          number: 8,
          user: { login: "author" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (method === "GET" && /\/pulls\/8\/reviews\?/.test(target)) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected request ${method} ${target}`);
  };

  const commentPath = path.join(tempDir, "comment.md");
  const ledgerPath = path.join(tempDir, "ledger.json");
  const result = await runConsensus({
    runId: "105",
    baseSha,
    sha: headSha,
    workspaceDir,
    commentPath,
    ledgerPath,
    token: "token",
    repo: "owner/repo",
    prNumber: "8",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
      },
    ]),
    publishInlineComments: "true",
    priorLedgerJson: priorLedgerPath,
  });

  assert.equal(result.outcome, "FAIL");
  assert.equal(result.outcomeReason, "FAIL_OPEN_FINDINGS");
  assert.equal(postedInlineBodies.length, 1);
  assert.equal(postedInlineBodies[0].path, "src/new.ts");
  assert.equal(postedInlineBodies[0].line, 9);
  assert.equal(patchedInlineComments.length, 2);
  assert.deepEqual(
    patchedInlineComments.map((entry) => entry.commentId).sort((left, right) => left - right),
    [401, 402],
  );
  const resolvedPatch = patchedInlineComments.find((entry) => entry.commentId === 401);
  const reopenedPatch = patchedInlineComments.find((entry) => entry.commentId === 402);
  assert.match(
    resolvedPatch.body,
    new RegExp(`Status: Resolved in ${headSha.slice(0, 7)}\\.`),
  );
  assert.doesNotMatch(reopenedPatch.body, /Status: Resolved in latest run\./);
  assert.deepEqual(threadMutations, [
    {
      action: "resolve",
      threadId: "thread-resolve",
    },
    {
      action: "unresolve",
      threadId: "thread-reopen",
    },
  ]);

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  const sec1 = ledger.findings.find((finding) => finding.id === "SEC001");
  const sec2 = ledger.findings.find((finding) => finding.id === "SEC002");
  const sec3 = ledger.findings.find((finding) => finding.id === "SEC003");
  assert.equal(sec1.status, "resolved");
  assert.equal(sec1.inline_comment_id, 401);
  assert.equal(sec1.inline_thread_id, "thread-resolve");
  assert.equal(sec2.status, "open");
  assert.equal(sec2.inline_comment_id, 402);
  assert.equal(sec2.inline_thread_id, "thread-reopen");
  assert.equal(sec3.status, "open");
  assert.equal(sec3.inline_comment_id, 501);
});

test("runConsensus tolerates non-fatal inline comment update API errors", async (t) => {
  const tempDir = createTempDir(t, "consensus-non-fatal-comment-update-errors-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const { workspaceDir, baseSha, headSha } = createWorkspaceWithFileChange({
    t,
    relativePath: "src/old.ts",
    baseContents: "export const oldValue = 1;\n",
    headContents: "export const oldValue = 2;\n",
    prefix: "consensus-non-fatal-workspace-",
  });

  writeReport(
    reportsDir,
    "security",
    baseReport({
      resolved_finding_ids: ["SEC001"],
      new_findings: [],
    }),
  );

  const priorLedgerPath = path.join(tempDir, "prior-ledger.json");
  fs.writeFileSync(
    priorLedgerPath,
    `${JSON.stringify(
      {
        version: 1,
        findings: [
          {
            id: "SEC001",
            reviewer: "security",
            status: "open",
            title: "Old open issue",
            recommendation: "Fix old issue",
            file: "src/old.ts",
            line: 3,
            inline_comment_id: 777,
            inline_thread_id: "thread-resolve",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const target = String(url);

    if (method === "PATCH" && /\/pulls\/comments\/777$/.test(target)) {
      return new Response(
        JSON.stringify({ message: "Resource not accessible by integration" }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (method === "POST" && target === "https://api.github.com/graphql") {
      return new Response(
        JSON.stringify({
          errors: [
            {
              message: "Resource not accessible by integration",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (method === "GET" && /\/pulls\/9$/.test(target)) {
      return new Response(
        JSON.stringify({
          number: 9,
          user: { login: "author" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (method === "GET" && /\/pulls\/9\/reviews\?/.test(target)) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected request ${method} ${target}`);
  };

  const result = await runConsensus({
    runId: "106",
    baseSha,
    sha: headSha,
    workspaceDir,
    commentPath: path.join(tempDir, "comment.md"),
    ledgerPath: path.join(tempDir, "ledger.json"),
    token: "token",
    repo: "owner/repo",
    prNumber: "9",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
      },
    ]),
    publishInlineComments: "true",
    priorLedgerJson: priorLedgerPath,
  });

  assert.equal(result.outcome, "PASS");
  assert.equal(result.outcomeReason, "PASS_NO_FINDINGS");
  assert.equal(result.reviewerErrorsCount, 0);
  assert.equal(result.openFindingsCount, 0);

  const ledger = JSON.parse(fs.readFileSync(path.join(tempDir, "ledger.json"), "utf8"));
  const sec1 = ledger.findings.find((finding) => finding.id === "SEC001");
  assert.equal(sec1.status, "resolved");
  assert.equal(sec1.inline_comment_id, 777);
});

test("runConsensus fails when PRIOR_LEDGER_JSON is malformed", async (t) => {
  const tempDir = createTempDir(t, "consensus-invalid-prior-ledger-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  writeReport(reportsDir, "security", baseReport());

  const priorLedgerPath = path.join(tempDir, "prior-ledger.json");
  fs.writeFileSync(priorLedgerPath, "{bad-json", "utf8");

  await assert.rejects(
    runConsensus({
      runId: "900",
      sha: "abc123",
      commentPath: path.join(tempDir, "comment.md"),
      ledgerPath: path.join(tempDir, "ledger.json"),
      token: "",
      repo: "",
      marker: "<!-- marker -->",
      reportsDir,
      reviewersJson: JSON.stringify([
        {
          id: "security",
          display_name: "Security",
        },
      ]),
      publishInlineComments: "true",
      priorLedgerJson: priorLedgerPath,
    }),
    /Invalid PRIOR_LEDGER_JSON/,
  );
});

test("runConsensus trusts reviewer resolved_finding_ids for lifecycle transitions", async (t) => {
  const tempDir = createTempDir(t, "consensus-reviewer-resolution-default-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  writeReport(
    reportsDir,
    "security",
    baseReport({
      resolved_finding_ids: ["SEC001"],
      new_findings: [],
    }),
  );

  const priorLedgerPath = path.join(tempDir, "prior-ledger.json");
  fs.writeFileSync(
    priorLedgerPath,
    `${JSON.stringify(
      {
        version: 1,
        findings: [
          {
            id: "SEC001",
            reviewer: "security",
            status: "open",
            title: "Existing blocker",
            recommendation: "Fix it",
            file: "src/a.ts",
            line: 1,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const result = await runConsensus({
    runId: "901",
    baseSha: "",
    sha: "abc123",
    workspaceDir: tempDir,
    commentPath: path.join(tempDir, "comment.md"),
    ledgerPath: path.join(tempDir, "ledger.json"),
    token: "",
    repo: "",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
      },
    ]),
    publishInlineComments: "false",
    priorLedgerJson: priorLedgerPath,
  });

  assert.equal(result.outcome, "PASS");
  assert.equal(result.outcomeReason, "PASS_NO_FINDINGS");
  const ledger = JSON.parse(fs.readFileSync(path.join(tempDir, "ledger.json"), "utf8"));
  assert.equal(ledger.findings[0].status, "resolved");
});

test("runConsensus backfills thread ids across paginated review threads and resolves lifecycle", async (t) => {
  const tempDir = createTempDir(t, "consensus-thread-backfill-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const { workspaceDir, baseSha, headSha } = createWorkspaceWithFileChange({
    t,
    relativePath: "src/old.ts",
    baseContents: "export const oldValue = 1;\n",
    headContents: "export const oldValue = 2;\n",
    prefix: "consensus-thread-backfill-workspace-",
  });

  writeReport(
    reportsDir,
    "security",
    baseReport({
      resolved_finding_ids: ["SEC001"],
      new_findings: [],
    }),
  );

  const priorLedgerPath = path.join(tempDir, "prior-ledger.json");
  fs.writeFileSync(
    priorLedgerPath,
    `${JSON.stringify(
      {
        version: 1,
        findings: [
          {
            id: "SEC001",
            reviewer: "security",
            status: "open",
            title: "Old open issue",
            recommendation: "Fix old issue",
            file: "src/old.ts",
            line: 3,
            inline_comment_id: 901,
            inline_thread_id: "",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const patchedInlineComments = [];
  const threadMutations = [];
  let reviewThreadQueryCalls = 0;
  const reviewThreadCursorsSeen = new Set();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const target = String(url);

    if (method === "PATCH" && /\/pulls\/comments\/901$/.test(target)) {
      const body = JSON.parse(String(options.body || "{}"));
      patchedInlineComments.push(String(body?.body || ""));
      return new Response(
        JSON.stringify({
          id: 901,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (method === "POST" && target === "https://api.github.com/graphql") {
      const payload = JSON.parse(String(options.body || "{}"));
      const query = String(payload.query || "");
      const threadId = String(payload?.variables?.threadId || "");

      if (query.includes("PullRequestReviewThreads")) {
        reviewThreadQueryCalls += 1;
        const cursor = payload?.variables?.cursor ?? null;
        reviewThreadCursorsSeen.add(cursor);
        if (cursor === null) {
          return new Response(
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                      nodes: [
                        {
                          id: "thread-unrelated",
                          isResolved: false,
                          comments: {
                            nodes: [{ databaseId: 999 }],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        assert.equal(cursor, "cursor-1");
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "thread-901",
                        isResolved: false,
                        comments: {
                          nodes: [{ databaseId: 901 }],
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (query.includes("ResolveReviewThread")) {
        threadMutations.push({ action: "resolve", threadId });
        return new Response(
          JSON.stringify({
            data: {
              resolveReviewThread: {
                thread: {
                  id: threadId,
                  isResolved: true,
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
    }

    throw new Error(`Unexpected request ${method} ${target}`);
  };

  const result = await runConsensus({
    runId: "902",
    baseSha,
    sha: headSha,
    workspaceDir,
    commentPath: path.join(tempDir, "comment.md"),
    ledgerPath: path.join(tempDir, "ledger.json"),
    token: "token",
    repo: "owner/repo",
    prNumber: "12",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
      },
    ]),
    publishInlineComments: "true",
    priorLedgerJson: priorLedgerPath,
  });

  assert.equal(result.outcome, "PASS");
  assert.equal(result.outcomeReason, "PASS_NO_FINDINGS");
  assert.ok(reviewThreadQueryCalls >= 2);
  assert.equal(reviewThreadCursorsSeen.has(null), true);
  assert.equal(reviewThreadCursorsSeen.has("cursor-1"), true);
  assert.equal(patchedInlineComments.length, 1);
  assert.match(
    patchedInlineComments[0],
    new RegExp(`Status: Resolved in ${headSha.slice(0, 7)}\\.`),
  );
  assert.deepEqual(threadMutations, [
    {
      action: "resolve",
      threadId: "thread-901",
    },
  ]);

  const ledger = JSON.parse(fs.readFileSync(path.join(tempDir, "ledger.json"), "utf8"));
  assert.equal(ledger.findings[0].inline_thread_id, "thread-901");
  assert.equal(ledger.findings[0].status, "resolved");
});

test("runConsensus reconciles existing resolved findings when thread state is stale", async (t) => {
  const tempDir = createTempDir(t, "consensus-thread-reconcile-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  writeReport(reportsDir, "security", baseReport());

  const priorLedgerPath = path.join(tempDir, "prior-ledger.json");
  fs.writeFileSync(
    priorLedgerPath,
    `${JSON.stringify(
      {
        version: 1,
        findings: [
          {
            id: "SEC001",
            reviewer: "security",
            status: "resolved",
            title: "Historical resolved issue",
            recommendation: "Keep fixed",
            file: "src/old.ts",
            line: 3,
            inline_comment_id: 933,
            inline_thread_id: "thread-933",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const threadMutations = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const target = String(url);

    if (method === "PATCH" && /\/pulls\/comments\/933$/.test(target)) {
      throw new Error("Unexpected inline comment update for stale-thread reconciliation");
    }

    if (method === "POST" && target === "https://api.github.com/graphql") {
      const payload = JSON.parse(String(options.body || "{}"));
      const query = String(payload.query || "");
      const threadId = String(payload?.variables?.threadId || "");

      if (query.includes("PullRequestReviewThreads")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "thread-933",
                        isResolved: false,
                        comments: {
                          nodes: [{ databaseId: 933 }],
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (query.includes("ResolveReviewThread")) {
        threadMutations.push({ action: "resolve", threadId });
        return new Response(
          JSON.stringify({
            data: {
              resolveReviewThread: {
                thread: {
                  id: threadId,
                  isResolved: true,
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
    }

    throw new Error(`Unexpected request ${method} ${target}`);
  };

  const result = await runConsensus({
    runId: "903",
    sha: "deadbeef",
    commentPath: path.join(tempDir, "comment.md"),
    ledgerPath: path.join(tempDir, "ledger.json"),
    token: "token",
    repo: "owner/repo",
    prNumber: "13",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
      },
    ]),
    publishInlineComments: "true",
    priorLedgerJson: priorLedgerPath,
  });

  assert.equal(result.outcome, "PASS");
  assert.equal(result.outcomeReason, "PASS_NO_FINDINGS");
  assert.deepEqual(threadMutations, [
    {
      action: "resolve",
      threadId: "thread-933",
    },
  ]);

  const ledger = JSON.parse(fs.readFileSync(path.join(tempDir, "ledger.json"), "utf8"));
  assert.equal(ledger.findings[0].status, "resolved");
  assert.equal(ledger.findings[0].inline_thread_id, "thread-933");
});
