#!/usr/bin/env node

import { writeGithubOutput } from "./github-output.mjs";

export function writeConsensusOutputs({
  outcome,
  commentPath,
  requiredBlockingFindingsCount,
  reviewerErrorsCount,
  reports,
  failureReasons,
}) {
  writeGithubOutput("outcome", outcome);
  writeGithubOutput("comment_path", commentPath);
  writeGithubOutput("blocking_findings_count", String(requiredBlockingFindingsCount));
  writeGithubOutput("reviewer_errors_count", String(reviewerErrorsCount));
  writeGithubOutput("reports_json", JSON.stringify(reports));
  writeGithubOutput("failure_reasons", JSON.stringify(failureReasons));
}
