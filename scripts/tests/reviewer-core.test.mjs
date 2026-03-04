import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFindingLenient,
  normalizeNewFindingsStrict,
  normalizePersistedReviewerReport,
  normalizeResolvedFindingIdsStrict,
  normalizeStructuredReviewerPayload,
} from "../shared/reviewer-core.mjs";

function buildNewFinding(overrides = {}) {
  return {
    title: "Example finding",
    recommendation: "Fix the issue.",
    ...overrides,
  };
}

test("normalizeNewFindingsStrict accepts optional fields", () => {
  const findings = normalizeNewFindingsStrict([
    buildNewFinding({
      file: "a.js",
      line: 42,
    }),
    buildNewFinding({
      file: "   ",
      line: 0,
      reopen_finding_id: "sec-2",
    }),
  ]);

  assert.equal(findings.length, 2);
  assert.equal(findings[0].file, "a.js");
  assert.equal(findings[0].line, 42);
  assert.equal(findings[0].reopen_finding_id, null);
  assert.equal(findings[1].file, null);
  assert.equal(findings[1].line, null);
  assert.equal(findings[1].reopen_finding_id, "SEC002");
});

test("normalizeNewFindingsStrict throws on malformed new finding object", () => {
  assert.throws(
    () => normalizeNewFindingsStrict([null]),
    /new finding at index 0 is not an object/,
  );
});

test("normalizeNewFindingsStrict accepts transcript-style aliases", () => {
  const findings = normalizeNewFindingsStrict([
    {
      message: "Fallback message title",
      description: "Use this as recommendation when missing recommendation key.",
      file: "  src/service.ts ",
      line: "17",
    },
    {
      title: "Already has title",
      remediation: "Use remediation field as recommendation.",
      line: 4,
    },
  ]);

  assert.equal(findings.length, 2);
  assert.equal(findings[0].title, "Fallback message title");
  assert.equal(findings[0].recommendation, "Use this as recommendation when missing recommendation key.");
  assert.equal(findings[0].file, "src/service.ts");
  assert.equal(findings[0].line, 17);
  assert.equal(findings[1].recommendation, "Use remediation field as recommendation.");
});

test("normalizeResolvedFindingIdsStrict normalizes and deduplicates ids", () => {
  const ids = normalizeResolvedFindingIdsStrict(["sec-1", " SEC001 ", "TQ002"]);
  assert.deepEqual(ids, ["SEC001", "TQ002"]);
});

test("normalizeResolvedFindingIdsStrict rejects malformed ids", () => {
  assert.throws(
    () => normalizeResolvedFindingIdsStrict(["SEC-ABC"]),
    /resolved_finding_ids\[0\] must be a valid finding id/,
  );
});

test("normalizeFindingLenient degrades malformed finding payload", () => {
  const finding = normalizeFindingLenient("not-an-object", 0);

  assert.deepEqual(finding, {
    title: "Unparseable finding payload",
    file: null,
    line: null,
    recommendation: "Review this finding manually.",
    reopen_finding_id: null,
  });
});

test("normalizeFindingLenient fills defaults and coerces invalid fields", () => {
  const finding = normalizeFindingLenient(
    {
      title: "",
      recommendation: "",
      file: "b.js",
      line: -9,
      reopen_finding_id: " sec-3 ",
    },
    2,
  );

  assert.equal(finding.title, "Untitled finding");
  assert.equal(finding.recommendation, "No recommendation provided.");
  assert.equal(finding.file, "b.js");
  assert.equal(finding.line, null);
  assert.equal(finding.reopen_finding_id, "SEC003");
});

test("normalizeStructuredReviewerPayload is strict and trims summary", () => {
  const payload = normalizeStructuredReviewerPayload(
    {
      reviewer: "test-quality",
      summary: "  Looks good.  ",
      resolved_finding_ids: ["sec-1"],
      new_findings: [buildNewFinding({ file: "a.js", line: 1 })],
      errors: [123, "kept"],
    },
    "test_quality",
  );

  assert.equal(payload.reviewer, "test_quality");
  assert.equal(payload.run_state, "completed");
  assert.equal(payload.summary, "Looks good.");
  assert.deepEqual(payload.resolved_finding_ids, ["SEC001"]);
  assert.equal(payload.new_findings.length, 1);
  assert.deepEqual(payload.errors, ["kept"]);
});

