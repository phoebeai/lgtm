import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runReviewersParallel } from "../run-reviewers-parallel.mjs";
import { commitAll, createRepo, writeRepoFile } from "./test-utils.mjs";

function setupReviewRepo(t) {
  const repoDir = createRepo(t, "lgtm-run-reviewers-");
  writeRepoFile(
    repoDir,
    ".github/lgtm/prompts/security.md",
    "Security reviewer instructions.",
  );
  writeRepoFile(
    repoDir,
    ".github/lgtm/prompts/test-quality.md",
    "Test quality reviewer instructions.",
  );
  writeRepoFile(
    repoDir,
    ".github/lgtm/prompts/infrastructure.md",
    "Infrastructure reviewer instructions.",
  );
  writeRepoFile(repoDir, "src/service.js", "export const value = 1;\n");
  const baseSha = commitAll(repoDir, "base");

  writeRepoFile(repoDir, "src/service.js", "export const value = 2;\n");
  const headSha = commitAll(repoDir, "head");

  const schemaPath = path.join(repoDir, "reviewer-output.schema.json");
  fs.writeFileSync(schemaPath, "{}\n", "utf8");

  return { repoDir, baseSha, headSha, schemaPath };
}

async function runScenario({
  repoDir,
  baseSha,
  headSha,
  schemaPath,
  reviewers,
  priorLedger = { version: 1, findings: [] },
  runReviewerWithCodex,
}) {
  const promptsDir = fs.mkdtempSync(path.join(repoDir, "tmp-prompts-"));
  const reportsDir = fs.mkdtempSync(path.join(repoDir, "tmp-reports-"));
  const priorLedgerPath = path.join(repoDir, "prior-ledger.json");
  fs.writeFileSync(
    priorLedgerPath,
    `${JSON.stringify(priorLedger)}\n`,
    "utf8",
  );

  const result = await runReviewersParallel({
    baseSha,
    headSha,
    prNumber: "13",
    repository: "phoebeai/lgtm",
    reviewersJson: JSON.stringify(reviewers),
    resolvedModel: "gpt-5.3-codex",
    resolvedEffort: "medium",
    schemaFile: schemaPath,
    promptsDir,
    reportsDir,
    reviewerTimeoutMinutes: "1",
    priorLedgerJsonPath: priorLedgerPath,
    workspaceDir: repoDir,
    runReviewerWithCodex,
  });

  return { result, reportsDir, promptsDir };
}

function readReport(reportsDir, reviewerId) {
  const reportPath = path.join(reportsDir, `${reviewerId}.json`);
  return JSON.parse(fs.readFileSync(reportPath, "utf8"));
}

test("runReviewersParallel executes active reviewer and skips out-of-scope reviewer", async (t) => {
  const { repoDir, baseSha, headSha, schemaPath } = setupReviewRepo(t);
  const { result, reportsDir } = await runScenario({
    repoDir,
    baseSha,
    headSha,
    schemaPath,
    reviewers: [
      {
        id: "security",
        scope: "security risk",
        prompt_file: ".github/lgtm/prompts/security.md",
        paths_json: "[]",
      },
      {
        id: "infrastructure",
        scope: "infrastructure risk",
        prompt_file: ".github/lgtm/prompts/infrastructure.md",
        paths_json: JSON.stringify(["infra/**"]),
      },
    ],
    runReviewerWithCodex: async () => ({
      rawOutput: JSON.stringify({
        reviewer: "security",
        summary: "ok",
        resolved_finding_ids: [],
        new_findings: [],
        errors: [],
      }),
      outcome: "success",
      conclusion: "success",
      error: "",
    }),
  });

  assert.equal(result.reviewer_count, 2);
  assert.deepEqual(
    result.results.map((entry) => entry.reviewer),
    ["security", "infrastructure"],
  );

  const securityReport = readReport(reportsDir, "security");
  assert.equal(securityReport.run_state, "completed");
  assert.equal(securityReport.summary, "ok");

  const infraReport = readReport(reportsDir, "infrastructure");
  assert.equal(infraReport.run_state, "skipped");
  assert.equal(infraReport.summary, "Skipped (no relevant changes)");
});

