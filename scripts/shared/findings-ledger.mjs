#!/usr/bin/env node

import {
  canNormalizeFindingId,
  formatFindingId,
  normalizeFindingId,
  parseFindingIdNumber,
} from "./finding-id.mjs";

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function normalizeLine(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function toIsoString(value) {
  const parsed = Date.parse(String(value || ""));
  if (Number.isNaN(parsed)) {
    return new Date().toISOString();
  }
  return new Date(parsed).toISOString();
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase() === "resolved" ? "resolved" : "open";
}

function defaultRecommendation(value) {
  const normalized = normalizeText(value);
  return normalized || "No recommendation provided.";
}

function createEmptyLedger() {
  return {
    version: 1,
    findings: [],
  };
}

function normalizeLedgerFinding(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`findings[${index}] must be an object`);
  }

  const id = normalizeFindingId(entry.id);
  const reviewer = normalizeText(entry.reviewer);
  const title = normalizeText(entry.title);
  if (!id || !reviewer || !title) {
    throw new Error(`findings[${index}] must include non-empty id, reviewer, and title`);
  }

  const status = normalizeStatus(entry.status);

  return {
    id,
    reviewer,
    status,
    title,
    recommendation: defaultRecommendation(entry.recommendation),
    file: normalizeText(entry.file) || null,
    line: normalizeLine(entry.line),
    created_run_id: normalizeText(entry.created_run_id),
    created_at: toIsoString(entry.created_at || new Date().toISOString()),
    updated_run_id: normalizeText(entry.updated_run_id),
    updated_at: toIsoString(entry.updated_at || entry.created_at || new Date().toISOString()),
    resolved_at:
      status === "resolved" && normalizeText(entry.resolved_at)
        ? toIsoString(entry.resolved_at)
        : status === "resolved"
          ? toIsoString(entry.updated_at || entry.created_at || new Date().toISOString())
          : null,
    inline_comment_id:
      Number.isInteger(entry.inline_comment_id) && entry.inline_comment_id > 0
        ? entry.inline_comment_id
        : null,
    inline_comment_url: normalizeText(entry.inline_comment_url),
    inline_thread_id: normalizeText(entry.inline_thread_id),
  };
}

export function normalizeLedger(rawLedger) {
  if (rawLedger === null || rawLedger === undefined || rawLedger === "") {
    return createEmptyLedger();
  }

  if (typeof rawLedger !== "object" || Array.isArray(rawLedger)) {
    throw new Error("ledger root must be an object");
  }

  if (!Array.isArray(rawLedger.findings)) {
    throw new Error("ledger must include findings array");
  }

  const ids = new Set();
  const findings = rawLedger.findings.map((entry, index) => {
    const normalized = normalizeLedgerFinding(entry, index);
    if (ids.has(normalized.id)) {
      throw new Error(`duplicate finding id in ledger: ${normalized.id}`);
    }
    ids.add(normalized.id);
    return normalized;
  });

  return {
    version: 1,
    findings,
  };
}

const KNOWN_PREFIXES = {
  security: "SEC",
  test_quality: "TQ",
  code_quality: "CQ",
  infrastructure: "INF",
};

export function buildFindingIdPrefix(reviewerId) {
  const normalized = normalizeText(reviewerId).toLowerCase();
  if (KNOWN_PREFIXES[normalized]) {
    return KNOWN_PREFIXES[normalized];
  }

  const tokens = normalized
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.length === 0) return "F";

  if (tokens.length === 1) {
    return tokens[0].slice(0, 3).toUpperCase();
  }

  return tokens
    .map((token) => token[0].toUpperCase())
    .join("")
    .slice(0, 4);
}

function findNextNumber(findings, reviewer) {
  const prefix = buildFindingIdPrefix(reviewer);
  let maxValue = 0;
  for (const finding of findings) {
    if (finding.reviewer !== reviewer) continue;
    const parsed = parseFindingIdNumber(finding.id, prefix);
    if (parsed > maxValue) {
      maxValue = parsed;
    }
  }
  return maxValue + 1;
}

function toPresentationEntry(entry) {
  return {
    reviewer: entry.reviewer,
    status: entry.status,
    finding: {
      id: entry.id,
      title: entry.title,
      recommendation: entry.recommendation,
      file: entry.file,
      line: entry.line,
    },
  };
}

function sortFindings(findings) {
  return [...findings].sort((left, right) => {
    const reviewerCompare = left.reviewer.localeCompare(right.reviewer);
    if (reviewerCompare !== 0) return reviewerCompare;

    return left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" });
  });
}