test("normalizeStructuredReviewerPayload throws when required fields are missing", () => {
  assert.throws(
    () =>
      normalizeStructuredReviewerPayload(
        {
          reviewer: "security",
          new_findings: [],
          resolved_finding_ids: [],
        },
        "security",
      ),
    /summary is required/,
  );
});

test("normalizeStructuredReviewerPayload rejects malformed reopen_finding_id", () => {
  assert.throws(
    () =>
      normalizeStructuredReviewerPayload(
        {
          reviewer: "security",
          summary: "Has malformed reopen id",
          resolved_finding_ids: [],
          new_findings: [
            buildNewFinding({
              reopen_finding_id: "SEC-ABC",
            }),
          ],
          errors: [],
        },
        "security",
      ),
    /reopen_finding_id must be a valid finding id/,
  );
});

test("normalizePersistedReviewerReport returns missing-input error payload", () => {
  const payload = normalizePersistedReviewerReport("security", "");

  assert.equal(payload.reviewer, "security");
  assert.equal(payload.run_state, "error");
  assert.equal(payload.summary, "Reviewer output unavailable or invalid");
  assert.deepEqual(payload.new_findings, []);
  assert.deepEqual(payload.resolved_finding_ids, []);
  assert.deepEqual(payload.errors, ["missing reviewer report input"]);
});

test("normalizePersistedReviewerReport handles parse failure", () => {
  const payload = normalizePersistedReviewerReport("security", "{bad json");

  assert.equal(payload.reviewer, "security");
  assert.equal(payload.run_state, "error");
  assert.ok(payload.errors[0].startsWith("reviewer report parse failure:"));
});

test("normalizePersistedReviewerReport leniently normalizes malformed payload", () => {
  const payload = normalizePersistedReviewerReport(
    "security",
    JSON.stringify({
      reviewer: "test-quality",
      run_state: "not-a-state",
      summary: "",
      resolved_finding_ids: ["sec-1", "", 77],
      new_findings: [
        {
          title: "",
          recommendation: "",
          file: "review.js",
          line: "15",
        },
        null,
      ],
      errors: ["keep me", 99],
    }),
  );

  assert.equal(payload.reviewer, "test_quality");
  assert.equal(payload.run_state, "error");
  assert.equal(payload.summary, "Reviewer output unavailable or invalid");
  assert.equal(payload.new_findings.length, 2);
  assert.equal(payload.new_findings[0].file, "review.js");
  assert.equal(payload.new_findings[0].line, 15);
  assert.deepEqual(payload.resolved_finding_ids, ["SEC001"]);
  assert.deepEqual(payload.errors, ["keep me"]);
});

test("normalizePersistedReviewerReport marks malformed completed payload as error", () => {
  const payload = normalizePersistedReviewerReport(
    "security",
    JSON.stringify({
      reviewer: "security",
      run_state: "completed",
      summary: "Invalid IDs",
      resolved_finding_ids: ["SEC-ABC"],
      new_findings: [],
      errors: [],
    }),
  );

  assert.equal(payload.reviewer, "security");
  assert.equal(payload.run_state, "error");
  assert.ok(
    payload.errors.some((error) => error.includes("invalid completed reviewer report")),
  );
});

test("normalizePersistedReviewerReport applies skipped summary fallback", () => {
  const payload = normalizePersistedReviewerReport(
    "infrastructure",
    JSON.stringify({
      reviewer: "infrastructure",
      run_state: "skipped",
      summary: "  ",
      resolved_finding_ids: [],
      new_findings: [],
      errors: [],
    }),
  );

  assert.equal(payload.run_state, "skipped");
  assert.equal(payload.summary, "Skipped (no relevant changes)");
});
