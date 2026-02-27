import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  collectUnresolvedBlockingPriorEntries,
  runConsensus,
} from "../consensus.mjs";
import {
  normalizeReviewers,
  renderConsensusComment,
} from "../shared/consensus-renderer.mjs";
import { parseGithubOutput } from "./test-utils.mjs";

function createTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("normalizeReviewers validates ids and duplicate entries", () => {
  assert.throws(
    () => normalizeReviewers("[{\"id\":\"bad-id\"}]"),
    /must match/,
  );

  assert.throws(
    () => normalizeReviewers("[{\"id\":\"security\"},{\"id\":\"security\"}]"),
    /Duplicate reviewer id/,
  );

  const reviewers = normalizeReviewers("[{\"id\":\"security\",\"display_name\":\"Security\"}]");
  assert.equal(reviewers[0].required, true);
});

test("renderConsensusComment includes only blocking details", () => {
  const comment = renderConsensusComment({
    marker: "<!-- marker -->",
    outcome: "FAIL",
    blockingEntries: [
      {
        reviewer: "security",
        finding: {
          title: "Critical issue",
          recommendation: "Fix now",
          file: "src/app.ts",
          line: 42,
          blocking: true,
        },
      },
    ],
    reviewerErrors: ["security: reviewer execution/output error"],
    labelsByReviewerId: new Map([["security", "Security"]]),
  });

  assert.match(comment, /## ❌ LGTM/);
  assert.match(comment, /2 blocking issues found\./);
  assert.match(comment, /### Blocking Reviewer Errors/);
  assert.match(comment, /security: reviewer execution\/output error/);
  assert.match(comment, /### Blocking Issues/);
  assert.match(comment, /\*\*Security \(blocking\):\*\* Critical issue/);
  assert.match(comment, /Location: `src\/app\.ts:42`/);
  assert.match(comment, /Critical issue/);
  assert.match(comment, /Fix now/);
  assert.doesNotMatch(comment, /Non-Blocking/);
  assert.doesNotMatch(comment, /Raw Results/);
  assert.doesNotMatch(comment, /Metadata/);
});

test("runConsensus writes comment and GitHub outputs for PASS", async (t) => {
  const tempDir = createTempDir(t, "consensus-pass-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  fs.writeFileSync(
    path.join(reportsDir, "security.json"),
    JSON.stringify({
      reviewer: "security",
      run_state: "completed",
      summary: "Looks good",
      findings: [],
      errors: [],
    }),
    "utf8",
  );

  fs.writeFileSync(
    path.join(reportsDir, "infrastructure.json"),
    JSON.stringify({
      reviewer: "infrastructure",
      run_state: "error",
      summary: "Runner issue",
      findings: [],
      errors: ["timeout"],
    }),
    "utf8",
  );

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
  const result = await runConsensus({
    sha: "abc123",
    commentPath,
    token: "",
    repo: "",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
        required: true,
      },
      {
        id: "infrastructure",
        display_name: "Infrastructure",
        required: false,
      },
    ]),
  });

  assert.equal(result.outcome, "PASS");
  assert.equal(fs.existsSync(commentPath), true);

  const comment = fs.readFileSync(commentPath, "utf8");
  assert.match(comment, /## ✅ LGTM/);
  assert.match(comment, /No blocking issues found\./);
  assert.doesNotMatch(comment, /infrastructure: reviewer execution\/output error/);
  assert.doesNotMatch(comment, /Non-Blocking/);

  const outputs = parseGithubOutput(fs.readFileSync(outputPath, "utf8"));
  assert.equal(outputs.outcome, "PASS");
  assert.equal(outputs.blocking_findings_count, "0");
  assert.equal(outputs.reviewer_errors_count, "0");
});

test("runConsensus ignores findings from skipped reviewers", async (t) => {
  const tempDir = createTempDir(t, "consensus-skipped-findings-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  fs.writeFileSync(
    path.join(reportsDir, "security.json"),
    JSON.stringify({
      reviewer: "security",
      run_state: "skipped",
      summary: "Skipped (no relevant changes)",
      findings: [
        {
          title: "Should be ignored",
          file: "src/db.ts",
          line: 10,
          recommendation: "Ignore me",
          blocking: true,
        },
      ],
      errors: [],
    }),
    "utf8",
  );

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
  const result = await runConsensus({
    sha: "abc123",
    commentPath,
    token: "",
    repo: "",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
        required: true,
      },
    ]),
  });

  assert.equal(result.outcome, "PASS");
  assert.equal(result.requiredBlockingFindingsCount, 0);

  const comment = fs.readFileSync(commentPath, "utf8");
  assert.match(comment, /## ✅ LGTM/);
  assert.match(comment, /No blocking issues found\./);
  assert.doesNotMatch(comment, /Should be ignored/);

  const outputs = parseGithubOutput(fs.readFileSync(outputPath, "utf8"));
  assert.equal(outputs.outcome, "PASS");
  assert.equal(outputs.blocking_findings_count, "0");
  assert.equal(outputs.reviewer_errors_count, "0");
});

