#!/usr/bin/env node

import { isValidReviewerId } from "./reviewer-core.mjs";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseReviewerEntries(reviewersJson, { requireNonEmpty = true } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(reviewersJson || "[]"));
  } catch (error) {
    throw new Error(`Invalid REVIEWERS_JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("REVIEWERS_JSON must be a JSON array");
  }
  if (requireNonEmpty && parsed.length === 0) {
    throw new Error("REVIEWERS_JSON must contain at least one reviewer");
  }

  const ids = new Set();
  return parsed.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`REVIEWERS_JSON[${index}] must be an object`);
    }

    const id = String(entry.id || "").trim();
    if (!isValidReviewerId(id)) {
      throw new Error(`REVIEWERS_JSON[${index}].id must match ^[a-z0-9_]+$`);
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate reviewer id in REVIEWERS_JSON: ${id}`);
    }
    ids.add(id);

    return { entry, id, index };
  });
}

export function parseReviewersForRunner(reviewersJson) {
  return parseReviewerEntries(reviewersJson, { requireNonEmpty: true }).map(({ entry, id, index }) => {
    const label = `REVIEWERS_JSON[${index}]`;
    const promptFile = String(entry.prompt_file || "").trim();
    if (!promptFile) {
      throw new Error(`${label}.prompt_file must be a non-empty string`);
    }

    const scope = String(entry.scope || "").trim();
    if (!scope) {
      throw new Error(`${label}.scope must be a non-empty string`);
    }

    return {
      ...entry,
      id,
      prompt_file: promptFile,
      scope,
      paths_json:
        entry.paths_json === undefined || entry.paths_json === null
          ? "[]"
          : String(entry.paths_json),
    };
  });
}

export function parseReviewersForConsensus(reviewersJson) {
  return parseReviewerEntries(reviewersJson, { requireNonEmpty: true }).map(({ entry, id }) => {
    const displayName = String(entry.display_name || id).trim() || id;
    return {
      id,
      display_name: displayName,
    };
  });
}

export function parseReviewerIds(reviewersJson) {
  return parseReviewerEntries(reviewersJson, { requireNonEmpty: false }).map(({ id }) => id);
}
