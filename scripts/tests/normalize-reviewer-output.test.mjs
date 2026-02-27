import test from "node:test";
import assert from "node:assert/strict";
import { processReviewerOutput } from "../normalize-reviewer-output.mjs";

function buildValidRawPayload(overrides = {}) {
  return JSON.stringify({
    reviewer: "security",
    run_state: "completed",
    summary: "No major issues.",
    findings: [
      {
        title: "Sample finding",
        recommendation: "Do the thing.",
        blocking: false,
      },
    ],
    errors: [],
    ...overrides,
  });
}

test("returns normalized payload for valid reviewer JSON", () => {
  const payload = processReviewerOutput({
    reviewer: "security",
    reviewerActive: "true",
    rawOutput: buildValidRawPayload(),
    stepOutcome: "success",
    stepConclusion: "success",
  });

  assert.equal(payload.reviewer, "security");
  assert.equal(payload.run_state, "completed");
  assert.equal(payload.findings.length, 1);
  assert.equal(payload.findings[0].file, null);
  assert.equal(payload.findings[0].line, null);
  assert.equal(payload.findings[0].blocking, false);
});

test("normalized findings always include nullable file and line keys", () => {
  const payload = processReviewerOutput({
    reviewer: "security",
    reviewerActive: "true",
    rawOutput: buildValidRawPayload({
      findings: [
        {
          title: "Missing location info",
          recommendation: "Keep shape stable.",
          blocking: false,
        },
        {
          title: "Explicit location info",
          file: "src/titaness/security.py",
          line: "21",
          recommendation: "Preserve parsed values.",
          blocking: false,
        },
      ],
    }),
    stepOutcome: "success",
    stepConclusion: "success",
  });

  assert.equal(payload.run_state, "completed");
  assert.equal(Object.hasOwn(payload.findings[0], "file"), true);
  assert.equal(Object.hasOwn(payload.findings[0], "line"), true);
  assert.equal(payload.findings[0].file, null);
  assert.equal(payload.findings[0].line, null);

  assert.equal(Object.hasOwn(payload.findings[1], "file"), true);
  assert.equal(Object.hasOwn(payload.findings[1], "line"), true);
  assert.equal(payload.findings[1].file, "src/titaness/security.py");
  assert.equal(payload.findings[1].line, 21);
});

test("returns error payload for invalid JSON", () => {
  const payload = processReviewerOutput({
    reviewer: "security",
    reviewerActive: "true",
    rawOutput: "{not-json",
    stepOutcome: "failure",
    stepConclusion: "failure",
  });

  assert.equal(payload.run_state, "error");
  assert.ok(payload.errors.some((error) => error.startsWith("invalid review output:")));
});

test("includes reviewer step error details when no output is returned", () => {
  const payload = processReviewerOutput({
    reviewer: "security",
    reviewerActive: "true",
    rawOutput: "",
    stepOutcome: "failure",
    stepConclusion: "failure",
    stepError: "review timed out after 120s",
  });

  assert.equal(payload.run_state, "error");
  assert.ok(payload.errors.includes("review step error: review timed out after 120s"));
  assert.ok(payload.errors.includes("review step outcome: failure"));
});

test("extracts JSON payload from fenced transcript text", () => {
  const payload = processReviewerOutput({
    reviewer: "security",
    reviewerActive: "true",
    rawOutput: [
      "Here is the review result:",
      "```json",
      buildValidRawPayload(),
      "```",
    ].join("\n"),
    stepOutcome: "failure",
    stepConclusion: "success",
  });

  assert.equal(payload.run_state, "completed");
  assert.equal(payload.reviewer, "security");
  assert.equal(payload.findings.length, 1);
});

test("extracts JSON payload from codex cli transcript lines", () => {
  const payload = processReviewerOutput({
    reviewer: "security",
    reviewerActive: "true",
    rawOutput: [
      "OpenAI Codex v0.105.0 (research preview)",
      "--------",
      "user",
      "Please review this PR",
      "codex",
      buildValidRawPayload(),
      "tokens used",
      "1234",
    ].join("\n"),
    stepOutcome: "failure",
    stepConclusion: "failure",
  });

  assert.equal(payload.run_state, "completed");
  assert.equal(payload.reviewer, "security");
  assert.equal(payload.findings.length, 1);
});