test("runConsensus fails when required reviewer has blocking finding", async (t) => {
  const tempDir = createTempDir(t, "consensus-fail-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  fs.writeFileSync(
    path.join(reportsDir, "security.json"),
    JSON.stringify({
      reviewer: "security",
      run_state: "completed",
      summary: "Needs work",
      findings: [
        {
          title: "SQL injection",
          file: "src/db.ts",
          line: 10,
          recommendation: "Use parameterized query",
          blocking: true,
        },
      ],
      errors: [],
    }),
    "utf8",
  );

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

  const result = await runConsensus({
    sha: "abc123",
    commentPath: path.join(tempDir, "comment.md"),
    token: "",
    repo: "",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
        required: true,
      },
    ]),
  });

  assert.equal(result.outcome, "FAIL");
  assert.equal(result.requiredBlockingFindingsCount, 1);

  const outputs = parseGithubOutput(fs.readFileSync(outputPath, "utf8"));
  assert.equal(outputs.outcome, "FAIL");
  assert.equal(outputs.blocking_findings_count, "1");
});

test("runConsensus posts only blocking findings inline and keeps blockers in sticky comment", async (t) => {
  const tempDir = createTempDir(t, "consensus-inline-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  fs.writeFileSync(
    path.join(reportsDir, "security.json"),
    JSON.stringify({
      reviewer: "security",
      run_state: "completed",
      summary: "Needs work",
      findings: [
        {
          title: "Inline security issue",
          file: "src/db.ts",
          line: 10,
          recommendation: "Use parameterized query",
          blocking: true,
        },
        {
          title: "Advisory formatting issue",
          file: "src/db.ts",
          line: 11,
          recommendation: "Tidy formatting",
          blocking: false,
        },
      ],
      errors: [],
    }),
    "utf8",
  );

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let postedInlineCount = 0;

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const target = String(url);

    if (method === "GET" && /\/pulls\/7\/comments\?/.test(target)) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    if (method === "POST" && /\/pulls\/7\/comments$/.test(target)) {
      postedInlineCount += 1;
      return new Response(JSON.stringify({ id: 777 }), {
        status: 201,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    throw new Error(`Unexpected request ${method} ${target}`);
  };

  const commentPath = path.join(tempDir, "comment.md");
  const result = await runConsensus({
    sha: "abc123",
    commentPath,
    token: "token",
    repo: "owner/repo",
    prNumber: "7",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
        required: true,
      },
    ]),
    publishInlineComments: "true",
  });

  assert.equal(result.outcome, "FAIL");
  assert.equal(postedInlineCount, 1);

  const comment = fs.readFileSync(commentPath, "utf8");
  assert.match(comment, /1 blocking issue found\./);
  assert.match(comment, /### Blocking Issues/);
  assert.match(comment, /Inline security issue/);
  assert.doesNotMatch(comment, /Advisory formatting issue/);
  assert.doesNotMatch(comment, /Inline Line Findings/);
});

test("runConsensus explains inline posting failures and keeps failed blockers in sticky comment", async (t) => {
  const tempDir = createTempDir(t, "consensus-inline-fail-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  fs.writeFileSync(
    path.join(reportsDir, "security.json"),
    JSON.stringify({
      reviewer: "security",
      run_state: "completed",
      summary: "Needs work",
      findings: [
        {
          title: "Inline security issue",
          file: "src/db.ts",
          line: 10,
          recommendation: "Use parameterized query",
          blocking: true,
        },
      ],
      errors: [],
    }),
    "utf8",
  );

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const target = String(url);

    if (method === "GET" && /\/pulls\/7\/comments\?/.test(target)) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    if (method === "POST" && /\/pulls\/7\/comments$/.test(target)) {
      return new Response("line is not part of the diff", {
        status: 422,
        headers: {
          "content-type": "text/plain",
        },
      });
    }

    throw new Error(`Unexpected request ${method} ${target}`);
  };

  const commentPath = path.join(tempDir, "comment.md");
  const result = await runConsensus({
    sha: "abc123",
    commentPath,
    token: "token",
    repo: "owner/repo",
    prNumber: "7",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
        required: true,
      },
    ]),
    publishInlineComments: "true",
  });

  assert.equal(result.outcome, "FAIL");

  const comment = fs.readFileSync(commentPath, "utf8");
  assert.doesNotMatch(comment, /could not be posted inline/);
  assert.match(comment, /### Blocking Issues/);
  assert.match(comment, /Inline security issue/);
  assert.match(comment, /`src\/db\.ts:10`/);
});

