#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { githubRequest, githubRequestAllPages } from "./shared/github-client.mjs";

export async function listIssueComments({ apiBase, prNumber, token }) {
  return githubRequestAllPages({
    token,
    url: `${apiBase}/issues/${prNumber}/comments?per_page=100&page=1`,
  });
}

export async function upsertPrComment({
  token,
  repo,
  prNumber,
  marker = "<!-- codex-lgtm -->",
  commentPath,
  actor,
}) {
  const normalizedToken = String(token || "").trim();
  const normalizedRepo = String(repo || "").trim();
  const normalizedPrNumber = String(prNumber || "").trim();
  const normalizedCommentPath = String(commentPath || "").trim();

  if (!normalizedToken) throw new Error("GITHUB_TOKEN is required");
  if (!normalizedRepo) throw new Error("GITHUB_REPOSITORY is required");
  if (!normalizedPrNumber) throw new Error("PR_NUMBER is required");
  if (!normalizedCommentPath) throw new Error("COMMENT_PATH is required");

  const [owner, name] = normalizedRepo.split("/");
  if (!owner || !name) throw new Error("GITHUB_REPOSITORY must be owner/name");

  const body = fs.readFileSync(normalizedCommentPath, "utf8");
  const apiBase = `https://api.github.com/repos/${owner}/${name}`;
  const botAuthorLogins = new Set(
    ["github-actions[bot]", actor].filter(
      (value) => typeof value === "string" && value.length > 0
    )
  );

  const comments = await listIssueComments({ apiBase, prNumber: normalizedPrNumber, token: normalizedToken });

  const existing = comments.find(
    (comment) =>
      typeof comment.body === "string" &&
      comment.body.includes(marker) &&
      typeof comment?.user?.login === "string" &&
      botAuthorLogins.has(comment.user.login)
  );

  if (existing) {
    await githubRequest({
      method: "PATCH",
      url: `${apiBase}/issues/comments/${existing.id}`,
      token: normalizedToken,
      body: { body },
    });
    return { action: "updated", commentId: existing.id };
  }

  const created = await githubRequest({
    method: "POST",
    url: `${apiBase}/issues/${normalizedPrNumber}/comments`,
    token: normalizedToken,
    body: { body },
  });

  return { action: "created", commentId: created.id };
}

async function main() {
  const result = await upsertPrComment({
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPOSITORY,
    prNumber: process.env.PR_NUMBER,
    marker: process.env.MARKER || "<!-- codex-lgtm -->",
    commentPath: process.env.COMMENT_PATH,
    actor: process.env.GITHUB_ACTOR,
  });

  if (result.action === "updated") {
    process.stdout.write(`Updated existing LGTM comment ${result.commentId}\n`);
    return;
  }

  process.stdout.write(`Created LGTM comment ${result.commentId}\n`);
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
