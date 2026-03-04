#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { writeGithubOutput } from "./shared/github-output.mjs";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function parseRepository(repo) {
  const [owner, name] = normalizeText(repo).split("/");
  if (!owner || !name) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }
  return { owner, name };
}

function parsePullNumber(value) {
  const parsed = Number.parseInt(normalizeText(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("PR_NUMBER must be a positive integer");
  }
  return parsed;
}

function parseRunId(value) {
  const parsed = Number.parseInt(normalizeText(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("GITHUB_RUN_ID must be a positive integer");
  }
  return parsed;
}

async function githubGet({ token, url }) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "phoebe-lgtm",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GET ${url} failed (${response.status}): ${text}`);
  }

  return response.json();
}

function runBelongsToPullRequest(run, pullNumber) {
  const pullRequests = Array.isArray(run?.pull_requests) ? run.pull_requests : [];
  return pullRequests.some((pullRequest) => Number(pullRequest?.number) === pullNumber);
}

async function findPriorLedgerRun({ token, repo, prNumber, currentRunId }) {
  const { owner, name } = parseRepository(repo);
  const normalizedPrNumber = parsePullNumber(prNumber);
  const normalizedCurrentRunId = parseRunId(currentRunId);

  for (let page = 1; page <= 5; page += 1) {
    const runsPayload = await githubGet({
      token,
      url: `https://api.github.com/repos/${owner}/${name}/actions/runs?event=pull_request&status=completed&per_page=100&page=${page}`,
    });

    const workflowRuns = Array.isArray(runsPayload?.workflow_runs) ? runsPayload.workflow_runs : [];
    if (workflowRuns.length === 0) {
      break;
    }

    const candidates = workflowRuns
      .filter((run) => Number(run?.id) < normalizedCurrentRunId)
      .filter((run) => runBelongsToPullRequest(run, normalizedPrNumber))
      .sort((left, right) => {
        const leftDate = Date.parse(left?.created_at || "");
        const rightDate = Date.parse(right?.created_at || "");
        return rightDate - leftDate;
      });

    for (const candidate of candidates) {
      const runId = Number(candidate?.id);
      if (!Number.isInteger(runId) || runId <= 0) {
        continue;
      }

      const expectedArtifactName = `lgtm-${runId}`;
      const artifactsPayload = await githubGet({
        token,
        url: `https://api.github.com/repos/${owner}/${name}/actions/runs/${runId}/artifacts?per_page=100`,
      });

      const artifacts = Array.isArray(artifactsPayload?.artifacts) ? artifactsPayload.artifacts : [];
      const artifact = artifacts.find(
        (item) => String(item?.name || "") === expectedArtifactName && item?.expired === false,
      );

      if (artifact) {
        return {
          prior_run_id: String(runId),
          prior_artifact_name: expectedArtifactName,
        };
      }
    }
  }

  return {
    prior_run_id: "",
    prior_artifact_name: "",
  };
}

async function main() {
  const token = normalizeText(process.env.GITHUB_TOKEN);
  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }

  const result = await findPriorLedgerRun({
    token,
    repo: process.env.GITHUB_REPOSITORY,
    prNumber: process.env.PR_NUMBER,
    currentRunId: process.env.GITHUB_RUN_ID,
  });

  writeGithubOutput("prior_run_id", result.prior_run_id);
  writeGithubOutput("prior_artifact_name", result.prior_artifact_name);

  process.stdout.write(`${JSON.stringify(result)}\n`);
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

export { findPriorLedgerRun };
