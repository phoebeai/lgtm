#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { githubRequest, githubRequestAllPages } from "./shared/github-client.mjs";

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase();
}

function parseTrustedOwnerLogins(value) {
  return String(value || "")
    .split(/[,\s]+/u)
    .map((item) => normalizeLogin(item))
    .filter(Boolean);
}

function isTrustedStickyOwner(login, trustedOwners) {
  return trustedOwners.has(normalizeLogin(login));
}

function parseCommentUpdatedAt(comment) {
  const raw = String(comment?.updated_at || comment?.created_at || "").trim();
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function selectMostRecentlyUpdatedComment(comments) {
  if (!Array.isArray(comments) || comments.length === 0) return null;
  return [...comments].sort((left, right) => {
    return parseCommentUpdatedAt(right) - parseCommentUpdatedAt(left);
  })[0];
}

export async function resolveTrustedStickyOwners({
  apiBase,
  token,
  trustedOwnerLogins,
  request = githubRequest,
}) {
  const owners = new Set(parseTrustedOwnerLogins(trustedOwnerLogins));
  if (owners.size > 0) {
    return owners;
  }

  // GitHub App installation tokens can derive a stable bot login from app_slug.
  try {
    const installation = await request({
      method: "GET",
      url: `${apiBase}/installation`,
      token,
    });
    const appSlug = normalizeLogin(installation?.app_slug);
    if (appSlug) {
      owners.add(`${appSlug}[bot]`);
    }
  } catch {
    // Ignore lookup failures; other trusted-owner sources may still be available.
  }

  // User/bot tokens can resolve their actor login directly.
  try {
    const viewer = await request({
      method: "GET",
      url: "https://api.github.com/user",
      token,
    });
    const viewerLogin = normalizeLogin(viewer?.login);
    if (viewerLogin) {
      owners.add(viewerLogin);
    }
  } catch {
    // Ignore lookup failures; explicit trusted owner input may still be set.
  }

  return owners;
}

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
  marker = "<!-- lgtm-sticky-comment -->",
  commentPath,
  trustedOwnerLogins = process.env.STICKY_COMMENT_TRUSTED_OWNERS || "",
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
  const trustedOwners = await resolveTrustedStickyOwners({
    apiBase,
    token: normalizedToken,
    trustedOwnerLogins,
  });

  const comments = await listIssueComments({ apiBase, prNumber: normalizedPrNumber, token: normalizedToken });

  const existing = selectMostRecentlyUpdatedComment(
    comments.filter(
      (comment) =>
      typeof comment.body === "string" &&
      comment.body.includes(marker) &&
      isTrustedStickyOwner(comment?.user?.login, trustedOwners),
    ),
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
    marker: "<!-- lgtm-sticky-comment -->",
    commentPath: process.env.COMMENT_PATH,
    trustedOwnerLogins: process.env.STICKY_COMMENT_TRUSTED_OWNERS || "",
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
