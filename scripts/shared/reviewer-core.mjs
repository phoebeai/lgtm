#!/usr/bin/env node

export const REVIEWER_ID_PATTERN = /^[a-z0-9_]+$/;

const VALID_RUN_STATES = new Set(["completed", "skipped", "error"]);
const FINDING_TITLE_KEYS = ["title", "message", "issue"];
const FINDING_RECOMMENDATION_KEYS = ["recommendation", "remediation", "description", "message"];

export function normalizeReviewer(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;

  if (REVIEWER_ID_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const canonical = trimmed.replace(/-/g, "_");
  if (REVIEWER_ID_PATTERN.test(canonical)) {
    return canonical;
  }

  return fallback;
}

export function isValidReviewerId(value) {
  return REVIEWER_ID_PATTERN.test(String(value || "").trim());
}

export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function asBool(value) {
  return String(value || "").toLowerCase() === "true";
}

export function makeBasePayload({ reviewer, runState, summary, findings = [], errors }) {
  return {
    reviewer,
    run_state: runState,
    summary,
    findings,
    errors: errors || [],
  };
}

export function makeErrorPayload(reviewer, reasons) {
  return makeBasePayload({
    reviewer,
    runState: "error",
    summary: "Reviewer output unavailable or invalid",
    findings: [],
    errors: reasons || [],
  });
}

function firstNonEmptyStringByKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  for (const key of keys) {
    if (isNonEmptyString(value[key])) {
      return value[key].trim();
    }
  }

  return "";
}

function normalizeBlockingStrict(value, index) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  throw new Error(`finding ${index} missing blocking boolean`);
}

function normalizeLine(value) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[1-9]\d*$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }
  }

  return null;
}

function normalizeBlockingLenient(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return false;
}

export function normalizeFindingsStrict(rawFindings) {
  if (!Array.isArray(rawFindings)) {
    throw new Error("findings must be an array");
  }

  return rawFindings.map((finding, index) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error(`finding at index ${index} is not an object`);
    }

    const title = firstNonEmptyStringByKeys(finding, FINDING_TITLE_KEYS);
    const recommendation = firstNonEmptyStringByKeys(finding, FINDING_RECOMMENDATION_KEYS);
    const blocking = normalizeBlockingStrict(finding.blocking, index);

    if (!title) {
      throw new Error(`finding ${index} missing title`);
    }

    if (!recommendation) {
      throw new Error(`finding ${index} missing recommendation`);
    }

    return {
      title,
      file: isNonEmptyString(finding.file) ? finding.file.trim() : null,
      line: normalizeLine(finding.line),
      recommendation,
      blocking,
    };
  });
}

export function normalizeFindingLenient(finding, index) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    return {
      title: "Unparseable finding payload",
      file: null,
      line: null,
      recommendation: "Review this finding manually.",
      blocking: false,
    };
  }

  return {
    title: firstNonEmptyStringByKeys(finding, FINDING_TITLE_KEYS) || "Untitled finding",
    file: isNonEmptyString(finding.file) ? finding.file.trim() : null,
    line: normalizeLine(finding.line),
    recommendation:
      firstNonEmptyStringByKeys(finding, FINDING_RECOMMENDATION_KEYS) || "No recommendation provided.",
    blocking: normalizeBlockingLenient(finding.blocking),
  };
}

function normalizeErrors(rawErrors) {
  return Array.isArray(rawErrors) ? rawErrors.filter((item) => typeof item === "string") : [];
}

export function normalizeStructuredReviewerPayload(rawPayload, expectedReviewer) {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    throw new Error("payload is not a JSON object");
  }

  const reviewer = normalizeReviewer(rawPayload.reviewer, expectedReviewer);
  if (!isValidReviewerId(reviewer)) {
    throw new Error("reviewer is required and must be a valid reviewer id");
  }

  if (!isNonEmptyString(rawPayload.summary)) {
    throw new Error("summary is required");
  }

  return {
    reviewer,
    run_state: "completed",
    summary: rawPayload.summary.trim(),
    findings: normalizeFindingsStrict(rawPayload.findings),
    errors: normalizeErrors(rawPayload.errors),
  };
}

function makeMissingReportPayload(reviewer) {
  return {
    reviewer,
    run_state: "error",
    summary: "Reviewer output unavailable or invalid",
    findings: [],
    errors: ["missing reviewer report input"],
  };
}

function makeParseFailurePayload(reviewer, reason) {
  return {
    reviewer,
    run_state: "error",
    summary: "Reviewer output unavailable or invalid",
    findings: [],
    errors: [reason],
  };
}

export function normalizePersistedReviewerReport(reviewer, raw) {
  const expectedReviewer = normalizeReviewer(reviewer, "") || String(reviewer || "").trim();

  if (!raw || !String(raw).trim()) {
    return makeMissingReportPayload(expectedReviewer);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return makeParseFailurePayload(expectedReviewer, `reviewer report parse failure: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return makeParseFailurePayload(expectedReviewer, "reviewer report parse failure: payload is not a JSON object");
  }

  const runState = VALID_RUN_STATES.has(parsed.run_state) ? parsed.run_state : "error";
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map((finding, index) => normalizeFindingLenient(finding, index))
    : [];

  let summary = "No summary provided.";
  if (isNonEmptyString(parsed.summary)) {
    summary = parsed.summary.trim();
  } else if (runState === "skipped") {
    summary = "Skipped (no relevant changes)";
  } else if (runState === "error") {
    summary = "Reviewer output unavailable or invalid";
  }

  return {
    reviewer: normalizeReviewer(parsed.reviewer, expectedReviewer),
    run_state: runState,
    summary,
    findings,
    errors: normalizeErrors(parsed.errors),
  };
}
