#!/usr/bin/env node

import { githubRequest } from "./github-client.mjs";
import { formatFindingBody } from "./finding-format.mjs";

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

export function buildInlineCommentBody({ reviewerLabel, finding }) {
  return formatFindingBody({ reviewerLabel, finding });
}

export async function publishInlineFindingComments({
  token,
  repo,
  prNumber,
  headSha,
  entries,
  labelsByReviewerId,
  request = githubRequest,
}) {
  const normalizedToken = normalizeText(token);
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
      postedEntries: [],
      failedEntries: [],
    };
  }

  const parsedRepo = parseRepository(normalizedRepo);
  if (!parsedRepo) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }

  const apiBase = `https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.name}`;
  const lineBoundEntries = normalizedEntries.filter((entry) => isLineBoundFinding(entry?.finding));
  const postedEntries = [];
  const failedEntries = [];

  for (const entry of lineBoundEntries) {
    const finding = entry.finding;
    const reviewer = normalizeText(entry.reviewer || "unknown");
    const reviewerLabel = normalizeText(labels.get(reviewer) || reviewer || "Unknown Reviewer");
    const body = buildInlineCommentBody({
      reviewerLabel,
      finding,
    });

    const path = normalizeText(finding.file);
    const line = normalizeFindingLine(finding.line);

    try {
      const created = await request({
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

      postedEntries.push({
        ...entry,
        comment_id: Number.isInteger(created?.id) && created.id > 0 ? created.id : null,
        comment_url: normalizeText(created?.html_url || ""),
      });
    } catch (error) {
      failedEntries.push({
        ...entry,
        error: normalizeText(error?.message || "unknown inline comment error"),
      });
    }
  }

  return {
    attemptedCount: lineBoundEntries.length,
    postedCount: postedEntries.length,
    failedCount: failedEntries.length,
    postedEntries,
    failedEntries,
  };
}