test("returns error payload with descriptive message for missing required fields", () => {
  const payload = processReviewerOutput({
    reviewer: "security",
    reviewerActive: "true",
    rawOutput: JSON.stringify({
      reviewer: "security",
      summary: "No major issues.",
    }),
    stepOutcome: "failure",
    stepConclusion: "failure",
  });

  assert.equal(payload.run_state, "error");
  assert.ok(payload.errors.some((error) => error.includes("findings must be an array")));
});

test("normalizes reviewer aliases", () => {
  const payload = processReviewerOutput({
    reviewer: "test_quality",
    reviewerActive: "true",
    rawOutput: buildValidRawPayload({ reviewer: "test-quality" }),
    stepOutcome: "success",
    stepConclusion: "success",
  });

  assert.equal(payload.reviewer, "test_quality");
});

test("returns skipped payload when reviewer is inactive", () => {
  const payload = processReviewerOutput({
    reviewer: "security",
    reviewerActive: "false",
    rawOutput: "",
    stepOutcome: "",
    stepConclusion: "",
  });

  assert.equal(payload.run_state, "skipped");
  assert.equal(payload.summary, "Skipped (no relevant changes)");
  assert.deepEqual(payload.findings, []);
});

test("returns error payload when trusted input build fails for an active reviewer", () => {
  const payload = processReviewerOutput({
    reviewer: "security",
    reviewerActive: "true",
    reviewerHasInputs: "",
    promptStepOutcome: "failure",
    promptStepConclusion: "failure",
    promptSkipReason: "Changed path contains control characters",
    rawOutput: "",
    stepOutcome: "",
    stepConclusion: "",
  });

  assert.equal(payload.run_state, "error");
  assert.ok(payload.errors.includes("trusted reviewer input build failed"));
  assert.ok(payload.errors.includes("prompt step outcome: failure"));
});

test("returns skipped payload with prompt reason when reviewer has no scoped inputs", () => {
  const payload = processReviewerOutput({
    reviewer: "security",
    reviewerActive: "true",
    reviewerHasInputs: "false",
    promptStepOutcome: "success",
    promptStepConclusion: "success",
    promptSkipReason: "No changed files detected for base...head",
    rawOutput: "",
    stepOutcome: "",
    stepConclusion: "",
  });

  assert.equal(payload.run_state, "skipped");
  assert.equal(payload.summary, "Skipped (No changed files detected for base...head)");
});

test("finding without blocking boolean yields error payload", () => {
  const payload = processReviewerOutput({
    reviewer: "security",
    reviewerActive: "true",
    rawOutput: buildValidRawPayload({
      findings: [
        {
          title: "Missing blocking flag",
          recommendation: "Set blocking explicitly.",
        },
      ],
    }),
    stepOutcome: "failure",
    stepConclusion: "failure",
  });

  assert.equal(payload.run_state, "error");
  assert.ok(payload.errors.some((error) => error.includes("missing blocking boolean")));
});

test("finding without id field is accepted normally", () => {
  const payload = processReviewerOutput({
    reviewer: "security",
    reviewerActive: "true",
    rawOutput: buildValidRawPayload({
      findings: [
        {
          title: "Finding without id",
          recommendation: "No id field needed.",
          blocking: true,
        },
      ],
    }),
    stepOutcome: "success",
    stepConclusion: "success",
  });

  assert.equal(payload.run_state, "completed");
  assert.equal(payload.findings.length, 1);
  assert.equal(Object.hasOwn(payload.findings[0], "id"), false);
  assert.equal(payload.findings[0].blocking, true);
});

test("transcript-style finding fields are normalized via aliases", () => {
  const payload = processReviewerOutput({
    reviewer: "security",
    reviewerActive: "true",
    rawOutput: JSON.stringify({
      reviewer: "security",
      summary: "Recovered from transcript",
      findings: [
        {
          message: "Missing id/title/recommendation keys",
          description: "Use description as recommendation fallback.",
          blocking: true,
          file: "src/titaness/chat/stream.py",
          line: "222",
        },
      ],
    }),
    stepOutcome: "failure",
    stepConclusion: "success",
  });

  assert.equal(payload.run_state, "completed");
  assert.equal(payload.findings.length, 1);
  assert.equal(Object.hasOwn(payload.findings[0], "id"), false);
  assert.equal(payload.findings[0].title, "Missing id/title/recommendation keys");
  assert.equal(payload.findings[0].recommendation, "Use description as recommendation fallback.");
  assert.equal(payload.findings[0].line, 222);
});