test("runReviewersParallel emits error report when trusted prompt build fails", async (t) => {
  const { repoDir, baseSha, headSha, schemaPath } = setupReviewRepo(t);
  const { result, reportsDir } = await runScenario({
    repoDir,
    baseSha,
    headSha,
    schemaPath,
    reviewers: [
      {
        id: "security",
        scope: "security risk",
        prompt_file: ".github/lgtm/prompts/missing.md",
        paths_json: "[]",
      },
    ],
    runReviewerWithCodex: async () => ({
      rawOutput: JSON.stringify({
        reviewer: "security",
        summary: "ok",
        resolved_finding_ids: [],
        new_findings: [],
        errors: [],
      }),
      outcome: "success",
      conclusion: "success",
      error: "",
    }),
  });

  assert.equal(result.reviewer_count, 1);
  const report = readReport(reportsDir, "security");
  assert.equal(report.run_state, "error");
  assert.ok(
    report.errors.some((error) =>
      error.includes("trusted reviewer input build failed"),
    ),
  );
  assert.ok(
    report.errors.some((error) =>
      error.includes("Missing trusted prompt in base revision"),
    ),
  );
});

test("runReviewersParallel rejects duplicate reviewer ids before spawning work", async (t) => {
  const { repoDir, baseSha, headSha, schemaPath } = setupReviewRepo(t);
  await assert.rejects(
    runScenario({
      repoDir,
      baseSha,
      headSha,
      schemaPath,
      reviewers: [
        {
          id: "security",
          scope: "security risk",
          prompt_file: ".github/lgtm/prompts/security.md",
          paths_json: "[]",
        },
        {
          id: "security",
          scope: "security risk",
          prompt_file: ".github/lgtm/prompts/security.md",
          paths_json: "[]",
        },
      ],
      runReviewerWithCodex: async () => ({
        rawOutput: JSON.stringify({
          reviewer: "security",
          summary: "ok",
          resolved_finding_ids: [],
          new_findings: [],
          errors: [],
        }),
        outcome: "success",
        conclusion: "success",
        error: "",
      }),
    }),
    /Duplicate reviewer id in REVIEWERS_JSON: security/,
  );
});

test("runReviewersParallel returns error payload when reviewer output is invalid", async (t) => {
  const { repoDir, baseSha, headSha, schemaPath } = setupReviewRepo(t);
  const { reportsDir } = await runScenario({
    repoDir,
    baseSha,
    headSha,
    schemaPath,
    reviewers: [
      {
        id: "security",
        scope: "security risk",
        prompt_file: ".github/lgtm/prompts/security.md",
        paths_json: "[]",
      },
    ],
    runReviewerWithCodex: async () => ({
      rawOutput: "not-json",
      outcome: "failure",
      conclusion: "failure",
      error: "failed",
    }),
  });

  const report = readReport(reportsDir, "security");
  assert.equal(report.run_state, "error");
  assert.ok(
    report.errors.some((error) => error.startsWith("invalid review output:")),
  );
  assert.ok(
    report.errors.some((error) =>
      error.includes("review step outcome: failure"),
    ),
  );
});

test("runReviewersParallel continues to later reviewers after one reviewer failure", async (t) => {
  const { repoDir, baseSha, headSha, schemaPath } = setupReviewRepo(t);
  const { result, reportsDir } = await runScenario({
    repoDir,
    baseSha,
    headSha,
    schemaPath,
    reviewers: [
      {
        id: "security",
        scope: "security risk",
        prompt_file: ".github/lgtm/prompts/security.md",
        paths_json: "[]",
      },
      {
        id: "test_quality",
        scope: "test quality and coverage risk",
        prompt_file: ".github/lgtm/prompts/test-quality.md",
        paths_json: "[]",
      },
    ],
    runReviewerWithCodex: async ({ promptPath }) => {
      const prompt = fs.readFileSync(promptPath, "utf8");
      if (prompt.includes("security reviewer")) {
        return {
          rawOutput: "not-json",
          outcome: "failure",
          conclusion: "failure",
          error: "boom",
        };
      }
      return {
        rawOutput: JSON.stringify({
          reviewer: "test_quality",
          summary: "ok",
          resolved_finding_ids: [],
          new_findings: [],
          errors: [],
        }),
        outcome: "success",
        conclusion: "success",
        error: "",
      };
    },
  });

  assert.equal(result.reviewer_count, 2);
  assert.equal(readReport(reportsDir, "security").run_state, "error");
  assert.equal(readReport(reportsDir, "test_quality").run_state, "completed");
});

