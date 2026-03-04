#!/usr/bin/env node

import { githubRequest } from "./shared/github-client.mjs";

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

function isPermissionIssue(error) {
  const message = normalizeText(error?.message || "").toLowerCase();
  return (
    message.includes("resource not accessible by integration")
    || message.includes("not permitted to create or approve pull requests")
    || message.includes("must have write access")
  );
}

async function main() {
  const token = normalizeText(process.env.GITHUB_TOKEN || "");
  const repo = normalizeText(process.env.GITHUB_REPOSITORY || "");
  const prNumber = parsePullNumber(process.env.PR_NUMBER || "");
  const expectedHeadSha = normalizeText(process.env.SHA || "");

  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }

  const { owner, name } = parseRepository(repo);
  const pull = await githubRequest({
    method: "GET",
    token,
    url: `https://api.github.com/repos/${owner}/${name}/pulls/${prNumber}`,
  });

  const currentHeadSha = normalizeText(pull?.head?.sha);
  if (expectedHeadSha && currentHeadSha && expectedHeadSha !== currentHeadSha) {
    process.stderr.write(
      `[approve-pr-when-clean] skipped: PR head moved from ${expectedHeadSha} to ${currentHeadSha}\n`,
    );
    return;
  }

  const body = "LGTM automation: no open findings in the latest run.";
  try {
    await githubRequest({
      method: "POST",
      token,
      url: `https://api.github.com/repos/${owner}/${name}/pulls/${prNumber}/reviews`,
      body: {
        event: "APPROVE",
        body,
      },
    });
  } catch (error) {
    if (isPermissionIssue(error)) {
      process.stderr.write(
        `[approve-pr-when-clean] non-fatal: unable to auto-approve (${normalizeText(error?.message)})\n`,
      );
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
