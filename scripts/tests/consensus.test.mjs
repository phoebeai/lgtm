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

    if (method === "GET" && /\/pulls\/7\/reviews\?/.test(target)) {
      return new Response(
        JSON.stringify([
          {
            id: 1,
            state: "APPROVED",
            commit_id: "oldsha",
            submitted_at: "2026-01-01T00:00:00Z",
            user: { login: "alice", type: "User" },
          },
          {
            id: 2,
            state: "APPROVED",
            commit_id: "abc123",
            submitted_at: "2026-01-02T00:00:00Z",
            user: { login: "bob", type: "User" },
          },
          {
            id: 3,
            state: "APPROVED",
            commit_id: "abc123",
            submitted_at: "2026-01-03T00:00:00Z",
            user: { login: "github-actions[bot]", type: "Bot" },
          },
          {
            id: 4,
            state: "DISMISSED",
            commit_id: "abc123",
            submitted_at: "2026-01-04T00:00:00Z",
            user: { login: "carol", type: "User" },
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