test("runReviewersParallel executes active reviewers concurrently", async (t) => {
  const { repoDir, baseSha, headSha, schemaPath } = setupReviewRepo(t);
  let active = 0;
  let maxActive = 0;

  await runScenario({
    repoDir,
    baseSha,
    headSha,
    schemaPath,
    reviewers: [
      {
        id: "security",
        scope: "security risk",
        prompt_file: ".github/lgtm/prompts/security.md",
        paths_json: "[]",
      },
      {
        id: "test_quality",
        scope: "test quality and coverage risk",
        prompt_file: ".github/lgtm/prompts/test-quality.md",
        paths_json: "[]",
      },
    ],
    runReviewerWithCodex: async ({ promptPath }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 50));
      active -= 1;

      const prompt = fs.readFileSync(promptPath, "utf8");
      const reviewer = prompt.includes("security reviewer")
        ? "security"
        : "test_quality";
      return {
        rawOutput: JSON.stringify({
          reviewer,
          summary: "ok",
          resolved_finding_ids: [],
          new_findings: [],
          errors: [],
        }),
        outcome: "success",
        conclusion: "success",
        error: "",
      };
    },
  });

  assert.ok(maxActive > 1, `expected parallelism, got maxActive=${maxActive}`);
});

test("runReviewersParallel injects prior ledger entries into reviewer prompts", async (t) => {
  const { repoDir, baseSha, headSha, schemaPath } = setupReviewRepo(t);
  let capturedPrompt = "";

  await runScenario({
    repoDir,
    baseSha,
    headSha,
    schemaPath,
    reviewers: [
      {
        id: "security",
        scope: "security risk",
        prompt_file: ".github/lgtm/prompts/security.md",
        paths_json: "[]",
      },
    ],
    priorLedger: {
      version: 1,
      findings: [
        {
          id: "SEC001",
          reviewer: "security",
          status: "resolved",
          title: "Existing issue",
          recommendation: "Do not repeat.",
          file: "src/service.js",
          line: 1,
        },
      ],
    },
    runReviewerWithCodex: async ({ promptPath }) => {
      capturedPrompt = fs.readFileSync(promptPath, "utf8");
      return {
        rawOutput: JSON.stringify({
          reviewer: "security",
          summary: "ok",
          resolved_finding_ids: [],
          new_findings: [],
          errors: [],
        }),
        outcome: "success",
        conclusion: "success",
        error: "",
      };
    },
  });

  assert.match(
    capturedPrompt,
    /Previous findings ledger entries for this reviewer and scope/,
  );
  assert.match(capturedPrompt, /Existing issue/);
  assert.match(capturedPrompt, /Do not duplicate already-open findings in new_findings/);
});

test("runReviewersParallel fails when PRIOR_LEDGER_JSON is malformed", async (t) => {
  const { repoDir, baseSha, headSha, schemaPath } = setupReviewRepo(t);
  const promptsDir = fs.mkdtempSync(path.join(repoDir, "tmp-prompts-"));
  const reportsDir = fs.mkdtempSync(path.join(repoDir, "tmp-reports-"));
  const priorLedgerPath = path.join(repoDir, "prior-ledger.json");
  fs.writeFileSync(priorLedgerPath, "{not-json", "utf8");

  await assert.rejects(
    runReviewersParallel({
      baseSha,
      headSha,
      prNumber: "13",
      repository: "phoebeai/lgtm",
      reviewersJson: JSON.stringify([
        {
          id: "security",
          scope: "security risk",
          prompt_file: ".github/lgtm/prompts/security.md",
          paths_json: "[]",
        },
      ]),
      resolvedModel: "gpt-5.3-codex",
      resolvedEffort: "medium",
      schemaFile: schemaPath,
      promptsDir,
      reportsDir,
      reviewerTimeoutMinutes: "1",
      priorLedgerJsonPath: priorLedgerPath,
      workspaceDir: repoDir,
      runReviewerWithCodex: async () => ({
        rawOutput: JSON.stringify({
          reviewer: "security",
          summary: "ok",
          resolved_finding_ids: [],
          new_findings: [],
          errors: [],
        }),
        outcome: "success",
        conclusion: "success",
        error: "",
      }),
    }),
    /Invalid PRIOR_LEDGER_JSON/,
  );
});