export function mergeLedgerWithReports({
  priorLedger,
  reports,
  reviewers,
  runId,
  timestamp,
}) {
  const normalizedLedger = normalizeLedger(priorLedger);
  const normalizedRunId = normalizeText(runId);
  const normalizedTimestamp = toIsoString(timestamp || new Date().toISOString());

  const findingsById = new Map(
    normalizedLedger.findings.map((entry) => [entry.id, { ...entry }]),
  );

  const newlyOpenedEntries = [];
  const reopenedEntries = [];
  const newlyResolvedEntries = [];

  for (const reviewer of reviewers || []) {
    const reviewerId = normalizeText(reviewer?.id);
    if (!reviewerId) continue;

    const report = reports?.[reviewerId];
    if (!report || report.run_state !== "completed") {
      continue;
    }

    const resolvedIds = new Set();
    for (const rawResolvedId of Array.isArray(report.resolved_finding_ids)
      ? report.resolved_finding_ids
      : []) {
      if (!canNormalizeFindingId(rawResolvedId)) {
        throw new Error(
          `${reviewerId}: resolved_finding_ids includes invalid finding id ${JSON.stringify(rawResolvedId)}`,
        );
      }
      resolvedIds.add(normalizeFindingId(rawResolvedId));
    }

    for (const resolvedId of resolvedIds) {
      const existing = findingsById.get(resolvedId);
      if (!existing || existing.reviewer !== reviewerId || existing.status !== "open") {
        continue;
      }

      existing.status = "resolved";
      existing.updated_run_id = normalizedRunId;
      existing.updated_at = normalizedTimestamp;
      existing.resolved_at = normalizedTimestamp;
      newlyResolvedEntries.push(toPresentationEntry(existing));
    }

    let nextNumber = findNextNumber([...findingsById.values()], reviewerId);
    const prefix = buildFindingIdPrefix(reviewerId);

    for (const rawFinding of report.new_findings || []) {
      if (!rawFinding || typeof rawFinding !== "object") {
        continue;
      }

      const title = normalizeText(rawFinding.title) || "Untitled finding";
      const recommendation = defaultRecommendation(rawFinding.recommendation);
      const file = normalizeText(rawFinding.file) || null;
      const line = normalizeLine(rawFinding.line);
      const rawReopenFindingId = rawFinding.reopen_finding_id;
      if (rawReopenFindingId !== null && rawReopenFindingId !== undefined && rawReopenFindingId !== "") {
        if (!canNormalizeFindingId(rawReopenFindingId)) {
          throw new Error(
            `${reviewerId}: reopen_finding_id must be a valid finding id (received ${JSON.stringify(rawReopenFindingId)})`,
          );
        }
      }
      const reopenFindingId = normalizeFindingId(rawReopenFindingId);

      if (reopenFindingId) {
        const existing = findingsById.get(reopenFindingId);
        if (!existing) {
          throw new Error(
            `${reviewerId}: reopen_finding_id ${reopenFindingId} does not exist in prior ledger`,
          );
        }
        if (existing.reviewer !== reviewerId) {
          throw new Error(
            `${reviewerId}: reopen_finding_id ${reopenFindingId} belongs to reviewer ${existing.reviewer}`,
          );
        }
        if (existing.status !== "resolved") {
          throw new Error(
            `${reviewerId}: reopen_finding_id ${reopenFindingId} must reference a resolved finding`,
          );
        }

        const wasResolved = existing.status === "resolved";
        existing.status = "open";
        existing.title = title;
        existing.recommendation = recommendation;
        existing.file = file;
        existing.line = line;
        existing.updated_run_id = normalizedRunId;
        existing.updated_at = normalizedTimestamp;
        existing.resolved_at = null;

        if (wasResolved) {
          const presentation = toPresentationEntry(existing);
          reopenedEntries.push(presentation);
          newlyOpenedEntries.push(presentation);
        }
        continue;
      }

      let newId = formatFindingId(prefix, nextNumber);
      while (findingsById.has(newId)) {
        nextNumber += 1;
        newId = formatFindingId(prefix, nextNumber);
      }

      const created = {
        id: newId,
        reviewer: reviewerId,
        status: "open",
        title,
        recommendation,
        file,
        line,
        created_run_id: normalizedRunId,
        created_at: normalizedTimestamp,
        updated_run_id: normalizedRunId,
        updated_at: normalizedTimestamp,
        resolved_at: null,
        inline_comment_id: null,
        inline_comment_url: "",
        inline_thread_id: "",
      };

      findingsById.set(newId, created);
      newlyOpenedEntries.push(toPresentationEntry(created));
      nextNumber += 1;
    }
  }

  const findings = sortFindings([...findingsById.values()]);
  const openEntries = findings
    .filter((entry) => entry.status === "open")
    .map((entry) => toPresentationEntry(entry));
  const resolvedEntries = findings
    .filter((entry) => entry.status === "resolved")
    .map((entry) => toPresentationEntry(entry));

  return {
    ledger: {
      version: 1,
      findings,
    },
    openEntries,
    resolvedEntries,
    newlyOpenedEntries,
    reopenedEntries,
    newlyResolvedEntries,
  };
}

export function applyInlineCommentMetadata({ ledger, entries }) {
  const normalizedLedger = normalizeLedger(ledger);
  const map = new Map(normalizedLedger.findings.map((finding) => [finding.id, { ...finding }]));

  for (const entry of Array.isArray(entries) ? entries : []) {
    const findingId = normalizeFindingId(entry?.finding?.id);
    if (!findingId || !map.has(findingId)) continue;
    const finding = map.get(findingId);

    if (Number.isInteger(entry.comment_id) && entry.comment_id > 0) {
      finding.inline_comment_id = entry.comment_id;
    }
    if (normalizeText(entry.comment_url)) {
      finding.inline_comment_url = normalizeText(entry.comment_url);
    }
    if (normalizeText(entry.inline_thread_id)) {
      finding.inline_thread_id = normalizeText(entry.inline_thread_id);
    }
  }

  return {
    version: 1,
    findings: sortFindings([...map.values()]),
  };
}
