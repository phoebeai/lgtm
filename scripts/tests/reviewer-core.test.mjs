import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFindingLenient,
  normalizeFindingsStrict,
  normalizePersistedReviewerReport,
  normalizeStructuredReviewerPayload,
} from "../shared/reviewer-core.mjs";

function buildFinding(overrides = {}) {
  return {
    title: "Example finding",
    recommendation: "Fix the issue.",
    blocking: true,
    ...overrides,
  };
}

test("normalizeFindingsStrict accepts optional fields", () => {
  const findings = normalizeFindingsStrict([
    buildFinding({
      file: "a.js",
      line: 42,
    }),
    buildFinding({
      blocking: false,
      file: "   ",
      line: 0,
    }),
  ]);

  assert.equal(findings.length, 2);
  assert.equal(findings[0].file, "a.js");
  assert.equal(findings[0].line, 42);
  assert.equal(findings[1].file, null);
  assert.equal(findings[1].line, null);
});

test("normalizeFindingsStrict throws on malformed finding object", () => {
  assert.throws(
    () => normalizeFindingsStrict([null]),
    /finding at index 0 is not an object/,
  );
});

test("normalizeFindingsStrict accepts transcript-style aliases", () => {
  const findings = normalizeFindingsStrict([
    {
      message: "Fallback message title",
      description: "Use this as recommendation when missing recommendation key.",
      blocking: "true",
      file: "  src/service.ts ",
      line: "17",
    },
    {
      title: "Already has title",
      remediation: "Use remediation field as recommendation.",
      blocking: false,
      line: 4,
    },
  ]);

  assert.equal(findings.length, 2);
  assert.equal(findings[0].title, "Fallback message title");
  assert.equal(findings[0].recommendation, "Use this as recommendation when missing recommendation key.");
  assert.equal(findings[0].blocking, true);
  assert.equal(findings[0].file, "src/service.ts");
  assert.equal(findings[0].line, 17);
  assert.equal(findings[1].recommendation, "Use remediation field as recommendation.");
});

test("normalizeFindingsStrict does not include id field", () => {
  const findings = normalizeFindingsStrict([
    buildFinding({
      blocking: false,
    }),
  ]);

  assert.equal(findings.length, 1);
  assert.equal(Object.hasOwn(findings[0], "id"), false);
  assert.equal(findings[0].blocking, false);
});

test("normalizeFindingLenient degrades malformed finding payload", () => {
  const finding = normalizeFindingLenient("not-an-object", 0);

  assert.deepEqual(finding, {
    title: "Unparseable finding payload",
    file: null,
    line: null,
    recommendation: "Review this finding manually.",
    blocking: false,
  });
});

test("normalizeFindingLenient fills defaults and coerces invalid fields", () => {
  const finding = normalizeFindingLenient(
    {
      title: "",
      recommendation: "",
      blocking: "true",
      file: "b.js",
      line: -9,
    },
    2,
  );

  assert.equal(Object.hasOwn(finding, "id"), false);
  assert.equal(finding.title, "Untitled finding");
  assert.equal(finding.recommendation, "No recommendation provided.");
  assert.equal(finding.blocking, true);
  assert.equal(finding.file, "b.js");
  assert.equal(finding.line, null);
});

test("normalizeStructuredReviewerPayload is strict and trims summary", () => {
  const payload = normalizeStructuredReviewerPayload(
    {
      reviewer: "test-quality",
      summary: "  Looks good.  ",
      findings: [buildFinding({ blocking: false })],
      errors: [123, "kept"],
    },
    "test_quality",
  );

  assert.equal(payload.reviewer, "test_quality");
  assert.equal(payload.run_state, "completed");
  assert.equal(payload.summary, "Looks good.");
  assert.deepEqual(payload.errors, ["kept"]);
  assert.equal(Object.hasOwn(payload.findings[0], "id"), false);
});

test("normalizeStructuredReviewerPayload throws when required fields are missing", () => {
  assert.throws(
    () =>
      normalizeStructuredReviewerPayload(
        {
          reviewer: "security",
          findings: [],
        },
        "security",
      ),
    /summary is required/,
  );
});

test("normalizePersistedReviewerReport returns missing-input error payload", () => {
  const payload = normalizePersistedReviewerReport("security", "");

  assert.equal(payload.reviewer, "security");
  assert.equal(payload.run_state, "error");
  assert.equal(payload.summary, "Reviewer output unavailable or invalid");
  assert.deepEqual(payload.findings, []);
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
      findings: [
        {
          id: "",
          title: "",
          recommendation: "",
          blocking: "true",
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
  assert.equal(payload.findings.length, 2);
  assert.equal(Object.hasOwn(payload.findings[0], "id"), false);
  assert.equal(payload.findings[0].blocking, true);
  assert.equal(payload.findings[0].file, "review.js");
  assert.equal(payload.findings[0].line, 15);
  assert.equal(Object.hasOwn(payload.findings[1], "id"), false);
  assert.deepEqual(payload.errors, ["keep me"]);
});

test("normalizePersistedReviewerReport applies skipped summary fallback", () => {
  const payload = normalizePersistedReviewerReport(
    "infrastructure",
    JSON.stringify({
      reviewer: "infrastructure",
      run_state: "skipped",
      summary: "  ",
      findings: [],
      errors: [],
    }),
  );

  assert.equal(payload.run_state, "skipped");
  assert.equal(payload.summary, "Skipped (no relevant changes)");
});
