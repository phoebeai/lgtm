#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { computeConsensus } from "./shared/consensus-core.mjs";
import {
  normalizeReviewers,
  renderConsensusComment,
} from "./shared/consensus-renderer.mjs";
import {
  publishInlineFindingComments,
  buildInlineCommentBody,
  isLineBoundFinding,
} from "./shared/inline-review-comments.mjs";
import { writeConsensusOutputs } from "./shared/consensus-output.mjs";
import { normalizePersistedReviewerReport } from "./shared/reviewer-core.mjs";
import {
  applyInlineCommentMetadata,
  mergeLedgerWithReports,
  normalizeLedger,
} from "./shared/findings-ledger.mjs";
import {
  githubGraphqlRequest,
  githubRequest,
  githubRequestAllPages,
} from "./shared/github-client.mjs";

const RESOLVE_REVIEW_THREAD_MUTATION = `
  mutation ResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

const UNRESOLVE_REVIEW_THREAD_MUTATION = `
  mutation UnresolveReviewThread($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function parseRepository(repo) {
  const [owner, name] = String(repo || "").split("/");
  if (!owner || !name) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }
  return { owner, name };
}

function parsePullNumber(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("PR_NUMBER must be a positive integer");
  }
  return parsed;
}

function readReportInput(reportsDir, reviewerId) {
  const reportPath = path.join(reportsDir, `${reviewerId}.json`);
  if (!fs.existsSync(reportPath)) {
    return "";
  }
  return fs.readFileSync(reportPath, "utf8");
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function logNonFatalGithubError(context, error) {
  const message = normalizeText(error?.message || "unknown github api error");
  process.stderr.write(`[consensus] non-fatal ${context} error: ${message}\n`);
}

function readLedgerInput(priorLedgerJsonPath) {
  const normalizedPath = normalizeText(priorLedgerJsonPath);
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return normalizeLedger(null);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
    return normalizeLedger(parsed);
  } catch {
    return normalizeLedger(null);
  }
}

function renderFailureReasons({ reviewerErrors, openEntries }) {
  const reasons = Array.isArray(reviewerErrors) ? [...reviewerErrors] : [];
  for (const entry of Array.isArray(openEntries) ? openEntries : []) {
    const finding = entry?.finding || {};
    const id = normalizeText(finding.id);
    const title = normalizeText(finding.title) || "Untitled finding";
    reasons.push(`open-finding: ${id ? `[${id}] ` : ""}${title}`);
  }
  return reasons;
}

function toPresentationEntries(ledgerFindings, status) {
  return ledgerFindings
    .filter((entry) => entry.status === status)
    .map((entry) => ({
      reviewer: entry.reviewer,
      status: entry.status,
      finding: {
        id: entry.id,
        title: entry.title,
        recommendation: entry.recommendation,
        file: entry.file,
        line: entry.line,
      },
    }));
}

function findingToCommentShape(finding) {
  return {
    id: normalizeText(finding?.id),
    title: normalizeText(finding?.title) || "Untitled finding",
    recommendation: normalizeText(finding?.recommendation) || "No recommendation provided.",
    file: normalizeText(finding?.file) || null,
    line: Number.isInteger(finding?.line) && finding.line > 0 ? finding.line : null,
  };
}

export function readReportsForReviewers({ reportsDir, reviewers }) {
  const reports = {};
  for (const reviewer of reviewers) {
    reports[reviewer.id] = normalizePersistedReviewerReport(
      reviewer.id,
      readReportInput(reportsDir, reviewer.id),
    );
  }
  return reports;
}

async function updateInlineFindingComment({
  token,
  repo,
  commentId,
  body,
}) {
  const normalizedCommentId = Number(commentId);
  if (!Number.isInteger(normalizedCommentId) || normalizedCommentId <= 0) {
    return false;
  }

  const { owner, name } = parseRepository(repo);
  await githubRequest({
    method: "PATCH",
    token,
    url: `https://api.github.com/repos/${owner}/${name}/pulls/comments/${normalizedCommentId}`,
    body: {
      body,
    },
  });
  return true;
}