test("runConsensus posts blocking inline comments without exact-match suppression", async (t) => {
  const tempDir = createTempDir(t, "consensus-inline-duplicate-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  fs.writeFileSync(
    path.join(reportsDir, "security.json"),
    JSON.stringify({
      reviewer: "security",
      run_state: "completed",
      summary: "Needs work",
      findings: [
        {
          title: "Inline security issue",
          file: "src/db.ts",
          line: 10,
          recommendation: "Use parameterized query",
          blocking: true,
        },
      ],
      errors: [],
    }),
    "utf8",
  );

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let postedInlineCount = 0;

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const target = String(url);

    if (method === "POST" && /\/pulls\/7\/comments$/.test(target)) {
      postedInlineCount += 1;
      return new Response(JSON.stringify({ id: 777 }), {
        status: 201,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    throw new Error(`Unexpected request ${method} ${target}`);
  };

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
  const result = await runConsensus({
    sha: "abc123",
    commentPath,
    token: "token",
    repo: "owner/repo",
    prNumber: "7",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
        required: true,
      },
    ]),
    publishInlineComments: "true",
  });

  assert.equal(postedInlineCount, 1);
  assert.equal(result.outcome, "FAIL");
  assert.equal(result.requiredBlockingFindingsCount, 1);

  const outputs = parseGithubOutput(fs.readFileSync(outputPath, "utf8"));
  assert.equal(outputs.outcome, "FAIL");
  assert.equal(outputs.blocking_findings_count, "1");
});

test("collectUnresolvedBlockingPriorEntries keeps only unresolved blocking inline findings", () => {
  const entries = collectUnresolvedBlockingPriorEntries([
    {
      path: "src/a.ts",
      line: 12,
      resolved: false,
      body: "**Security (blocking):** Existing blocker\n\nFix it",
    },
    {
      path: "src/a.ts",
      line: 13,
      resolved: false,
      body: "**Security (non-blocking):** Advisory note\n\nConsider updating",
    },
    {
      path: "src/a.ts",
      line: 14,
      resolved: true,
      body: "**Security (blocking):** Already resolved\n\nNo action",
    },
  ]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].reviewer, "Security");
  assert.equal(entries[0].finding.title, "Existing blocker");
  assert.equal(entries[0].finding.file, "src/a.ts");
  assert.equal(entries[0].finding.line, 12);
  assert.equal(entries[0].finding.blocking, true);
});

test("runConsensus fails when unresolved prior blocking inline finding exists", async (t) => {
  const tempDir = createTempDir(t, "consensus-prior-blocker-");
  const reportsDir = path.join(tempDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  fs.writeFileSync(
    path.join(reportsDir, "security.json"),
    JSON.stringify({
      reviewer: "security",
      run_state: "completed",
      summary: "No new issues",
      findings: [],
      errors: [],
    }),
    "utf8",
  );

  const priorFindingsJsonPath = path.join(tempDir, "prior-findings.json");
  fs.writeFileSync(
    priorFindingsJsonPath,
    `${JSON.stringify(
      [
        {
          path: "src/db.ts",
          line: 44,
          resolved: false,
          body: "**Security (blocking):** Prior unresolved blocker\n\nFix now",
        },
        {
          path: "src/db.ts",
          line: 45,
          resolved: true,
          body: "**Security (blocking):** Resolved blocker\n\nAlready fixed",
        },
      ],
      null,
      2,
    )}\n`,
    "utf8",
  );

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    throw new Error("runConsensus should not post inline comments without current blocking findings");
  };

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
  const result = await runConsensus({
    sha: "abc123",
    commentPath,
    token: "token",
    repo: "owner/repo",
    prNumber: "7",
    marker: "<!-- marker -->",
    reportsDir,
    reviewersJson: JSON.stringify([
      {
        id: "security",
        display_name: "Security",
        required: true,
      },
    ]),
    publishInlineComments: "true",
    priorFindingsJson: priorFindingsJsonPath,
  });

  assert.equal(result.outcome, "FAIL");
  assert.equal(result.requiredBlockingFindingsCount, 1);
  assert.ok(
    result.failureReasons.includes("prior-inline: unresolved blocking finding (Prior unresolved blocker)"),
  );

  const comment = fs.readFileSync(commentPath, "utf8");
  assert.match(comment, /## ❌ LGTM/);
  assert.match(comment, /1 blocking issue found\./);
  assert.match(comment, /Prior unresolved blocker/);
  assert.match(comment, /Location: `src\/db\.ts:44`/);

  const outputs = parseGithubOutput(fs.readFileSync(outputPath, "utf8"));
  assert.equal(outputs.outcome, "FAIL");
  assert.equal(outputs.blocking_findings_count, "1");
});
