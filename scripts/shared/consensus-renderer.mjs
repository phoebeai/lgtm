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

function formatFinding(entry, labelsByReviewerId) {
  const finding = entry?.finding || {};
  const reviewer = sanitizeInline(entry?.reviewer || "unknown");
  const reviewerLabel = sanitizeInline(labelsByReviewerId.get(reviewer) || reviewer || "Unknown Reviewer");
  const headline = formatFindingHeadline({ reviewerLabel, finding });
  const recommendation = formatFindingRecommendation(finding);
  const location = findingLocation(finding);
  const locationText = location ? `\`${location}\`` : "`global / unknown location`";
  const statusText = sanitizeInline(entry?.status || "open");

  return [
    `- ${headline}`,
    `  Status: ${statusText}`,
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
    || normalized === "PASS_HUMAN_BYPASS"
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
    case "PASS_HUMAN_BYPASS":
      return "Human approval bypass is active.";
    case "FAIL_REVIEWER_ERRORS":
      return `${reviewerErrorsCount} reviewer error${reviewerErrorsCount === 1 ? "" : "s"} detected.`;
    default:
      return `${openFindingsCount} open finding${openFindingsCount === 1 ? "" : "s"} detected.`;
  }
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
    };
  });
}

export function collectNewFindingsForReviewers({ reports, reviewers }) {
  const allFindings = [];
  for (const reviewer of reviewers) {
    const report = reports[reviewer.id];
    if (!report || report.run_state !== "completed") {
      continue;
    }

    for (const finding of report.new_findings || []) {
      allFindings.push({
        reviewer: reviewer.id,
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

  return {
    allFindings,
  };
}

export function renderConsensusComment({
  marker,
  outcome,
  outcomeReason,
  openEntries,
  resolvedEntries,
  reviewerErrors,
  labelsByReviewerId,
  humanBypass,
}) {
  const normalizedOpenEntries = normalizeEntries(openEntries);
  const normalizedResolvedEntries = normalizeEntries(resolvedEntries);
  const normalizedReviewerErrors = Array.isArray(reviewerErrors) ? reviewerErrors : [];
  const normalizedLabelsByReviewerId = labelsByReviewerId instanceof Map ? labelsByReviewerId : new Map();
  const normalizedHumanBypass = humanBypass && typeof humanBypass === "object" ? humanBypass : null;

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

  if (normalizedHumanBypass?.approved === true) {
    const approvers = Array.isArray(normalizedHumanBypass.approvers)
      ? normalizedHumanBypass.approvers.filter((item) => typeof item === "string" && item.trim().length > 0)
      : [];
    lines.push("### Human Bypass");
    if (approvers.length > 0) {
      lines.push(`- Approved by: ${approvers.join(", ")}`);
    } else {
      lines.push("- Approved by at least one non-bot reviewer on the latest head commit.");
    }
    lines.push("");
  }

  pushReviewerErrorsSection(lines, normalizedReviewerErrors);
  pushFindingsSection(lines, "Open Findings", normalizedOpenEntries, normalizedLabelsByReviewerId);
  pushFindingsSection(lines, "Resolved Findings", normalizedResolvedEntries, normalizedLabelsByReviewerId);

  return lines.join("\n");
}
