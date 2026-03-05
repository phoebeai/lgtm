#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { computeConsensus } from "./shared/consensus-core.mjs";
import {
  normalizeReviewers,
  renderConsensusComment,
} from "./shared/consensus-renderer.mjs";
import { writeConsensusOutputs } from "./shared/consensus-output.mjs";
import { normalizePersistedReviewerReport } from "./shared/reviewer-core.mjs";
import {
  mergeLedgerWithReports,
  normalizeLedger,
} from "./shared/findings-ledger.mjs";
import { syncInlineFindingLifecycle } from "./shared/consensus-inline-lifecycle.mjs";

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function readReportInput(reportsDir, reviewerId) {
  const reportPath = path.join(reportsDir, `${reviewerId}.json`);
  if (!fs.existsSync(reportPath)) {
    return "";
  }
  return fs.readFileSync(reportPath, "utf8");
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function logNonFatalGithubError(context, error) {
  const message = normalizeText(error?.message || "unknown github api error");
  process.stderr.write(`[consensus] non-fatal ${context} error: ${message}\n`);
}

function readLedgerInput(priorLedgerJsonPath) {
  const normalizedPath = normalizeText(priorLedgerJsonPath);
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return normalizeLedger(null);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid PRIOR_LEDGER_JSON at ${normalizedPath}: ${error.message}`);
  }

  try {
    return normalizeLedger(parsed);
  } catch (error) {
    throw new Error(`Invalid PRIOR_LEDGER_JSON at ${normalizedPath}: ${error.message}`);
  }
}

function renderFailureReasons({ reviewerErrors, openEntries }) {
  const reasons = Array.isArray(reviewerErrors) ? [...reviewerErrors] : [];
  for (const entry of Array.isArray(openEntries) ? openEntries : []) {
    const finding = entry?.finding || {};
    const id = normalizeText(finding.id);
    const title = normalizeText(finding.title) || "Untitled finding";
    reasons.push(`open-finding: ${id ? `[${id}] ` : ""}${title}`);
  }
  return reasons;
}

function toPresentationEntries(ledgerFindings, status) {
  return ledgerFindings
    .filter((entry) => entry.status === status)
    .map((entry) => ({
      reviewer: entry.reviewer,
      status: entry.status,
      finding: {
        id: entry.id,
        title: entry.title,
        recommendation: entry.recommendation,
        file: entry.file,
        line: entry.line,
      },
    }));
}

export function readReportsForReviewers({ reportsDir, reviewers }) {
  const reports = {};
  for (const reviewer of reviewers) {
    reports[reviewer.id] = normalizePersistedReviewerReport(
      reviewer.id,
      readReportInput(reportsDir, reviewer.id),
    );
  }
  return reports;
}

function evaluateOutcome({ reviewerErrorsCount, openFindingsCount }) {
  if (reviewerErrorsCount > 0) {
    return {
      outcome: "FAIL",
      outcomeReason: "FAIL_REVIEWER_ERRORS",
    };
  }

  if (openFindingsCount > 0) {
    return {
      outcome: "FAIL",
      outcomeReason: "FAIL_OPEN_FINDINGS",
    };
  }

  return {
    outcome: "PASS",
    outcomeReason: "PASS_NO_FINDINGS",
  };
}

export async function runConsensus({
  runId,
  baseSha,
  sha,
  workspaceDir,
  commentPath,
  ledgerPath,
  token,
  repo,
  prNumber,
  marker,
  reportsDir,
  reviewersJson,
  publishInlineComments,
  priorLedgerJson,
}) {
  const normalizedReportsDir = String(reportsDir || "").trim();
  if (!normalizedReportsDir) {
    throw new Error("REPORTS_DIR is required");
  }

  const normalizedCommentPath = String(commentPath || "").trim();
  if (!normalizedCommentPath) {
    throw new Error("COMMENT_PATH is required");
  }

  const normalizedLedgerPath = String(ledgerPath || "").trim();
  if (!normalizedLedgerPath) {
    throw new Error("LEDGER_PATH is required");
  }

  const reviewers = normalizeReviewers(reviewersJson || "[]");
  const labelsByReviewerId = new Map(reviewers.map((reviewer) => [reviewer.id, reviewer.display_name]));

  const reports = readReportsForReviewers({ reportsDir: normalizedReportsDir, reviewers });

  const {
    reviewerErrors,
  } = computeConsensus(reports, { reviewers });

  const priorLedger = readLedgerInput(priorLedgerJson);
  const canQueryGithubThreads =
    normalizeText(token) && normalizeText(repo) && normalizeText(prNumber);

  const merged = mergeLedgerWithReports({
    priorLedger,
    reports,
    reviewers,
    runId: normalizeText(runId) || "manual",
    timestamp: new Date().toISOString(),
  });

  let ledger = merged.ledger;

  const shouldPublishInlineComments = String(publishInlineComments ?? "true").toLowerCase() !== "false";
  const canUseGithub = canQueryGithubThreads && normalizeText(sha);
  if (shouldPublishInlineComments && canUseGithub) {
    ledger = await syncInlineFindingLifecycle({
      ledger,
      merged,
      token,
      repo,
      prNumber,
      headSha: sha,
      labelsByReviewerId,
      initialThreadMetadataByCommentId: new Map(),
      onNonFatalError: logNonFatalGithubError,
    });
  }

  const openEntries = toPresentationEntries(ledger.findings, "open");
  const resolvedEntries = toPresentationEntries(ledger.findings, "resolved");

  const { outcome, outcomeReason } = evaluateOutcome({
    reviewerErrorsCount: reviewerErrors.length,
    openFindingsCount: openEntries.length,
  });

  const failureReasons = renderFailureReasons({
    reviewerErrors,
    openEntries,
  });

  const commentBody = renderConsensusComment({
    marker,
    outcome,
    outcomeReason,
    openEntries,
    resolvedEntries,
    reviewerErrors,
    labelsByReviewerId,
  });

  ensureParentDir(normalizedCommentPath);
  ensureParentDir(normalizedLedgerPath);
  fs.writeFileSync(normalizedCommentPath, commentBody, "utf8");
  fs.writeFileSync(normalizedLedgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

  writeConsensusOutputs({
    outcome,
    outcomeReason,
    commentPath: normalizedCommentPath,
    ledgerPath: normalizedLedgerPath,
    openFindingsCount: openEntries.length,
    reviewerErrorsCount: reviewerErrors.length,
    reports,
    failureReasons,
  });

  return {
    outcome,
    outcomeReason,
    commentPath: normalizedCommentPath,
    ledgerPath: normalizedLedgerPath,
    openFindingsCount: openEntries.length,
    reviewerErrorsCount: reviewerErrors.length,
    reports,
    failureReasons,
  };
}

async function main() {
  await runConsensus({
    runId: process.env.GITHUB_RUN_ID || "",
    baseSha: process.env.BASE_SHA || "",
    sha: process.env.SHA || "",
    workspaceDir: process.env.WORKSPACE_DIR || process.cwd(),
    commentPath: process.env.COMMENT_PATH || "lgtm-comment.md",
    ledgerPath: process.env.LEDGER_PATH || "lgtm-findings-ledger.json",
    token: process.env.GITHUB_TOKEN || "",
    repo: process.env.GITHUB_REPOSITORY || "",
    prNumber: process.env.PR_NUMBER || "",
    marker: "<!-- lgtm-sticky-comment -->",
    reportsDir: process.env.REPORTS_DIR,
    reviewersJson: process.env.REVIEWERS_JSON || "[]",
    publishInlineComments: process.env.PUBLISH_INLINE_COMMENTS ?? "true",
    priorLedgerJson: process.env.PRIOR_LEDGER_JSON || "",
  });
}

function isCliMain() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCliMain()) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
