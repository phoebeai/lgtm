#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { githubRequestAllPages } from "./shared/github-client.mjs";
import {
  normalizeInlineFindingCommentBody,
  verifyInlineFindingCommentSignature,
} from "./shared/finding-comment-marker.mjs";
import { writeGithubOutput } from "./shared/github-output.mjs";

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

function normalizeLine(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeCommentBody(value) {
  return normalizeInlineFindingCommentBody(value);
}

function looksLikeFindingComment(body) {
  const normalized = normalizeCommentBody(body);
  return /^\*\*.+\(.+\):\*\*/.test(normalized);
}

function isTrustedFindingCommentSource(comment, signatureSecret) {
  const author = normalizeText(comment?.user?.login || "").toLowerCase();
  if (!author.endsWith("[bot]")) return false;
  return verifyInlineFindingCommentSignature({
    body: comment?.body || "",
    secret: signatureSecret,
  });
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function defaultGraphqlRequest({ token, query, variables }) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "phoebe-lgtm",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GraphQL request failed (${response.status}): ${text}`);
  }

  const payload = await response.json();
  if (payload?.errors?.length) {
    const first = payload.errors[0];
    throw new Error(`GraphQL request failed: ${first?.message || "unknown GraphQL error"}`);
  }

  return payload?.data || null;
}

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

export async function fetchThreadResolutionByCommentId({
  token,
  owner,
  name,
  pullNumber,
  graphqlRequest = defaultGraphqlRequest,
}) {
  const resolutionByCommentId = new Map();
  let cursor = null;

  while (true) {
    const data = await graphqlRequest({
      token,
      query: REVIEW_THREADS_QUERY,
      variables: {
        owner,
        name,
        number: pullNumber,
        cursor,
      },
    });

    const connection = data?.repository?.pullRequest?.reviewThreads;
    if (!connection) break;

    for (const thread of connection.nodes || []) {
      const resolved = thread?.isResolved === true;
      for (const comment of thread?.comments?.nodes || []) {
        const commentId = Number(comment?.databaseId);
        if (Number.isInteger(commentId) && commentId > 0) {
          resolutionByCommentId.set(commentId, resolved);
        }
      }
    }

    if (!connection.pageInfo?.hasNextPage) {
      break;
    }
    cursor = connection.pageInfo.endCursor || null;
  }

  return resolutionByCommentId;
}

function toFindingMemoryEntry(comment, resolvedByCommentId, signatureSecret) {
  if (!isTrustedFindingCommentSource(comment, signatureSecret)) {
    return null;
  }

  const commentId = Number(comment?.id);
  if (!Number.isInteger(commentId) || commentId <= 0) {
    return null;
  }

  const body = normalizeCommentBody(comment?.body || "");
  if (!body || !looksLikeFindingComment(body)) {
    return null;
  }

  return {
    id: commentId,
    path: normalizeText(comment?.path || ""),
    line: normalizeLine(comment?.line),
    resolved: resolvedByCommentId.has(commentId) ? resolvedByCommentId.get(commentId) : null,
    author: normalizeText(comment?.user?.login || ""),
    created_at: normalizeText(comment?.created_at || ""),
    updated_at: normalizeText(comment?.updated_at || ""),
    url: normalizeText(comment?.html_url || ""),
    body,
  };
}

export function renderPriorFindingsMarkdown(entries) {
  const lines = [
    "# Prior Finding Memory",
    "",
    `Total findings: ${entries.length}`,
    "",
  ];

  for (const entry of entries) {
    const location = entry.path && entry.line ? `${entry.path}:${entry.line}` : entry.path || "unknown";
    const resolved = entry.resolved === true ? "resolved" : entry.resolved === false ? "unresolved" : "unknown";
    lines.push(`## ${location}`);
    lines.push(`- Resolved: ${resolved}`);
    if (entry.author) lines.push(`- Author: ${entry.author}`);
    if (entry.url) lines.push(`- URL: ${entry.url}`);
    lines.push("");
    lines.push("```markdown");
    lines.push(entry.body);
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

export async function collectPriorFindingMemory({
  token,
  signatureSecret,
  repository,
  prNumber,
  requestAllPages = githubRequestAllPages,
  graphqlRequest = defaultGraphqlRequest,
}) {
  const normalizedToken = normalizeText(token);
  if (!normalizedToken) {
    throw new Error("GITHUB_TOKEN is required");
  }
  const normalizedSignatureSecret = normalizeText(signatureSecret || normalizedToken);

  const { owner, name } = parseRepository(repository);
  const pullNumber = parsePullNumber(prNumber);

  const comments = await requestAllPages({
    token: normalizedToken,
    url: `https://api.github.com/repos/${owner}/${name}/pulls/${pullNumber}/comments?per_page=100&page=1`,
  });

  const resolutionByCommentId = await fetchThreadResolutionByCommentId({
    token: normalizedToken,
    owner,
    name,
    pullNumber,
    graphqlRequest,
  });

  const entries = comments
    .map((comment) => toFindingMemoryEntry(comment, resolutionByCommentId, normalizedSignatureSecret))
    .filter(Boolean)
    .sort((left, right) => {
      const leftTime = Date.parse(left.updated_at || left.created_at || "");
      const rightTime = Date.parse(right.updated_at || right.created_at || "");
      return leftTime - rightTime;
    });

  return entries;
}

async function main() {
  const outputJsonPath = normalizeText(process.env.PRIOR_FINDINGS_JSON || "");
  const outputMarkdownPath = normalizeText(process.env.PRIOR_FINDINGS_MD || "");

  if (!outputJsonPath) {
    throw new Error("PRIOR_FINDINGS_JSON is required");
  }
  if (!outputMarkdownPath) {
    throw new Error("PRIOR_FINDINGS_MD is required");
  }

  const entries = await collectPriorFindingMemory({
    token: process.env.GITHUB_TOKEN,
    signatureSecret: process.env.FINDING_SIGNATURE_SECRET || process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    prNumber: process.env.PR_NUMBER,
  });

  ensureDirForFile(outputJsonPath);
  ensureDirForFile(outputMarkdownPath);

  fs.writeFileSync(outputJsonPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  fs.writeFileSync(outputMarkdownPath, `${renderPriorFindingsMarkdown(entries)}\n`, "utf8");

  writeGithubOutput("prior_findings_json", outputJsonPath);
  writeGithubOutput("prior_findings_md", outputMarkdownPath);
  writeGithubOutput("prior_findings_count", String(entries.length));

  process.stdout.write(`${JSON.stringify({ prior_findings_count: entries.length })}\n`);
}

function isCliMain() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCliMain()) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
