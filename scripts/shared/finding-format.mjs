#!/usr/bin/env node

import { normalizeFindingId } from "./finding-id.mjs";

function normalizeInline(value) {
  return String(value ?? "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function formatFindingHeadline({ reviewerLabel, finding }) {
  const findingId = normalizeInline(normalizeFindingId(finding?.id || ""));
  const title = normalizeInline(finding?.title || "Untitled finding");
  if (findingId) {
    return `**[${findingId}]** ${title}`;
  }
  const normalizedReviewerLabel = normalizeInline(reviewerLabel || "Unknown Reviewer");
  return `**${normalizedReviewerLabel}:** ${title}`;
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
