#!/usr/bin/env node

function normalizeNewFindings(findings) {
  return Array.isArray(findings) ? findings : [];
}

export function computeConsensus(
  reports,
  {
    reviewers,
  } = {},
) {
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    throw new Error("computeConsensus requires a non-empty reviewers array");
  }

  const activeReviewers = reviewers.filter(
    (reviewer) => reports[reviewer.id]?.run_state !== "skipped",
  );

  const reviewerErrors = [];
  const reviewerNewFindings = [];

  for (const reviewer of activeReviewers) {
    const report = reports[reviewer.id] || {};

    if (report.run_state === "error") {
      reviewerErrors.push(`${reviewer.id}: reviewer execution/output error`);
      continue;
    }

    if (report.run_state !== "completed") {
      continue;
    }

    for (const finding of normalizeNewFindings(report.new_findings)) {
      reviewerNewFindings.push({ reviewer: reviewer.id, finding });
    }
  }

  const failureReasons = [...reviewerErrors];
  const outcome = reviewerErrors.length > 0 ? "FAIL" : "PASS";

  return {
    activeReviewers,
    reviewerErrors,
    reviewerNewFindings,
    failureReasons,
    outcome,
  };
}
