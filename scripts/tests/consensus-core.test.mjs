import test from "node:test";
import assert from "node:assert/strict";
import { computeConsensus } from "../shared/consensus-core.mjs";

function makeReport({ runState = "completed", newFindings = [] } = {}) {
  return {
    run_state: runState,
    new_findings: newFindings,
  };
}

function makeReviewers() {
  return [
    { id: "security" },
    { id: "test_quality" },
    { id: "infrastructure" },
  ];
}

function makeReports(overrides = {}) {
  return {
    security: makeReport(),
    test_quality: makeReport(),
    infrastructure: makeReport(),
    ...overrides,
  };
}

test("passes when active reviewers have no errors", () => {
  const reports = makeReports({
    security: makeReport({ newFindings: [{ title: "Minor issue" }] }),
    test_quality: makeReport({ newFindings: [{ title: "Style nit" }] }),
  });

  const result = computeConsensus(reports, { reviewers: makeReviewers() });
  assert.equal(result.outcome, "PASS");
  assert.equal(result.reviewerErrors.length, 0);
  assert.equal(result.reviewerNewFindings.length, 2);
  assert.equal(result.failureReasons.length, 0);
});

test("reviewer errors fail consensus", () => {
  const reports = makeReports({
    test_quality: makeReport({ runState: "error" }),
  });

  const result = computeConsensus(reports, { reviewers: makeReviewers() });
  assert.equal(result.outcome, "FAIL");
  assert.deepEqual(result.reviewerErrors, ["test_quality: reviewer execution/output error"]);
});

test("all skipped reviewers produce PASS", () => {
  const reports = makeReports({
    security: makeReport({ runState: "skipped" }),
    test_quality: makeReport({ runState: "skipped" }),
    infrastructure: makeReport({ runState: "skipped" }),
  });

  const result = computeConsensus(reports, { reviewers: makeReviewers() });
  assert.equal(result.outcome, "PASS");
  assert.deepEqual(result.activeReviewers, []);
});
