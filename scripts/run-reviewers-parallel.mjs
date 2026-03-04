#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Codex } from "@openai/codex-sdk";
import { buildTrustedReviewerInputs } from "./build-trusted-reviewer-inputs.mjs";
import { processReviewerOutput } from "./normalize-reviewer-output.mjs";

const REVIEWER_ID_PATTERN = /^[a-z0-9_]+$/;

function readRequiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseReviewersJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid REVIEWERS_JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("REVIEWERS_JSON must contain at least one reviewer");
  }

  const seenReviewerIds = new Set();
  return parsed.map((entry, index) => {
    const label = `REVIEWERS_JSON[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label} must be an object`);
    }

    const reviewerId = String(entry.id || "").trim();
    if (!REVIEWER_ID_PATTERN.test(reviewerId)) {
      throw new Error(`${label}.id must match ^[a-z0-9_]+$`);
    }
    if (seenReviewerIds.has(reviewerId)) {
      throw new Error(`Duplicate reviewer id in REVIEWERS_JSON: ${reviewerId}`);
    }
    seenReviewerIds.add(reviewerId);

    const promptFile = String(entry.prompt_file || "").trim();
    if (!promptFile) {
      throw new Error(`${label}.prompt_file must be a non-empty string`);
    }

    const scope = String(entry.scope || "").trim();
    if (!scope) {
      throw new Error(`${label}.scope must be a non-empty string`);
    }

    return {
      ...entry,
      id: reviewerId,
      prompt_file: promptFile,
      scope,
      paths_json:
        entry.paths_json === undefined || entry.paths_json === null
          ? "[]"
          : String(entry.paths_json),
    };
  });
}

function makeEmptyLedger() {
  return {
    version: 1,
    findings: [],
  };
}

function readPriorLedger(filePath) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return makeEmptyLedger();
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
  } catch {
    return makeEmptyLedger();
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return makeEmptyLedger();
  }

  return {
    ...parsed,
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
  };
}

function makeRunGitForWorkspace(workspaceDir) {
  return (args, { encoding = "utf8" } = {}) =>
    execFileSync("git", args, {
      cwd: workspaceDir,
      encoding,
      stdio: ["ignore", "pipe", "pipe"],
    });
}

function resolveTimeoutMs({ reviewerTimeoutMinutes, reviewerTimeoutMs }) {
  const timeoutMinutes = Number(reviewerTimeoutMinutes || 10);
  const fallbackTimeoutMs = Math.max(1, timeoutMinutes) * 60 * 1000;
  const explicitTimeoutMs = Number(reviewerTimeoutMs);
  return Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0
    ? explicitTimeoutMs
    : fallbackTimeoutMs;
}

