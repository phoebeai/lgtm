#!/usr/bin/env node

import {
  canNormalizeFindingId,
  normalizeFindingId as normalizeFindingIdCanonical,
} from "./finding-id.mjs";

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

export function normalizeFindingId(value) {
  if (!isNonEmptyString(value)) return "";
  return normalizeFindingIdCanonical(value);
}

function normalizeFindingIdStrict(value, fieldLabel) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${fieldLabel} must be a non-empty string`);
  }
  if (!canNormalizeFindingId(value)) {
    throw new Error(`${fieldLabel} must be a valid finding id (for example SEC001)`);
  }
  return normalizeFindingIdCanonical(value);
}

export function makeBasePayload({
  reviewer,
  runState,
  summary,
  resolvedFindingIds = [],
  newFindings = [],
  errors,
}) {
  return {
    reviewer,
    run_state: runState,
    summary,
    resolved_finding_ids: resolvedFindingIds,
    new_findings: newFindings,
    errors: errors || [],
  };
}

export function makeErrorPayload(reviewer, reasons) {
  return makeBasePayload({
    reviewer,
    runState: "error",
    summary: "Reviewer output unavailable or invalid",
    resolvedFindingIds: [],
    newFindings: [],
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

function normalizeReopenFindingId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return normalizeFindingIdStrict(value, "reopen_finding_id");
}

export function normalizeNewFindingsStrict(rawFindings) {
  if (!Array.isArray(rawFindings)) {
    throw new Error("new_findings must be an array");
  }

  return rawFindings.map((finding, index) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error(`new finding at index ${index} is not an object`);
    }

    const title = firstNonEmptyStringByKeys(finding, FINDING_TITLE_KEYS);
    const recommendation = firstNonEmptyStringByKeys(finding, FINDING_RECOMMENDATION_KEYS);

    if (!title) {
      throw new Error(`new finding ${index} missing title`);
    }

    if (!recommendation) {
      throw new Error(`new finding ${index} missing recommendation`);
    }

    return {
      title,
      file: isNonEmptyString(finding.file) ? finding.file.trim() : null,
      line: normalizeLine(finding.line),
      recommendation,
      reopen_finding_id: normalizeReopenFindingId(finding.reopen_finding_id),
    };
  });
}

export function normalizeFindingLenient(finding) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    return {
      title: "Unparseable finding payload",
      file: null,
      line: null,
      recommendation: "Review this finding manually.",
      reopen_finding_id: null,
    };
  }

  return {
    title: firstNonEmptyStringByKeys(finding, FINDING_TITLE_KEYS) || "Untitled finding",
    file: isNonEmptyString(finding.file) ? finding.file.trim() : null,
    line: normalizeLine(finding.line),
    recommendation:
      firstNonEmptyStringByKeys(finding, FINDING_RECOMMENDATION_KEYS) || "No recommendation provided.",
    reopen_finding_id: normalizeFindingId(finding.reopen_finding_id) || null,
  };
}

function normalizeErrors(rawErrors) {
  return Array.isArray(rawErrors) ? rawErrors.filter((item) => typeof item === "string") : [];
}

export function normalizeResolvedFindingIdsStrict(rawIds) {
  if (!Array.isArray(rawIds)) {
    throw new Error("resolved_finding_ids must be an array");
  }

  const ids = [];
  for (let index = 0; index < rawIds.length; index += 1) {
    const normalized = normalizeFindingIdStrict(
      rawIds[index],
      `resolved_finding_ids[${index}]`,
    );
    ids.push(normalized);
  }

  return [...new Set(ids)];
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
    resolved_finding_ids: normalizeResolvedFindingIdsStrict(rawPayload.resolved_finding_ids),
    new_findings: normalizeNewFindingsStrict(rawPayload.new_findings),
    errors: normalizeErrors(rawPayload.errors),
  };
}

function makeMissingReportPayload(reviewer) {
  return {
    reviewer,
    run_state: "error",
    summary: "Reviewer output unavailable or invalid",
    resolved_finding_ids: [],
    new_findings: [],
    errors: ["missing reviewer report input"],
  };
}

function makeParseFailurePayload(reviewer, reason) {
  return {
    reviewer,
    run_state: "error",
    summary: "Reviewer output unavailable or invalid",
    resolved_finding_ids: [],
    new_findings: [],
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
  if (runState === "completed") {
    try {
      return normalizeStructuredReviewerPayload(
        {
          reviewer: parsed.reviewer,
          summary: parsed.summary,
          resolved_finding_ids: parsed.resolved_finding_ids,
          new_findings: parsed.new_findings,
          errors: parsed.errors,
        },
        expectedReviewer,
      );
    } catch (error) {
      return makeParseFailurePayload(
        expectedReviewer,
        `invalid completed reviewer report: ${error.message}`,
      );
    }
  }

  const newFindings = Array.isArray(parsed.new_findings)
    ? parsed.new_findings.map((finding) => normalizeFindingLenient(finding))
    : [];
  const resolvedFindingIds = Array.isArray(parsed.resolved_finding_ids)
    ? parsed.resolved_finding_ids
        .map((value) => normalizeFindingId(value))
        .filter(Boolean)
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
    resolved_finding_ids: [...new Set(resolvedFindingIds)],
    new_findings: newFindings,
    errors: normalizeErrors(parsed.errors),
  };
}
