#!/usr/bin/env node

import { pathToFileURL } from "node:url";
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
  await approvePrWhenClean({
    token: process.env.GITHUB_TOKEN || "",
    repo: process.env.GITHUB_REPOSITORY || "",
    prNumber: process.env.PR_NUMBER || "",
    expectedHeadSha: process.env.SHA || "",
  });
}

export async function approvePrWhenClean({
  token,
  repo,
  prNumber,
  expectedHeadSha,
  request = githubRequest,
  stderr = process.stderr,
}) {
  const normalizedToken = normalizeText(token || "");
  const normalizedRepo = normalizeText(repo || "");
  const normalizedExpectedHeadSha = normalizeText(expectedHeadSha || "");
  const normalizedPrNumber = parsePullNumber(prNumber || "");
  if (!normalizedToken) {
    throw new Error("GITHUB_TOKEN is required");
  }

  const { owner, name } = parseRepository(normalizedRepo);
  const pull = await request({
    method: "GET",
    token: normalizedToken,
    url: `https://api.github.com/repos/${owner}/${name}/pulls/${normalizedPrNumber}`,
  });

  const currentHeadSha = normalizeText(pull?.head?.sha);
  if (normalizedExpectedHeadSha && currentHeadSha && normalizedExpectedHeadSha !== currentHeadSha) {
    stderr.write(
      `[approve-pr-when-clean] skipped: PR head moved from ${normalizedExpectedHeadSha} to ${currentHeadSha}\n`,
    );
    return;
  }

  const body = "LGTM automation: no open findings in the latest run.";
  try {
    await request({
      method: "POST",
      token: normalizedToken,
      url: `https://api.github.com/repos/${owner}/${name}/pulls/${normalizedPrNumber}/reviews`,
      body: {
        event: "APPROVE",
        body,
      },
    });
  } catch (error) {
    if (isPermissionIssue(error)) {
      stderr.write(
        `[approve-pr-when-clean] non-fatal: unable to auto-approve (${normalizeText(error?.message)})\n`,
      );
      return;
    }
    throw error;
  }
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