async function setReviewThreadResolved({
  token,
  threadId,
  resolved,
}) {
  const normalizedThreadId = normalizeText(threadId);
  if (!normalizedThreadId) {
    return false;
  }

  await githubGraphqlRequest({
    token,
    query: resolved ? RESOLVE_REVIEW_THREAD_MUTATION : UNRESOLVE_REVIEW_THREAD_MUTATION,
    variables: {
      threadId: normalizedThreadId,
    },
  });

  return true;
}

function isNonBotUser(review) {
  const login = String(review?.user?.login || "").trim();
  const type = String(review?.user?.type || "").trim().toLowerCase();
  if (!login) return false;
  if (type === "bot") return false;
  if (login.toLowerCase().endsWith("[bot]")) return false;
  return true;
}

const TRUSTED_APPROVER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function isTrustedApprover(review) {
  const association = normalizeText(review?.author_association).toUpperCase();
  return TRUSTED_APPROVER_ASSOCIATIONS.has(association);
}

function pickLatestReviewsByUser(reviews) {
  const latestByUser = new Map();

  for (const review of Array.isArray(reviews) ? reviews : []) {
    if (!isNonBotUser(review)) continue;
    const login = String(review.user.login).trim().toLowerCase();

    const existing = latestByUser.get(login);
    if (!existing) {
      latestByUser.set(login, review);
      continue;
    }

    const existingDate = Date.parse(existing.submitted_at || "");
    const currentDate = Date.parse(review.submitted_at || "");

    if (!Number.isNaN(currentDate) && Number.isNaN(existingDate)) {
      latestByUser.set(login, review);
      continue;
    }

    if (!Number.isNaN(currentDate) && !Number.isNaN(existingDate) && currentDate >= existingDate) {
      latestByUser.set(login, review);
      continue;
    }

    if (Number(review.id) > Number(existing.id)) {
      latestByUser.set(login, review);
    }
  }

  return latestByUser;
}

async function fetchHumanBypassApproval({ token, repo, prNumber, headSha }) {
  const normalizedToken = normalizeText(token);
  const normalizedHeadSha = normalizeText(headSha);
  if (!normalizedToken || !normalizedHeadSha) {
    return {
      approved: false,
      approvers: [],
    };
  }

  const { owner, name } = parseRepository(repo);
  const pullNumber = parsePullNumber(prNumber);
  const pullRequest = await githubRequest({
    method: "GET",
    token: normalizedToken,
    url: `https://api.github.com/repos/${owner}/${name}/pulls/${pullNumber}`,
  });
  const pullRequestAuthor = normalizeText(pullRequest?.user?.login).toLowerCase();

  const reviews = await githubRequestAllPages({
    token: normalizedToken,
    url: `https://api.github.com/repos/${owner}/${name}/pulls/${pullNumber}/reviews?per_page=100&page=1`,
  });

  const latestByUser = pickLatestReviewsByUser(reviews);
  const approvers = [];

  for (const review of latestByUser.values()) {
    const state = String(review?.state || "").trim().toUpperCase();
    const commitId = normalizeText(review?.commit_id);
    const approverLogin = normalizeText(review?.user?.login);
    if (state !== "APPROVED") continue;
    if (!commitId || commitId !== normalizedHeadSha) continue;
    if (!approverLogin) continue;
    if (pullRequestAuthor && approverLogin.toLowerCase() === pullRequestAuthor) continue;
    if (!isTrustedApprover(review)) continue;
    approvers.push(approverLogin);
  }

  return {
    approved: approvers.length > 0,
    approvers,
  };
}

function evaluateOutcome({ humanBypassApproved, reviewerErrorsCount, openFindingsCount }) {
  if (humanBypassApproved) {
    return {
      outcome: "PASS",
      outcomeReason: "PASS_HUMAN_BYPASS",
    };
  }

  if (reviewerErrorsCount > 0) {
    return {
      outcome: "FAIL",
      outcomeReason: "FAIL_REVIEWER_ERRORS",
    };
  }

  if (openFindingsCount > 0) {
    return {
      outcome: "FAIL",
      outcomeReason: "FAIL_OPEN_FINDINGS",
    };
  }

  return {
    outcome: "PASS",
    outcomeReason: "PASS_NO_FINDINGS",
  };
}

