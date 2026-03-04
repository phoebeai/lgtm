#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  asBool,
  isNonEmptyString,
  isValidReviewerId,
  makeBasePayload,
  makeErrorPayload,
  normalizeReviewer,
  normalizeStructuredReviewerPayload,
} from "./shared/reviewer-core.mjs";
import { writeGithubOutput } from "./shared/github-output.mjs";

function extractCandidates(text) {
  if (typeof text !== "string") return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  const candidates = [trimmed];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fencePattern.exec(trimmed)) !== null) {
    if (match[1] && match[1].trim()) {
      candidates.push(match[1].trim());
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  // Codex CLI transcripts can include banner/progress text plus standalone JSON lines.
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      candidates.push(candidate);
    }
  }

  return [...new Set(candidates)];
}

export function parseObjectCandidate(text) {
  const candidates = extractCandidates(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function processReviewerOutput({
  reviewer,
  reviewerActive,
  reviewerHasInputs,
  promptStepOutcome,
  promptStepConclusion,
  promptSkipReason,
  rawOutput,
  stepOutcome,
  stepConclusion,
  stepError,
}) {
  const expectedReviewer = normalizeReviewer(reviewer, "");
  if (!isValidReviewerId(expectedReviewer)) {
    throw new Error("REVIEWER must match ^[a-z0-9_]+$");
  }

  const isActive = asBool(reviewerActive);
  const hasInputs =
    reviewerHasInputs === undefined || reviewerHasInputs === null || reviewerHasInputs === ""
      ? true
      : asBool(reviewerHasInputs);
  const normalizedPromptStepOutcome = String(promptStepOutcome || "success");
  const normalizedPromptStepConclusion = String(promptStepConclusion || "");
  const normalizedPromptSkipReason = String(promptSkipReason || "").trim();
  const normalizedRawOutput = String(rawOutput || "").trim();
  const normalizedStepOutcome = String(stepOutcome || "");
  const normalizedStepConclusion = String(stepConclusion || "");
  const normalizedStepError = String(stepError || "").trim();

  let payload;

  if (!isActive) {
    payload = makeBasePayload({
      reviewer: expectedReviewer,
      runState: "skipped",
      summary: "Skipped (no relevant changes)",
      resolvedFindingIds: [],
      newFindings: [],
      errors: [],
    });
  } else if (normalizedPromptStepOutcome !== "success") {
    const reasons = ["trusted reviewer input build failed"];
    if (isNonEmptyString(normalizedPromptStepOutcome)) {
      reasons.push(`prompt step outcome: ${normalizedPromptStepOutcome}`);
    }
    if (isNonEmptyString(normalizedPromptStepConclusion)) {
      reasons.push(`prompt step conclusion: ${normalizedPromptStepConclusion}`);
    }
    if (isNonEmptyString(normalizedPromptSkipReason)) {
      reasons.push(`prompt step note: ${normalizedPromptSkipReason}`);
    }
    payload = makeErrorPayload(expectedReviewer, reasons);
  } else if (!hasInputs) {
    const summary = isNonEmptyString(normalizedPromptSkipReason)
      ? `Skipped (${normalizedPromptSkipReason})`
      : "Skipped (no relevant changes)";
    payload = makeBasePayload({
      reviewer: expectedReviewer,
      runState: "skipped",
      summary,
      resolvedFindingIds: [],
      newFindings: [],
      errors: [],
    });
  } else if (!normalizedRawOutput) {
    const reasons = ["review output was empty"];
    if (isNonEmptyString(normalizedStepError)) {
      reasons.push(`review step error: ${normalizedStepError}`);
    }
    if (isNonEmptyString(normalizedStepOutcome)) {
      reasons.push(`review step outcome: ${normalizedStepOutcome}`);
    }
    if (isNonEmptyString(normalizedStepConclusion)) {
      reasons.push(`review step conclusion: ${normalizedStepConclusion}`);
    }
    payload = makeErrorPayload(expectedReviewer, reasons);
  } else {
    try {
      let parsed;
      try {
        parsed = JSON.parse(normalizedRawOutput);
      } catch (parseError) {
        parsed = parseObjectCandidate(normalizedRawOutput);
        if (!parsed) {
          throw parseError;
        }
      }
      payload = normalizeStructuredReviewerPayload(parsed, expectedReviewer);
    } catch (error) {
      const reasons = [`invalid review output: ${error.message}`];
      const compactOutput = normalizedRawOutput.replace(/\s+/g, " ").trim();
      const previewHead = compactOutput.slice(0, 800);
      const previewTail = compactOutput.slice(-800);
      if (previewHead) {
        reasons.push(`review output preview (head): ${previewHead}`);
      }
      if (previewTail && previewTail !== previewHead) {
        reasons.push(`review output preview (tail): ${previewTail}`);
      }
      if (isNonEmptyString(normalizedStepOutcome)) {
        reasons.push(`review step outcome: ${normalizedStepOutcome}`);
      }
      if (isNonEmptyString(normalizedStepConclusion)) {
        reasons.push(`review step conclusion: ${normalizedStepConclusion}`);
      }
      if (isNonEmptyString(normalizedStepError)) {
        reasons.push(`review step error: ${normalizedStepError}`);
      }
      payload = makeErrorPayload(expectedReviewer, reasons);
    }
  }

  return payload;
}

function main() {
  const payload = processReviewerOutput({
    reviewer: process.env.REVIEWER,
    reviewerActive: process.env.REVIEWER_ACTIVE,
    reviewerHasInputs: process.env.REVIEWER_HAS_INPUTS,
    promptStepOutcome: process.env.PROMPT_STEP_OUTCOME,
    promptStepConclusion: process.env.PROMPT_STEP_CONCLUSION,
    promptSkipReason: process.env.PROMPT_SKIP_REASON,
    rawOutput: process.env.RAW_OUTPUT,
    stepOutcome: process.env.REVIEW_STEP_OUTCOME,
    stepConclusion: process.env.REVIEW_STEP_CONCLUSION,
    stepError: process.env.REVIEW_STEP_ERROR,
  });

  const serialized = JSON.stringify(payload);
  writeGithubOutput("report_json", serialized);
  process.stdout.write(serialized);
}

function isCliMain() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCliMain()) {
  main();
}