async function defaultRunReviewerWithCodex({
  codexBin,
  model,
  effort,
  promptPath,
  schemaPath,
  timeoutMs,
  cwd,
}) {
  const prompt = fs.readFileSync(promptPath, "utf8");
  const outputSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

  const codex = new Codex({
    codexPathOverride: codexBin,
  });

  const thread = codex.startThread({
    model,
    modelReasoningEffort: effort,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    workingDirectory: cwd,
    skipGitRepoCheck: true,
  });

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);

  try {
    const turn = await thread.run(prompt, {
      outputSchema,
      signal: timeoutController.signal,
    });
    return {
      rawOutput: String(turn.finalResponse || ""),
      outcome: "success",
      conclusion: "success",
      error: "",
    };
  } catch (error) {
    const timedOut = timeoutController.signal.aborted;
    const timeoutSeconds = Math.ceil(timeoutMs / 1000);
    return {
      rawOutput: "",
      outcome: "failure",
      conclusion: "failure",
      error: timedOut
        ? `review timed out after ${timeoutSeconds}s`
        : String(error?.message || "codex execution failed"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runSingleReviewer({
  reviewer,
  baseSha,
  headSha,
  prNumber,
  repository,
  resolvedModel,
  resolvedEffort,
  schemaFile,
  promptsDir,
  timeoutMs,
  workspaceDir,
  codexBin,
  priorLedger,
  runGit,
  runReviewerWithCodex,
}) {
  const reviewerId = String(reviewer?.id || "").trim();
  if (!reviewerId) {
    throw new Error("Each reviewer must include a non-empty id");
  }

  let reviewerActive = true;
  let reviewerHasInputs = true;
  let promptStepOutcome = "success";
  let promptStepConclusion = "success";
  let promptSkipReason = "";
  let rawOutput = "";
  let reviewStepOutcome = "";
  let reviewStepConclusion = "";
  let reviewStepError = "";

  try {
    const prepared = buildTrustedReviewerInputs({
      baseSha,
      headSha,
      reviewer: reviewerId,
      reviewScope: String(reviewer.scope || ""),
      prNumber,
      repository,
      promptRel: String(reviewer.prompt_file || ""),
      schemaFile,
      pathFiltersJson: reviewer.paths_json,
      priorLedger,
      outputDir: promptsDir,
      runGit,
    });

    reviewerActive = prepared.reviewerActive;
    reviewerHasInputs = prepared.reviewerActive;
    promptSkipReason = prepared.skipReason || "";

    if (prepared.reviewerActive) {
      const reviewResult = await runReviewerWithCodex({
        codexBin,
        model: resolvedModel,
        effort: resolvedEffort,
        promptPath: prepared.promptPath,
        schemaPath: prepared.schemaPath,
        timeoutMs,
        cwd: workspaceDir,
      });

      rawOutput = reviewResult.rawOutput;
      reviewStepOutcome = reviewResult.outcome;
      reviewStepConclusion = reviewResult.conclusion;
      reviewStepError = String(reviewResult.error || "").trim();
    }
  } catch (error) {
    reviewerActive = true;
    reviewerHasInputs = true;
    promptStepOutcome = "failure";
    promptStepConclusion = "failure";
    promptSkipReason = String(error?.message || "trusted reviewer input build failed");
    rawOutput = "";
    reviewStepOutcome = "";
    reviewStepConclusion = "";
    reviewStepError = "";
  }

  return processReviewerOutput({
    reviewer: reviewerId,
    reviewerActive,
    reviewerHasInputs,
    promptStepOutcome,
    promptStepConclusion,
    promptSkipReason,
    rawOutput,
    stepOutcome: reviewStepOutcome,
    stepConclusion: reviewStepConclusion,
    stepError: reviewStepError,
  });
}

export async function runReviewersParallel({
  baseSha,
  headSha,
  prNumber,
  repository,
  reviewersJson,
  resolvedModel,
  resolvedEffort,
  schemaFile,
  promptsDir,
  reportsDir,
  reviewerTimeoutMinutes,
  reviewerTimeoutMs,
  priorLedgerJsonPath,
  workspaceDir,
  codexBin = process.env.CODEX_BIN || "codex",
  runReviewerWithCodex = defaultRunReviewerWithCodex,
}) {
  const reviewers = parseReviewersJson(reviewersJson);
  const timeoutMs = resolveTimeoutMs({ reviewerTimeoutMinutes, reviewerTimeoutMs });
  const runGit = makeRunGitForWorkspace(workspaceDir);
  const priorLedger = readPriorLedger(priorLedgerJsonPath);
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });

  const jobs = reviewers.map(async (reviewer) => {
    const reviewerId = String(reviewer?.id || "").trim();
    const payload = await runSingleReviewer({
      reviewer,
      baseSha,
      headSha,
      prNumber,
      repository,
      resolvedModel,
      resolvedEffort,
      schemaFile,
      promptsDir,
      timeoutMs,
      workspaceDir,
      codexBin,
      priorLedger,
      runGit,
      runReviewerWithCodex,
    });

    const reportPath = path.join(reportsDir, `${reviewerId}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(payload)}\n`, "utf8");
    return {
      reviewer: reviewerId,
      run_state: payload.run_state,
      report_path: reportPath,
    };
  });

  const results = await Promise.all(jobs);

  return {
    reviewer_count: reviewers.length,
    reports_dir: reportsDir,
    results,
  };
}

async function main() {
  const result = await runReviewersParallel({
    baseSha: readRequiredEnv("BASE_SHA"),
    headSha: readRequiredEnv("HEAD_SHA"),
    prNumber: readRequiredEnv("PR_NUMBER"),
    repository: readRequiredEnv("REPOSITORY"),
    reviewersJson: readRequiredEnv("REVIEWERS_JSON"),
    resolvedModel: readRequiredEnv("RESOLVED_MODEL"),
    resolvedEffort: readRequiredEnv("RESOLVED_EFFORT"),
    schemaFile: readRequiredEnv("SCHEMA_FILE"),
    promptsDir: readRequiredEnv("PROMPTS_DIR"),
    reportsDir: readRequiredEnv("REPORTS_DIR"),
    reviewerTimeoutMinutes: String(process.env.REVIEWER_TIMEOUT_MINUTES || "10"),
    priorLedgerJsonPath: String(process.env.PRIOR_LEDGER_JSON || ""),
    workspaceDir: readRequiredEnv("WORKSPACE_DIR"),
    codexBin: process.env.CODEX_BIN || "codex",
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function isCliMain() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCliMain()) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
