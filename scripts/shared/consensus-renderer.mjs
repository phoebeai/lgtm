#!/usr/bin/env node

import { formatFindingHeadline, formatFindingRecommendation } from "./finding-format.mjs";
import { parseReviewersForConsensus } from "./reviewers-json.mjs";

function sanitizeInline(value) {
  return String(value ?? "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function findingLocation(finding) {
  if (!finding || typeof finding !== "object") return "";
  const file =
    typeof finding.file === "string" && sanitizeInline(finding.file).length > 0
      ? sanitizeInline(finding.file)
      : "";
  if (!file) return "";
  if (Number.isInteger(finding.line) && finding.line > 0) {
    return `${file}:${finding.line}`;
  }
  return file;
}

function formatFinding(entry, labelsByReviewerId) {
  const finding = entry?.finding || {};
  const reviewer = sanitizeInline(entry?.reviewer || "unknown");
  const reviewerLabel = sanitizeInline(labelsByReviewerId.get(reviewer) || reviewer || "Unknown Reviewer");
  const headline = formatFindingHeadline({ reviewerLabel, finding });
  const recommendation = formatFindingRecommendation(finding);
  const location = findingLocation(finding);
  const locationText = location ? `\`${location}\`` : "`global / unknown location`";

  return [
    `- ${headline}`,
    `  Location: ${locationText}`,
    `  ${recommendation}`,
  ].join("\n");
}

function pushFindingsSection(lines, title, entries, labelsByReviewerId) {
  lines.push(`### ${title}`);
  if (entries.length === 0) {
    lines.push("- None");
    lines.push("");
    return;
  }

  for (const entry of entries) {
    lines.push(formatFinding(entry, labelsByReviewerId));
  }
  lines.push("");
}

function pushReviewerErrorsSection(lines, reviewerErrors) {
  if (reviewerErrors.length === 0) return;

  lines.push("### Reviewer Errors");
  for (const reason of reviewerErrors) {
    lines.push(`- ${sanitizeInline(reason)}`);
  }
  lines.push("");
}

function normalizeEntries(entries) {
  return Array.isArray(entries) ? entries : [];
}

function normalizeOutcomeReason(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (
    normalized === "PASS_NO_FINDINGS"
    || normalized === "FAIL_OPEN_FINDINGS"
    || normalized === "FAIL_REVIEWER_ERRORS"
  ) {
    return normalized;
  }
  return "FAIL_OPEN_FINDINGS";
}

function renderOutcomeSummary({ outcomeReason, openFindingsCount, reviewerErrorsCount }) {
  switch (normalizeOutcomeReason(outcomeReason)) {
    case "PASS_NO_FINDINGS":
      return "No open findings.";
    case "FAIL_REVIEWER_ERRORS":
      return `${reviewerErrorsCount} reviewer error${reviewerErrorsCount === 1 ? "" : "s"} detected.`;
    default:
      return `${openFindingsCount} open finding${openFindingsCount === 1 ? "" : "s"} detected.`;
  }
}

export function normalizeReviewers(reviewersJson) {
  return parseReviewersForConsensus(reviewersJson);
}

export function renderConsensusComment({
  marker,
  outcome,
  outcomeReason,
  openEntries,
  resolvedEntries,
  reviewerErrors,
  labelsByReviewerId,
}) {
  const normalizedOpenEntries = normalizeEntries(openEntries);
  const normalizedResolvedEntries = normalizeEntries(resolvedEntries);
  const normalizedReviewerErrors = Array.isArray(reviewerErrors) ? reviewerErrors : [];
  const normalizedLabelsByReviewerId = labelsByReviewerId instanceof Map ? labelsByReviewerId : new Map();

  const lines = [];
  lines.push(marker);

  if (String(outcome).toUpperCase() === "PASS") {
    lines.push("## ✅ LGTM");
  } else {
    lines.push("## ❌ LGTM");
  }

  lines.push(
    renderOutcomeSummary({
      outcomeReason,
      openFindingsCount: normalizedOpenEntries.length,
      reviewerErrorsCount: normalizedReviewerErrors.length,
    }),
  );
  lines.push("");

  pushReviewerErrorsSection(lines, normalizedReviewerErrors);
  pushFindingsSection(lines, "Open Findings", normalizedOpenEntries, normalizedLabelsByReviewerId);
  pushFindingsSection(lines, "Resolved Findings", normalizedResolvedEntries, normalizedLabelsByReviewerId);

  return lines.join("\n");
}
