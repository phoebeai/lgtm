#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseReviewerIds } from "./shared/reviewers-json.mjs";

function writeTextFile(filePath, value) {
  const normalized = String(value ?? "");
  fs.writeFileSync(filePath, `${normalized}\n`, "utf8");
}

function copyOrCreateEmptyFile(sourcePath, targetPath) {
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, targetPath);
    return;
  }
  writeTextFile(targetPath, "");
}

export function persistConsensusArtifacts({
  runnerTemp,
  reviewersJson,
  consensusReports,
  outcome,
  openFindingsCount,
  reviewerErrorsCount,
  commentPath,
  ledgerPath,
}) {
  const normalizedRunnerTemp = String(runnerTemp || "").trim();
  if (!normalizedRunnerTemp) {
    throw new Error("RUNNER_TEMP is required");
  }

  const normalizedCommentPath = String(commentPath || "").trim();
  if (!normalizedCommentPath) {
    throw new Error("COMMENT_PATH is required");
  }
  const normalizedLedgerPath = String(ledgerPath || "").trim();
  if (!normalizedLedgerPath) {
    throw new Error("LEDGER_PATH is required");
  }

  const reviewerIds = parseReviewerIds(reviewersJson);
  const sourceReportsDir = path.join(normalizedRunnerTemp, "lgtm-reports");
  const targetDir = path.join(normalizedRunnerTemp, "lgtm");
  fs.mkdirSync(targetDir, { recursive: true });

  for (const reviewerId of reviewerIds) {
    const sourcePath = path.join(sourceReportsDir, `${reviewerId}.json`);
    const targetPath = path.join(targetDir, `${reviewerId}.json`);
    copyOrCreateEmptyFile(sourcePath, targetPath);
  }

  writeTextFile(path.join(targetDir, "reports-merged.json"), consensusReports);
  writeTextFile(path.join(targetDir, "outcome.txt"), outcome);
  writeTextFile(path.join(targetDir, "open-findings-count.txt"), openFindingsCount);
  // Backward-compat artifact path retained for external consumers.
  writeTextFile(path.join(targetDir, "blocking-findings-count.txt"), openFindingsCount);
  writeTextFile(path.join(targetDir, "reviewer-errors-count.txt"), reviewerErrorsCount);
  fs.copyFileSync(normalizedCommentPath, path.join(targetDir, "comment.md"));
  fs.copyFileSync(normalizedLedgerPath, path.join(targetDir, "findings-ledger.json"));
}

function main() {
  persistConsensusArtifacts({
    runnerTemp: process.env.RUNNER_TEMP,
    reviewersJson: process.env.REVIEWERS_JSON,
    consensusReports: process.env.CONSENSUS_REPORTS,
    outcome: process.env.OUTCOME,
    openFindingsCount: process.env.OPEN_FINDINGS_COUNT || process.env.BLOCKING_FINDINGS_COUNT,
    reviewerErrorsCount: process.env.REVIEWER_ERRORS_COUNT,
    commentPath: process.env.COMMENT_PATH,
    ledgerPath: process.env.LEDGER_PATH,
  });
}

function isCliMain() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCliMain()) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
