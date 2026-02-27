#!/usr/bin/env node

function normalizeInline(value) {
  return String(value ?? "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeFindingKind(blocking) {
  return blocking === false ? "non-blocking" : "blocking";
}

export function formatFindingHeadline({ reviewerLabel, finding }) {
  const normalizedReviewerLabel = normalizeInline(reviewerLabel || "Unknown Reviewer");
  const title = normalizeInline(finding?.title || "Untitled finding");
  const findingKind = normalizeFindingKind(finding?.blocking);
  return `**${normalizedReviewerLabel} (${findingKind}):** ${title}`;
}

export function formatFindingRecommendation(finding) {
  return normalizeInline(finding?.recommendation || "No recommendation provided.");
}

export function formatFindingBody({ reviewerLabel, finding }) {
  return [
    formatFindingHeadline({ reviewerLabel, finding }),
    "",
    formatFindingRecommendation(finding),
  ].join("\n");
}
