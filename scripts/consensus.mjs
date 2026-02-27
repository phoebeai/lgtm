#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { computeConsensus } from "./shared/consensus-core.mjs";
import {
  collectFindingsForReviewers,
  normalizeReviewers,
  renderConsensusComment,
} from "./shared/consensus-renderer.mjs";
import {
  publishInlineFindingComments,
} from "./shared/inline-review-comments.mjs";
import { writeConsensusOutputs } from "./shared/consensus-output.mjs";
import { normalizePersistedReviewerReport } from "./shared/reviewer-core.mjs";

function readReportInput(reportsDir, reviewerId) {
  const reportPath = path.join(reportsDir, `${reviewerId}.json`);
  if (!fs.existsSync(reportPath)) {
    return "";
  }
  return fs.readFileSync(reportPath, "utf8");
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeFindingLine(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function parseFindingBody(body) {
  const normalizedBody = String(body ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalizedBody) return null;

  const lines = normalizedBody.split("\n");
  const headline = String(lines[0] || "").trim();
  const headlineMatch = headline.match(/^\*\*(.+?)\s+\((blocking|non-blocking)\):\*\*\s*(.+)$/i);
  if (!headlineMatch) return null;

  const reviewerLabel = normalizeText(headlineMatch[1]);
  const findingKind = String(headlineMatch[2] || "").toLowerCase();
  const title = normalizeText(headlineMatch[3]);
  const recommendation = normalizeText(lines.slice(1).join("\n"));

  return {
    reviewerLabel,
    blocking: findingKind === "blocking",
    title: title || "Untitled finding",
    recommendation: recommendation || "No recommendation provided.",
  };
}

function readPriorFindingsInput(priorFindingsJsonPath) {
  const normalizedPath = String(priorFindingsJsonPath || "").trim();
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return [];
  }

  const raw = fs.readFileSync(normalizedPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid PRIOR_FINDINGS_JSON payload: ${error.message}`);
  }
  return Array.isArray(parsed) ? parsed : [];
}

export function collectUnresolvedBlockingPriorEntries(priorFindings) {
  const entries = [];
  const normalizedPriorFindings = Array.isArray(priorFindings) ? priorFindings : [];

  for (const prior of normalizedPriorFindings) {
    if (!prior || typeof prior !== "object") continue;
    if (prior.resolved !== false) continue;

    const parsedBody = parseFindingBody(prior.body);
    if (!parsedBody || parsedBody.blocking !== true) continue;

    entries.push({
      reviewer: parsedBody.reviewerLabel || "Prior Finding",
      required: true,
      finding: {
        title: parsedBody.title,
        recommendation: parsedBody.recommendation,
        file: normalizeText(prior.path),
        line: normalizeFindingLine(prior.line),
        blocking: true,
      },
    });
  }

  return entries;
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

export async function runConsensus({
  sha,
  commentPath,
  token,
  signatureSecret,
  repo,
  prNumber,
  marker,
  reportsDir,
  reviewersJson,
  publishInlineComments,
  priorFindingsJson,
}) {
  const normalizedReportsDir = String(reportsDir || "").trim();
  if (!normalizedReportsDir) {
    throw new Error("REPORTS_DIR is required");
  }

  const reviewers = normalizeReviewers(reviewersJson || "[]");
  const labelsByReviewerId = new Map(reviewers.map((reviewer) => [reviewer.id, reviewer.display_name]));

  const reports = readReportsForReviewers({ reportsDir: normalizedReportsDir, reviewers });

  let {
    reviewerErrors,
    failureReasons,
  } = computeConsensus(reports, { reviewers });

  const {
    blockingEntries: reportBlockingEntries,
  } = collectFindingsForReviewers({ reports, reviewers });
  const priorFindings = readPriorFindingsInput(priorFindingsJson);
  const carryoverBlockingEntries = collectUnresolvedBlockingPriorEntries(priorFindings);
  const blockingEntriesAll = [...reportBlockingEntries, ...carryoverBlockingEntries];

  failureReasons = [
    ...failureReasons,
    ...carryoverBlockingEntries.map(({ finding }) => {
      return `prior-inline: unresolved blocking finding (${finding.title})`;
    }),
  ];
  const outcome = failureReasons.length > 0 ? "FAIL" : "PASS";

  const shouldPublishInlineComments = String(publishInlineComments ?? "true").toLowerCase() !== "false";
  if (shouldPublishInlineComments && token && repo && prNumber && sha) {
    await publishInlineFindingComments({
      token,
      signatureSecret,
      repo,
      prNumber,
      headSha: sha,
      entries: reportBlockingEntries,
      labelsByReviewerId,
    });
  }

  const commentBody = renderConsensusComment({
    marker,
    outcome,
    blockingEntries: blockingEntriesAll,
    reviewerErrors,
    labelsByReviewerId,
  });
  fs.writeFileSync(commentPath, commentBody, "utf8");

  writeConsensusOutputs({
    outcome,
    commentPath,
    requiredBlockingFindingsCount: blockingEntriesAll.length,
    reviewerErrorsCount: reviewerErrors.length,
    reports,
    failureReasons,
  });

  return {
    outcome,
    commentPath,
    requiredBlockingFindingsCount: blockingEntriesAll.length,
    reviewerErrorsCount: reviewerErrors.length,
    reports,
    failureReasons,
  };
}

async function main() {
  await runConsensus({
    sha: process.env.SHA || "",
    commentPath: process.env.COMMENT_PATH || "lgtm-comment.md",
    token: process.env.GITHUB_TOKEN || "",
    signatureSecret: process.env.FINDING_SIGNATURE_SECRET || process.env.GITHUB_TOKEN || "",
    repo: process.env.GITHUB_REPOSITORY || "",
    prNumber: process.env.PR_NUMBER || "",
    marker: process.env.MARKER || "<!-- codex-lgtm -->",
    reportsDir: process.env.REPORTS_DIR,
    reviewersJson: process.env.REVIEWERS_JSON || "[]",
    publishInlineComments: process.env.PUBLISH_INLINE_COMMENTS ?? "true",
    priorFindingsJson: process.env.PRIOR_FINDINGS_JSON || "",
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
