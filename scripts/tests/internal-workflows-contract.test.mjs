import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";

const CI_WORKFLOW_PATH = path.resolve(".github/workflows/ci.yml");
const DOGFOOD_WORKFLOW_PATH = path.resolve(".github/workflows/dogfood.yml");
const LGTM_WORKFLOW_PATH = path.resolve(".github/workflows/lgtm.yml");
const DOGFOOD_CONFIG_PATH = path.resolve("examples/lgtm.yml");
const SMOKE_CONSUMER_CONFIG_PATH = path.resolve("examples/smoke-consumer/lgtm.yml");
const SMOKE_CONSUMER_WORKFLOW_PATH = path.resolve("examples/smoke-consumer/pr-checks.yml");
const REVIEWER_OUTPUT_SCHEMA_PATH = path.resolve("schemas/reviewer-output.schema.json");

function readWorkflowObject(filePath) {
  return parseYaml(fs.readFileSync(filePath, "utf8"));
}

test("ci workflow runs npm tests on all PR and main-branch push changes", () => {
  const ci = readWorkflowObject(CI_WORKFLOW_PATH);

  assert.equal(ci.name, "CI");
  assert.deepEqual(ci.on.pull_request.types, ["opened", "reopened", "synchronize", "ready_for_review"]);
  assert.equal(ci.on.pull_request.paths, undefined);
  assert.deepEqual(ci.on.push.branches, ["main"]);
  assert.equal(ci.on.push.paths, undefined);

  const steps = ci.jobs.test.steps.map((step) => step.run || "");
  assert.ok(steps.includes("npm ci --ignore-scripts"));
  assert.ok(steps.includes("npm test"));
});

test("dogfood workflow calls reusable workflow with gate and auto-approval settings", () => {
  const dogfood = readWorkflowObject(DOGFOOD_WORKFLOW_PATH);

  assert.equal(dogfood.name, "Dogfood");
  assert.ok(dogfood.on.pull_request);
  assert.ok(dogfood.on.workflow_dispatch?.inputs?.pull_request_number);

  const job = dogfood.jobs.dogfood;
  assert.equal(job.uses, "./.github/workflows/lgtm.yml");
  assert.equal(job.with.config_path, "examples/lgtm.yml");
  assert.equal(job.with.publish_comment, true);
  assert.equal(job.with.publish_inline_comments, true);
  assert.equal(job.with.enforce_gate, true);
  assert.equal(job.with.auto_approve_no_findings, true);
  assert.match(String(job.if), /head\.repo\.full_name == github\.repository/);
  assert.equal(job.secrets.openai_api_key, "${{ secrets.OPENAI_API_KEY }}");
  assert.equal(job.secrets.github_app_id, "${{ secrets.LGTM_GITHUB_APP_ID }}");
  assert.equal(job.secrets.github_app_private_key, "${{ secrets.LGTM_GITHUB_APP_PRIVATE_KEY }}");
});

test("reusable lgtm workflow runs as a single LGTM job", () => {
  const lgtm = readWorkflowObject(LGTM_WORKFLOW_PATH);
  const workflowText = fs.readFileSync(LGTM_WORKFLOW_PATH, "utf8");

  assert.equal(lgtm.name, "LGTM");
  assert.equal(Object.keys(lgtm.jobs).length, 1);
  assert.ok(lgtm.jobs.lgtm);
  assert.equal(lgtm.jobs.lgtm.name, "LGTM");
  assert.match(
    workflowText,
    /Find prior ledger artifact run[\s\S]*?node workflow-src\/scripts\/find-prior-ledger-run\.mjs/,
  );
  assert.match(
    workflowText,
    /Prepare prior ledger[\s\S]*?node workflow-src\/scripts\/prepare-prior-ledger\.mjs/,
  );
  assert.match(
    workflowText,
    /Run reviewers[\s\S]*?node workflow-src\/scripts\/run-reviewers-parallel\.mjs/,
  );
  assert.match(
    workflowText,
    /Compute pass\/fail consensus[\s\S]*?node workflow-src\/scripts\/consensus\.mjs/,
  );
  assert.match(
    workflowText,
    /Compute pass\/fail consensus[\s\S]*?PRIOR_LEDGER_JSON:\s*\$\{\{\s*steps\.prior_ledger\.outputs\.prior_ledger_json\s*\}\}/,
  );
  assert.match(
    workflowText,
    /Auto-approve PR when no findings[\s\S]*?steps\.consensus\.outputs\.outcome_reason == 'PASS_NO_FINDINGS'/,
  );
});

