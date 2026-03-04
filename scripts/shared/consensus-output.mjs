#!/usr/bin/env node

import { writeGithubOutput } from "./github-output.mjs";

export function writeConsensusOutputs({
  outcome,
  outcomeReason,
  commentPath,
  ledgerPath,
  openFindingsCount,
  reviewerErrorsCount,
  reports,
  failureReasons,
  humanBypassApproved,
}) {
  writeGithubOutput("outcome", outcome);
  writeGithubOutput("outcome_reason", outcomeReason);
  writeGithubOutput("comment_path", commentPath);
  writeGithubOutput("ledger_path", ledgerPath);
  writeGithubOutput("open_findings_count", String(openFindingsCount));
  writeGithubOutput("reviewer_errors_count", String(reviewerErrorsCount));
  writeGithubOutput("reports_json", JSON.stringify(reports));
  writeGithubOutput("failure_reasons", JSON.stringify(failureReasons));
  writeGithubOutput("human_bypass_approved", humanBypassApproved ? "true" : "false");

  // Backward-compat output name retained for callers/tests still expecting it.
  writeGithubOutput("blocking_findings_count", String(openFindingsCount));
}
