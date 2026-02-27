#!/usr/bin/env node

import { githubRequest } from "./github-client.mjs";
import { formatFindingBody } from "./finding-format.mjs";
import {
  buildInlineFindingMarker,
} from "./finding-comment-marker.mjs";

function parseRepository(repo) {
  const [owner, name] = String(repo || "").split("/");
  if (!owner || !name) return null;
  return { owner, name };
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeFindingLine(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function isLineBoundFinding(finding) {
  if (!finding || typeof finding !== "object") return false;
  const file = normalizeText(finding.file);
  const line = normalizeFindingLine(finding.line);
  return file.length > 0 && line > 0;
}

export function buildInlineCommentBody({ reviewerLabel, finding, signatureSecret }) {
  const baseBody = formatFindingBody({ reviewerLabel, finding });
  const marker = buildInlineFindingMarker({
    body: baseBody,
    secret: signatureSecret,
  });
  if (!marker) {
    return baseBody;
  }

  return `${baseBody}\n\n${marker}`;
}

export async function publishInlineFindingComments({
  token,
  signatureSecret,
  repo,
  prNumber,
  headSha,
  entries,
  labelsByReviewerId,
  request = githubRequest,
}) {
  const normalizedToken = normalizeText(token);
  const normalizedSignatureSecret = normalizeText(signatureSecret || normalizedToken);
  const normalizedRepo = normalizeText(repo);
  const normalizedPrNumber = normalizeText(prNumber);
  const normalizedHeadSha = normalizeText(headSha);
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  const labels =
    labelsByReviewerId instanceof Map
      ? labelsByReviewerId
      : new Map();

  if (!normalizedToken || !normalizedRepo || !normalizedPrNumber || !normalizedHeadSha) {
    return {
      attemptedCount: 0,
      postedCount: 0,
      failedCount: 0,
      failedEntries: [],
    };
  }

  const parsedRepo = parseRepository(normalizedRepo);
  if (!parsedRepo) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }

  const apiBase = `https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.name}`;
  const lineBoundEntries = normalizedEntries.filter((entry) => isLineBoundFinding(entry?.finding));
  let postedCount = 0;
  const failedEntries = [];

  for (const entry of lineBoundEntries) {
    const finding = entry.finding;
    const reviewer = normalizeText(entry.reviewer || "unknown");
    const reviewerLabel = normalizeText(labels.get(reviewer) || reviewer || "Unknown Reviewer");
    const body = buildInlineCommentBody({
      reviewerLabel,
      finding,
      signatureSecret: normalizedSignatureSecret,
    });

    const path = normalizeText(finding.file);
    const line = normalizeFindingLine(finding.line);

    try {
      await request({
        method: "POST",
        url: `${apiBase}/pulls/${normalizedPrNumber}/comments`,
        token: normalizedToken,
        body: {
          body,
          commit_id: normalizedHeadSha,
          path,
          line,
          side: "RIGHT",
        },
      });
      postedCount += 1;
    } catch (error) {
      failedEntries.push({
        ...entry,
        error: normalizeText(error?.message || "unknown inline comment error"),
      });
    }
  }

  return {
    attemptedCount: lineBoundEntries.length,
    postedCount,
    failedCount: failedEntries.length,
    failedEntries,
  };
}