test("reusable lgtm workflow enforces gate when consensus outcome is FAIL", () => {
  const workflowText = fs.readFileSync(LGTM_WORKFLOW_PATH, "utf8");
  assert.match(workflowText, /Enforce LGTM gate/);
  assert.match(
    workflowText,
    /if:\s*\$\{\{\s*always\(\)\s*&&\s*inputs\.enforce_gate\s*\}\}/,
  );
  assert.match(
    workflowText,
    /if \[\[ "\$\{\{ steps\.consensus\.outputs\.outcome \}\}" != "PASS" \]\]; then/,
  );
  assert.match(workflowText, /LGTM outcome is \$\{\{ steps\.consensus\.outputs\.outcome \}\}; failing workflow by policy\./);
});

test("dogfood config points to checked-in prompt fixtures", () => {
  const config = readWorkflowObject(DOGFOOD_CONFIG_PATH);
  for (const reviewer of config.reviewers) {
    assert.equal(typeof reviewer.prompt_file, "string");
    assert.ok(fs.existsSync(path.resolve(reviewer.prompt_file)), `${reviewer.prompt_file} must exist`);
  }
});

test("smoke-consumer config uses consumer-local prompt paths", () => {
  const config = readWorkflowObject(SMOKE_CONSUMER_CONFIG_PATH);
  for (const reviewer of config.reviewers) {
    assert.match(String(reviewer.prompt_file), /^\.github\/lgtm\/prompts\//);
  }
});

test("smoke-consumer workflow pins reusable workflow to v1 and grants required permissions", () => {
  const workflow = readWorkflowObject(SMOKE_CONSUMER_WORKFLOW_PATH);
  assert.equal(workflow.jobs?.lgtm?.uses, "phoebeai/lgtm/.github/workflows/lgtm.yml@v1");
  assert.equal(workflow.permissions?.contents, "read");
  assert.equal(workflow.permissions?.["pull-requests"], "write");
  assert.equal(workflow.permissions?.actions, "read");
  assert.equal(workflow.jobs?.lgtm?.with?.auto_approve_no_findings, true);
  assert.equal(workflow.jobs?.lgtm?.secrets?.openai_api_key, "${{ secrets.OPENAI_API_KEY }}");
  assert.equal(workflow.jobs?.lgtm?.secrets?.github_app_id, "${{ secrets.LGTM_GITHUB_APP_ID }}");
  assert.equal(
    workflow.jobs?.lgtm?.secrets?.github_app_private_key,
    "${{ secrets.LGTM_GITHUB_APP_PRIVATE_KEY }}",
  );
  assert.deepEqual(workflow.on?.pull_request?.types, ["opened", "reopened", "synchronize", "ready_for_review"]);
});

test("reviewer output schema allows dynamic reviewer ids", () => {
  const schema = JSON.parse(fs.readFileSync(REVIEWER_OUTPUT_SCHEMA_PATH, "utf8"));
  const reviewerSchema = schema?.properties?.reviewer;
  assert.equal(reviewerSchema?.type, "string");
  assert.equal(reviewerSchema?.pattern, "^[a-z0-9_]+$");
  assert.equal(reviewerSchema?.minLength, 1);
  assert.equal("enum" in reviewerSchema, false);
});
