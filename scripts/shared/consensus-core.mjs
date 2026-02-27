#!/usr/bin/env node

function normalizeFindings(findings) {
  return Array.isArray(findings) ? findings : [];
}

function findingTitle(finding) {
  if (finding && typeof finding.title === "string" && finding.title.trim().length > 0) {
    return finding.title.trim();
  }
  return "untitled";
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
  const optionalReviewerErrors = [];
  const blockingFindings = [];
  const optionalBlockingFindings = [];

  for (const reviewer of activeReviewers) {
    const report = reports[reviewer.id] || {};
    const targetErrors = reviewer.required === false ? optionalReviewerErrors : reviewerErrors;
    const targetFindings = reviewer.required === false ? optionalBlockingFindings : blockingFindings;

    if (report.run_state === "error") {
      targetErrors.push(`${reviewer.id}: reviewer execution/output error`);
      continue;
    }

    for (const finding of normalizeFindings(report.findings)) {
      if (finding?.blocking === true) {
        targetFindings.push({ reviewer: reviewer.id, finding });
      }
    }
  }

  const failureReasons = [
    ...reviewerErrors,
    ...blockingFindings.map(({ reviewer, finding }) => {
      return `${reviewer}: blocking finding (${findingTitle(finding)})`;
    }),
  ];

  const optionalFailureReasons = [
    ...optionalReviewerErrors,
    ...optionalBlockingFindings.map(({ reviewer, finding }) => {
      return `${reviewer}: non-blocking finding (${findingTitle(finding)})`;
    }),
  ];

  const outcome = failureReasons.length > 0 ? "FAIL" : "PASS";

  return {
    activeReviewers,
    reviewerErrors,
    optionalReviewerErrors,
    blockingFindings,
    optionalBlockingFindings,
    failureReasons,
    optionalFailureReasons,
    outcome,
  };
}