export async function runConsensus({
  runId,
  sha,
  commentPath,
  ledgerPath,
  token,
  repo,
  prNumber,
  marker,
  reportsDir,
  reviewersJson,
  publishInlineComments,
  priorLedgerJson,
}) {
  const normalizedReportsDir = String(reportsDir || "").trim();
  if (!normalizedReportsDir) {
    throw new Error("REPORTS_DIR is required");
  }

  const normalizedCommentPath = String(commentPath || "").trim();
  if (!normalizedCommentPath) {
    throw new Error("COMMENT_PATH is required");
  }

  const normalizedLedgerPath = String(ledgerPath || "").trim();
  if (!normalizedLedgerPath) {
    throw new Error("LEDGER_PATH is required");
  }

  const reviewers = normalizeReviewers(reviewersJson || "[]");
  const labelsByReviewerId = new Map(reviewers.map((reviewer) => [reviewer.id, reviewer.display_name]));

  const reports = readReportsForReviewers({ reportsDir: normalizedReportsDir, reviewers });

  const {
    reviewerErrors,
  } = computeConsensus(reports, { reviewers });

  const priorLedger = readLedgerInput(priorLedgerJson);
  const merged = mergeLedgerWithReports({
    priorLedger,
    reports,
    reviewers,
    runId: normalizeText(runId) || "manual",
    timestamp: new Date().toISOString(),
  });

  let ledger = merged.ledger;

  const shouldPublishInlineComments = String(publishInlineComments ?? "true").toLowerCase() !== "false";
  const canUseGithub = normalizeText(token) && normalizeText(repo) && normalizeText(prNumber) && normalizeText(sha);
  let findingById = new Map(ledger.findings.map((finding) => [finding.id, finding]));

  if (shouldPublishInlineComments && canUseGithub) {
    const newlyLineBound = merged.newlyOpenedEntries.filter((entry) => {
      if (!isLineBoundFinding(entry?.finding)) return false;
      const findingId = normalizeText(entry?.finding?.id).toUpperCase();
      const existing = findingById.get(findingId);
      // Reopened findings should keep using their existing inline comment when available.
      return !(Number.isInteger(existing?.inline_comment_id) && existing.inline_comment_id > 0);
    });

    if (newlyLineBound.length > 0) {
      try {
        const posted = await publishInlineFindingComments({
          token,
          repo,
          prNumber,
          headSha: sha,
          entries: newlyLineBound,
          labelsByReviewerId,
        });

        if (posted.postedEntries.length > 0) {
          ledger = applyInlineCommentMetadata({
            ledger,
            entries: posted.postedEntries,
          });
          findingById = new Map(ledger.findings.map((finding) => [finding.id, finding]));
        }
      } catch (error) {
        logNonFatalGithubError("publishInlineFindingComments", error);
      }
    }

    // Keep inline comment presentation in sync with finding lifecycle transitions.
    for (const entry of merged.newlyResolvedEntries) {
      const findingId = normalizeText(entry?.finding?.id).toUpperCase();
      const finding = findingById.get(findingId);
      const commentId = Number(finding?.inline_comment_id);
      const threadId = normalizeText(finding?.inline_thread_id);

      if (threadId) {
        try {
          await setReviewThreadResolved({
            token,
            threadId,
            resolved: true,
          });
        } catch (error) {
          logNonFatalGithubError("resolveReviewThread", error);
        }
      }

      if (!Number.isInteger(commentId) || commentId <= 0) continue;
      const reviewerLabel = normalizeText(labelsByReviewerId.get(finding.reviewer) || finding.reviewer || "Reviewer");
      const body = `${buildInlineCommentBody({
        reviewerLabel,
        finding: findingToCommentShape(finding),
      })}\n\nStatus: Resolved in latest run.`;
      try {
        await updateInlineFindingComment({
          token,
          repo,
          commentId,
          body,
        });
      } catch (error) {
        logNonFatalGithubError("updateResolvedInlineComment", error);
      }
    }

    for (const entry of merged.reopenedEntries) {
      const findingId = normalizeText(entry?.finding?.id).toUpperCase();
      const finding = findingById.get(findingId);
      const commentId = Number(finding?.inline_comment_id);
      const threadId = normalizeText(finding?.inline_thread_id);

      if (threadId) {
        try {
          await setReviewThreadResolved({
            token,
            threadId,
            resolved: false,
          });
        } catch (error) {
          logNonFatalGithubError("unresolveReviewThread", error);
        }
      }

      if (!Number.isInteger(commentId) || commentId <= 0) continue;
      const reviewerLabel = normalizeText(labelsByReviewerId.get(finding.reviewer) || finding.reviewer || "Reviewer");
      const body = buildInlineCommentBody({
        reviewerLabel,
        finding: findingToCommentShape(finding),
      });
      try {
        await updateInlineFindingComment({
          token,
          repo,
          commentId,
          body,
        });
      } catch (error) {
        logNonFatalGithubError("updateReopenedInlineComment", error);
      }
    }
  }

  const openEntries = toPresentationEntries(ledger.findings, "open");
  const resolvedEntries = toPresentationEntries(ledger.findings, "resolved");

  let humanBypass = {
    approved: false,
    approvers: [],
  };

  if (canUseGithub) {
    humanBypass = await fetchHumanBypassApproval({
      token,
      repo,
      prNumber,
      headSha: sha,
    });
  }

  const { outcome, outcomeReason } = evaluateOutcome({
    humanBypassApproved: humanBypass.approved,
    reviewerErrorsCount: reviewerErrors.length,
    openFindingsCount: openEntries.length,
  });

  const failureReasons = renderFailureReasons({
    reviewerErrors,
    openEntries,
  });

  const commentBody = renderConsensusComment({
    marker,
    outcome,
    outcomeReason,
    openEntries,
    resolvedEntries,
    reviewerErrors,
    labelsByReviewerId,
    humanBypass,
  });

  ensureParentDir(normalizedCommentPath);
  ensureParentDir(normalizedLedgerPath);
  fs.writeFileSync(normalizedCommentPath, commentBody, "utf8");
  fs.writeFileSync(normalizedLedgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

  writeConsensusOutputs({
    outcome,
    outcomeReason,
    commentPath: normalizedCommentPath,
    ledgerPath: normalizedLedgerPath,
    openFindingsCount: openEntries.length,
    reviewerErrorsCount: reviewerErrors.length,
    reports,
    failureReasons,
    humanBypassApproved: humanBypass.approved,
  });

  return {
    outcome,
    outcomeReason,
    commentPath: normalizedCommentPath,
    ledgerPath: normalizedLedgerPath,
    openFindingsCount: openEntries.length,
    reviewerErrorsCount: reviewerErrors.length,
    reports,
    failureReasons,
    humanBypass,
  };
}

async function main() {
  await runConsensus({
    runId: process.env.GITHUB_RUN_ID || "",
    sha: process.env.SHA || "",
    commentPath: process.env.COMMENT_PATH || "lgtm-comment.md",
    ledgerPath: process.env.LEDGER_PATH || "lgtm-findings-ledger.json",
    token: process.env.GITHUB_TOKEN || "",
    repo: process.env.GITHUB_REPOSITORY || "",
    prNumber: process.env.PR_NUMBER || "",
    marker: process.env.MARKER || "<!-- codex-lgtm -->",
    reportsDir: process.env.REPORTS_DIR,
    reviewersJson: process.env.REVIEWERS_JSON || "[]",
    publishInlineComments: process.env.PUBLISH_INLINE_COMMENTS ?? "true",
    priorLedgerJson: process.env.PRIOR_LEDGER_JSON || "",
  });
}

function isCliMain() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCliMain()) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
