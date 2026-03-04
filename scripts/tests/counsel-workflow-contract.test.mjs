import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const WORKFLOW_PATH = path.resolve(".github/workflows/lgtm.yml");

function readWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

test("workflow is reusable via workflow_call with required openai_api_key", () => {
  const workflow = readWorkflow();
  assert.match(workflow, /on:\s*\n\s*workflow_call:/);
  assert.match(workflow, /secrets:\s*[\s\S]*?openai_api_key:[\s\S]*?required:\s*true/);
});

test("workflow accepts optional pull_request_number for workflow_dispatch callers", () => {
  const workflow = readWorkflow();
  assert.match(
    workflow,
    /pull_request_number:[\s\S]*?description:\s*Pull request number to review when caller is workflow_dispatch[\s\S]*?type:\s*number/,
  );
});

test("workflow supports optional inline comment publishing toggle", () => {
  const workflow = readWorkflow();
  assert.match(
    workflow,
    /publish_inline_comments:[\s\S]*?description:\s*Whether to publish line-bound findings as inline PR comments[\s\S]*?type:\s*boolean/,
  );
});

test("workflow runs as a single LGTM job", () => {
  const workflow = readWorkflow();
  assert.match(workflow, /jobs:\s*\n\s*lgtm:/);
  assert.doesNotMatch(workflow, /resolve-pr-context:\s*/);
  assert.doesNotMatch(workflow, /prepare:\s*/);
  assert.doesNotMatch(workflow, /review:\s*/);
  assert.doesNotMatch(workflow, /consensus:\s*/);
});

test("reviewers are executed in parallel via codex sdk wrapper script", () => {
  const workflow = readWorkflow();
  assert.doesNotMatch(workflow, /npm install -g @openai\/codex/);
  assert.match(
    workflow,
    /Find prior ledger artifact run[\s\S]*?run:\s*node workflow-src\/scripts\/find-prior-ledger-run\.mjs/,
  );
  assert.match(
    workflow,
    /Run reviewers[\s\S]*?CODEX_BIN:\s*\$\{\{ github\.workspace \}\}\/workflow-src\/node_modules\/\.bin\/codex/,
  );
  assert.match(
    workflow,
    /Run reviewers[\s\S]*?CODEX_PROXY_BIN:\s*\$\{\{ github\.workspace \}\}\/workflow-src\/node_modules\/\.bin\/codex-responses-api-proxy/,
  );
  assert.match(
    workflow,
    /Run reviewers[\s\S]*?run:[\s\S]*?node workflow-src\/scripts\/run-reviewers-parallel\.mjs/,
  );
  assert.doesNotMatch(workflow, /openai\/codex-action@v1/);
});

test("consensus and artifact persistence remain node-only", () => {
  const workflow = readWorkflow();
  assert.match(workflow, /Compute pass\/fail consensus[\s\S]*?run:\s*node workflow-src\/scripts\/consensus\.mjs/);
  assert.match(workflow, /Persist consensus artifacts[\s\S]*?run:\s*node workflow-src\/scripts\/persist-consensus-artifacts\.mjs/);
  assert.doesNotMatch(workflow, /\bjq\b/);
});
