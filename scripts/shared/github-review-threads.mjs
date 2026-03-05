#!/usr/bin/env node

import { applyInlineCommentMetadata } from "./findings-ledger.mjs";
import {
  githubGraphqlRequest,
  githubRequest,
} from "./github-client.mjs";

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

const REVIEW_THREADS_QUERY = `
  query PullRequestReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
                databaseId
              }
            }
          }
        }
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

export function normalizeCommentId(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function formatResolvedStatusSuffix(headSha) {
  const normalizedHeadSha = normalizeText(headSha);
  if (!normalizedHeadSha) {
    return "Status: Resolved in latest run.";
  }
  return `Status: Resolved in ${normalizedHeadSha.slice(0, 7)}.`;
}

export function collectFindingsWithInlineComments(ledger) {
  return (Array.isArray(ledger?.findings) ? ledger.findings : []).filter(
    (finding) => normalizeCommentId(finding?.inline_comment_id) !== null,
  );
}

export function buildInlineCommentFindingShape(finding) {
  return {
    id: normalizeText(finding?.id),
    title: normalizeText(finding?.title) || "Untitled finding",
    recommendation: normalizeText(finding?.recommendation) || "No recommendation provided.",
    file: normalizeText(finding?.file) || null,
    line: Number.isInteger(finding?.line) && finding.line > 0 ? finding.line : null,
  };
}

export async function updateInlineFindingComment({
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

export async function fetchReviewThreadMetadataByCommentId({
  token,
  repo,
  prNumber,
}) {
  const { owner, name } = parseRepository(repo);
  const number = parsePullNumber(prNumber);
  const metadataByCommentId = new Map();
  let cursor = null;

  while (true) {
    const data = await githubGraphqlRequest({
      token,
      query: REVIEW_THREADS_QUERY,
      variables: {
        owner,
        name,
        number,
        cursor,
      },
    });

    const connection = data?.repository?.pullRequest?.reviewThreads;
    if (!connection) break;

    for (const thread of connection.nodes || []) {
      const threadId = normalizeText(thread?.id);
      const resolved = thread?.isResolved === true;
      for (const comment of thread?.comments?.nodes || []) {
        const commentId = Number(comment?.databaseId);
        if (Number.isInteger(commentId) && commentId > 0) {
          metadataByCommentId.set(commentId, {
            threadId,
            isResolved: resolved,
          });
        }
      }
    }

    if (!connection.pageInfo?.hasNextPage) {
      break;
    }
    cursor = connection.pageInfo.endCursor || null;
  }

  return metadataByCommentId;
}

export function backfillMissingInlineThreadIds({
  ledger,
  threadMetadataByCommentId,
}) {
  const findings = Array.isArray(ledger?.findings) ? ledger.findings : [];
  const candidates = findings.filter(
    (finding) =>
      Number.isInteger(finding?.inline_comment_id)
      && finding.inline_comment_id > 0
      && !normalizeText(finding?.inline_thread_id),
  );

  if (candidates.length === 0) {
    return ledger;
  }

  const metadataEntries = [];
  for (const finding of candidates) {
    const metadata = threadMetadataByCommentId.get(Number(finding.inline_comment_id));
    const threadId = normalizeText(metadata?.threadId);
    if (!threadId) continue;
    metadataEntries.push({
      finding: {
        id: finding.id,
      },
      inline_thread_id: threadId,
    });
  }

  if (metadataEntries.length === 0) {
    return ledger;
  }

  return applyInlineCommentMetadata({
    ledger,
    entries: metadataEntries,
  });
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

export async function setFindingThreadResolved({
  token,
  finding,
  desiredResolved,
  threadMetadataByCommentId,
}) {
  const commentId = normalizeCommentId(finding?.inline_comment_id);
  if (!commentId) return false;

  const metadata = threadMetadataByCommentId.get(commentId);
  const metadataThreadId = normalizeText(metadata?.threadId);
  const threadId = normalizeText(finding?.inline_thread_id) || metadataThreadId;
  if (!threadId) return false;

  if (metadata && metadata.isResolved === desiredResolved) {
    return true;
  }

  await setReviewThreadResolved({
    token,
    threadId,
    resolved: desiredResolved,
  });

  threadMetadataByCommentId.set(commentId, {
    threadId,
    isResolved: desiredResolved,
  });
  return true;
}
