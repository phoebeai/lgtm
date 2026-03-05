#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { writeGithubOutput } from "./shared/github-output.mjs";
import { githubRequest } from "./shared/github-client.mjs";

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

function parseOptionalRunId(value) {
  const parsed = Number.parseInt(normalizeText(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function runBelongsToPullRequest(run, pullNumber) {
  const pullRequests = Array.isArray(run?.pull_requests) ? run.pull_requests : [];
  return pullRequests.some((pullRequest) => Number(pullRequest?.number) === pullNumber);
}

function parseMaxPages(value) {
  const parsed = Number.parseInt(normalizeText(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 100;
  }
  return parsed;
}

async function findPriorLedgerRun({ token, repo, prNumber, currentRunId, maxPages = 100 }) {
  const { owner, name } = parseRepository(repo);
  const normalizedPrNumber = parsePullNumber(prNumber);
  const normalizedCurrentRunId = parseRunId(currentRunId);
  const normalizedMaxPages = parseMaxPages(maxPages);
  const currentRun = await githubRequest({
    method: "GET",
    token,
    url: `https://api.github.com/repos/${owner}/${name}/actions/runs/${normalizedCurrentRunId}`,
  });
  const currentWorkflowId = parseOptionalRunId(currentRun?.workflow_id);

  for (let page = 1; page <= normalizedMaxPages; page += 1) {
    const runsUrl = currentWorkflowId
      ? `https://api.github.com/repos/${owner}/${name}/actions/workflows/${currentWorkflowId}/runs?status=completed&per_page=100&page=${page}`
      : `https://api.github.com/repos/${owner}/${name}/actions/runs?status=completed&per_page=100&page=${page}`;

    const runsPayload = await githubRequest({
      method: "GET",
      token,
      url: runsUrl,
    });

    const workflowRuns = Array.isArray(runsPayload?.workflow_runs) ? runsPayload.workflow_runs : [];
    if (workflowRuns.length === 0) {
      break;
    }

    const candidates = workflowRuns
      .filter((run) => Number(run?.id) < normalizedCurrentRunId)
      .filter((run) => runBelongsToPullRequest(run, normalizedPrNumber))
      .filter((run) => {
        if (!currentWorkflowId) return true;
        return parseOptionalRunId(run?.workflow_id) === currentWorkflowId;
      })
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
      const artifactsPayload = await githubRequest({
        method: "GET",
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
    maxPages: process.env.PRIOR_LEDGER_MAX_PAGES,
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
