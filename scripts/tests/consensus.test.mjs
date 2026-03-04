import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runConsensus } from "../consensus.mjs";
import { renderConsensusComment } from "../shared/consensus-renderer.mjs";
import { parseGithubOutput } from "./test-utils.mjs";

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
          id: "SEC-1",
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
          id: "SEC-2",
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
  assert.match(comment, /\*\*Security \[SEC-1\]:\*\* Critical issue/);
  assert.match(comment, /### Resolved Findings/);
  assert.match(comment, /\*\*Security \[SEC-2\]:\*\* Old issue/);
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
  assert.equal(ledger.findings[0].id, "SEC-1");
  assert.equal(ledger.findings[0].status, "open");

  const comment = fs.readFileSync(commentPath, "utf8");
  assert.match(comment, /\*\*Security \[SEC-1\]:\*\* SQL injection/);
});

test("runConsensus resolves prior open findings and keeps history in resolved section", async (t) => {
  const tempDir = createTempDir(t, "consensus-resolved-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  writeReport(
    reportsDir,
    "security",
    baseReport({
      resolved_finding_ids: ["SEC-1"],
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
            id: "SEC-1",
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

  assert.equal(result.outcome, "PASS");
  assert.equal(result.outcomeReason, "PASS_NO_FINDINGS");

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(ledger.findings.length, 1);
  assert.equal(ledger.findings[0].id, "SEC-1");
  assert.equal(ledger.findings[0].status, "resolved");

  const comment = fs.readFileSync(commentPath, "utf8");
  assert.match(comment, /### Resolved Findings/);
  assert.match(comment, /\*\*Security \[SEC-1\]:\*\* Existing blocker/);
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
          reopen_finding_id: "SEC-3",
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
            id: "SEC-3",
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
  assert.equal(ledger.findings[0].id, "SEC-3");
  assert.equal(ledger.findings[0].status, "open");
  assert.equal(ledger.findings[0].title, "Existing blocker (reopened)");
});

test("runConsensus returns PASS_HUMAN_BYPASS when non-bot approval exists on head sha", async (t) => {
  const tempDir = createTempDir(t, "consensus-human-bypass-");
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
    const target = String(url);

    if (method === "GET" && /\/pulls\/7$/.test(target)) {
      return new Response(
        JSON.stringify({
          number: 7,
          user: { login: "alice" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (method === "GET" && /\/pulls\/7\/reviews\?/.test(target)) {
      return new Response(
        JSON.stringify([
          {
            id: 1,
            state: "APPROVED",
            commit_id: "oldsha",
            submitted_at: "2026-01-01T00:00:00Z",
            author_association: "OWNER",
            user: { login: "alice", type: "User" },
          },
          {
            id: 2,
            state: "APPROVED",
            commit_id: "abc123",
            submitted_at: "2026-01-02T00:00:00Z",
            author_association: "MEMBER",
            user: { login: "bob", type: "User" },
          },
          {
            id: 3,
            state: "APPROVED",
            commit_id: "abc123",
            submitted_at: "2026-01-03T00:00:00Z",
            author_association: "MEMBER",
            user: { login: "github-actions[bot]", type: "Bot" },
          },
          {
            id: 4,
            state: "DISMISSED",
            commit_id: "abc123",
            submitted_at: "2026-01-04T00:00:00Z",
            author_association: "MEMBER",
            user: { login: "carol", type: "User" },
          },
          {
            id: 5,
            state: "APPROVED",
            commit_id: "abc123",
            submitted_at: "2026-01-05T00:00:00Z",
            author_association: "CONTRIBUTOR",
            user: { login: "dave", type: "User" },
          },
          {
            id: 6,
            state: "APPROVED",
            commit_id: "abc123",
            submitted_at: "2026-01-06T00:00:00Z",
            author_association: "OWNER",
            user: { login: "alice", type: "User" },
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    throw new Error(`Unexpected request ${method} ${target}`);
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

  assert.equal(result.outcome, "PASS");
  assert.equal(result.outcomeReason, "PASS_HUMAN_BYPASS");
  assert.equal(result.humanBypass.approved, true);
  assert.deepEqual(result.humanBypass.approvers, ["bob"]);
});

test("runConsensus updates existing inline comments for resolved/reopened findings and avoids duplicate reopen comments", async (t) => {
  const tempDir = createTempDir(t, "consensus-inline-lifecycle-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  writeReport(
    reportsDir,
    "security",
    baseReport({
      resolved_finding_ids: ["SEC-1"],
      new_findings: [
        {
          title: "Reopened issue",
          file: "src/reopen.ts",
          line: 22,
          recommendation: "Re-fix",
          reopen_finding_id: "SEC-2",
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
            id: "SEC-1",
            reviewer: "security",
            status: "open",
            title: "Old open issue",
            recommendation: "Fix old issue",
            file: "src/old.ts",
            line: 3,
            inline_comment_id: 401,
          },
          {
            id: "SEC-2",
            reviewer: "security",
            status: "resolved",
            title: "Previously resolved issue",
            recommendation: "Keep fixed",
            file: "src/reopen.ts",
            line: 22,
            inline_comment_id: 402,
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
    sha: "abc999",
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
  assert.match(resolvedPatch.body, /Status: Resolved in latest run\./);
  assert.doesNotMatch(reopenedPatch.body, /Status: Resolved in latest run\./);

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  const sec1 = ledger.findings.find((finding) => finding.id === "SEC-1");
  const sec2 = ledger.findings.find((finding) => finding.id === "SEC-2");
  const sec3 = ledger.findings.find((finding) => finding.id === "SEC-3");
  assert.equal(sec1.status, "resolved");
  assert.equal(sec1.inline_comment_id, 401);
  assert.equal(sec2.status, "open");
  assert.equal(sec2.inline_comment_id, 402);
  assert.equal(sec3.status, "open");
  assert.equal(sec3.inline_comment_id, 501);
});

test("runConsensus tolerates non-fatal inline comment update API errors", async (t) => {
  const tempDir = createTempDir(t, "consensus-non-fatal-comment-update-errors-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  writeReport(
    reportsDir,
    "security",
    baseReport({
      resolved_finding_ids: ["SEC-1"],
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
            id: "SEC-1",
            reviewer: "security",
            status: "open",
            title: "Old open issue",
            recommendation: "Fix old issue",
            file: "src/old.ts",
            line: 3,
            inline_comment_id: 777,
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
    sha: "abc888",
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
  const sec1 = ledger.findings.find((finding) => finding.id === "SEC-1");
  assert.equal(sec1.status, "resolved");
  assert.equal(sec1.inline_comment_id, 777);
});
