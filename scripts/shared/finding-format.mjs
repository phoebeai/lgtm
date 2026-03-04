#!/usr/bin/env node

function normalizeInline(value) {
  return String(value ?? "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function formatFindingHeadline({ reviewerLabel, finding }) {
  const normalizedReviewerLabel = normalizeInline(reviewerLabel || "Unknown Reviewer");
  const findingId = normalizeInline(finding?.id || "");
  const title = normalizeInline(finding?.title || "Untitled finding");
  const idSuffix = findingId ? ` [${findingId}]` : "";
  return `**${normalizedReviewerLabel}${idSuffix}:** ${title}`;
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
