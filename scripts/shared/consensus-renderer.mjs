#!/usr/bin/env node

import { formatFindingHeadline, formatFindingRecommendation } from "./finding-format.mjs";

const REVIEWER_ID_PATTERN = /^[a-z0-9_]+$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function formatFinding(entry, labelsByReviewerId) {
  const finding = entry?.finding || {};
  const reviewer = sanitizeInline(entry?.reviewer || "unknown");
  const reviewerLabel = sanitizeInline(labelsByReviewerId.get(reviewer) || reviewer || "Unknown Reviewer");
  const headline = formatFindingHeadline({ reviewerLabel, finding });
  const recommendation = formatFindingRecommendation(finding);
  const location = findingLocation(finding);
  const locationText = location ? `\`${location}\`` : "`unknown location`";

  return [
    `- ${headline}`,
    `  Location: ${locationText}`,
    `  ${recommendation}`,
  ].join("\n");
}

function pushBlockingFindingsSection(lines, entries, labelsByReviewerId) {
  if (entries.length === 0) return;

  lines.push("### Blocking Issues");
  for (const entry of entries) {
    lines.push(formatFinding(entry, labelsByReviewerId));
  }
  lines.push("");
}

function pushBlockingReviewerErrorsSection(lines, reviewerErrors) {
  if (reviewerErrors.length === 0) return;

  lines.push("### Blocking Reviewer Errors");
  for (const reason of reviewerErrors) {
    lines.push(`- ${sanitizeInline(reason)}`);
  }
  lines.push("");
}

export function normalizeReviewers(reviewersJson) {
  let parsed;
  try {
    parsed = JSON.parse(String(reviewersJson || "[]"));
  } catch (error) {
    throw new Error(`Invalid REVIEWERS_JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("REVIEWERS_JSON must contain at least one reviewer");
  }

  const ids = new Set();
  return parsed.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`REVIEWERS_JSON[${index}] must be an object`);
    }

    const id = String(entry.id || "").trim();
    if (!REVIEWER_ID_PATTERN.test(id)) {
      throw new Error(`REVIEWERS_JSON[${index}].id must match ^[a-z0-9_]+$`);
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate reviewer id in REVIEWERS_JSON: ${id}`);
    }
    ids.add(id);

    const displayName = String(entry.display_name || id).trim() || id;
    return {
      id,
      display_name: displayName,
      required: entry.required !== false,
    };
  });
}

export function collectFindingsForReviewers({ reports, reviewers }) {
  const allFindings = [];
  for (const reviewer of reviewers) {
    const report = reports[reviewer.id];
    if (!report || report.run_state !== "completed") {
      continue;
    }

    for (const finding of report.findings) {
      allFindings.push({
        reviewer: reviewer.id,
        required: reviewer.required,
        finding,
      });
    }
  }

  allFindings.sort((a, b) => {
    const titleCompare = String(a.finding?.title || "").localeCompare(
      String(b.finding?.title || ""),
    );
    if (titleCompare !== 0) return titleCompare;

    const reviewerCompare = String(a.reviewer || "").localeCompare(String(b.reviewer || ""));
    if (reviewerCompare !== 0) return reviewerCompare;

    const fileCompare = String(a.finding?.file || "").localeCompare(String(b.finding?.file || ""));
    if (fileCompare !== 0) return fileCompare;

    return (a.finding?.line || 0) - (b.finding?.line || 0);
  });

  const blockingEntries = allFindings.filter(
    (entry) => entry.required && entry.finding?.blocking === true,
  );
  const nonBlockingEntries = allFindings.filter(
    (entry) => !(entry.required && entry.finding?.blocking === true),
  );

  return {
    allFindings,
    blockingEntries,
    nonBlockingEntries,
  };
}

export function renderConsensusComment({
  marker,
  outcome,
  blockingEntries,
  reviewerErrors,
  labelsByReviewerId,
}) {
  const normalizedBlockingEntries = Array.isArray(blockingEntries) ? blockingEntries : [];
  const normalizedReviewerErrors = Array.isArray(reviewerErrors) ? reviewerErrors : [];
  const normalizedLabelsByReviewerId = labelsByReviewerId instanceof Map ? labelsByReviewerId : new Map();
  const blockingIssueCount = normalizedBlockingEntries.length + normalizedReviewerErrors.length;

  const lines = [];
  lines.push(marker);

  if (outcome === "PASS") {
    lines.push("## ✅ LGTM");
    lines.push("No blocking issues found.");
  } else {
    lines.push("## ❌ LGTM");
    lines.push(`${blockingIssueCount} blocking ${pluralize(blockingIssueCount, "issue")} found.`);
  }
  lines.push("");

  pushBlockingReviewerErrorsSection(lines, normalizedReviewerErrors);
  pushBlockingFindingsSection(lines, normalizedBlockingEntries, normalizedLabelsByReviewerId);

  return lines.join("\n");
}
