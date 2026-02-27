import test from "node:test";
import assert from "node:assert/strict";
import { computeConsensus } from "../shared/consensus-core.mjs";

function makeReport({ runState = "completed", findings = [] } = {}) {
  return {
    run_state: runState,
    findings,
  };
}

function makeReviewers() {
  return [
    { id: "security", required: true },
    { id: "test_quality", required: true },
    { id: "infrastructure", required: false },
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

test("passes when required reviewers report no blocking findings", () => {
  const reports = makeReports({
    security: makeReport({ findings: [{ title: "Minor issue", blocking: false }] }),
    test_quality: makeReport({ findings: [{ title: "Style nit", blocking: false }] }),
  });

  const result = computeConsensus(reports, { reviewers: makeReviewers() });
  assert.equal(result.outcome, "PASS");
  assert.equal(result.blockingFindings.length, 0);
  assert.equal(result.reviewerErrors.length, 0);
  assert.equal(result.failureReasons.length, 0);
});

test("fails when any required reviewer has blocking finding", () => {
  const reports = makeReports({
    security: makeReport({
      findings: [{ title: "SQL injection in login", blocking: true }],
    }),
  });

  const result = computeConsensus(reports, { reviewers: makeReviewers() });
  assert.equal(result.outcome, "FAIL");
  assert.equal(result.blockingFindings.length, 1);
  assert.ok(result.failureReasons.includes("security: blocking finding (SQL injection in login)"));
});

test("required reviewer errors fail consensus", () => {
  const reports = makeReports({
    test_quality: makeReport({ runState: "error" }),
  });

  const result = computeConsensus(reports, { reviewers: makeReviewers() });
  assert.equal(result.outcome, "FAIL");
  assert.deepEqual(result.reviewerErrors, ["test_quality: reviewer execution/output error"]);
});

test("optional reviewer blockers are non-gating", () => {
  const reports = makeReports({
    infrastructure: makeReport({ findings: [{ title: "Missing rollback", blocking: true }] }),
  });

  const result = computeConsensus(reports, { reviewers: makeReviewers() });
  assert.equal(result.outcome, "PASS");
  assert.equal(result.blockingFindings.length, 0);
  assert.equal(result.optionalBlockingFindings.length, 1);
  assert.deepEqual(result.optionalFailureReasons, ["infrastructure: non-blocking finding (Missing rollback)"]);
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
