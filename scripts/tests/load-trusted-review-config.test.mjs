import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  commitAll,
  createRepo,
  runScript,
  runScriptExpectFailure,
  writeRepoFile,
} from "./test-utils.mjs";

const SCRIPT_PATH = path.resolve("scripts/load-trusted-review-config.mjs");

test("load-trusted-review-config reads trusted config from base commit", (t) => {
  const repoDir = createRepo(t, "lgtm-config-");

  writeRepoFile(repoDir, ".github/lgtm/prompts/security.md", "Security prompt");
  writeRepoFile(repoDir, ".github/lgtm/prompts/test-quality.md", "Test prompt");
  writeRepoFile(
    repoDir,
    ".github/lgtm.yml",
    [
      "version: 1",
      "defaults:",
      "  model: gpt-5.3-codex",
      "  effort: xhigh",
      "reviewers:",
      "  - id: security",
      "    display_name: Security",
      "    prompt_file: .github/lgtm/prompts/security.md",
      "    scope: security risk",
      "  - id: test_quality",
      "    display_name: Test Quality",
      "    prompt_file: .github/lgtm/prompts/test-quality.md",
      "    scope: test coverage risk",
      "    paths:",
      "      - src/**",
    ].join("\n"),
  );
  writeRepoFile(repoDir, "src/app.ts", "base");
  const baseSha = commitAll(repoDir, "base");

  writeRepoFile(
    repoDir,
    ".github/lgtm.yml",
    [
      "version: 1",
      "defaults:",
      "  model: should-not-be-used",
      "reviewers:",
      "  - id: pwned",
      "    display_name: Pwned",
      "    prompt_file: .github/lgtm/prompts/security.md",
      "    scope: pwn",
    ].join("\n"),
  );
  const headSha = commitAll(repoDir, "head");

  const { stdout, outputs } = runScript({
    repoDir,
    scriptPath: SCRIPT_PATH,
    env: {
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      CONFIG_REL: ".github/lgtm.yml",
      INPUT_MODEL: "",
      INPUT_EFFORT: "",
      FALLBACK_MODEL: "fallback-model",
      FALLBACK_EFFORT: "fallback-effort",
    },
  });

  const summary = JSON.parse(stdout);
  assert.equal(summary.reviewer_count, 2);
  assert.equal(outputs.resolved_model, "gpt-5.3-codex");
  assert.equal(outputs.resolved_effort, "xhigh");

  const reviewers = JSON.parse(outputs.reviewers_json);
  assert.equal(reviewers.length, 2);
  assert.equal(reviewers[0].id, "security");
  assert.equal(reviewers[1].id, "test_quality");

  const matrix = JSON.parse(outputs.reviewer_matrix_json);
  assert.equal(matrix.include.length, 2);
  assert.equal(matrix.include[1].id, "test_quality");
  assert.equal(matrix.include[1].paths_json, JSON.stringify(["src/**"]));
});

test("load-trusted-review-config allows explicit input model/effort overrides", (t) => {
  const repoDir = createRepo(t, "lgtm-config-");

  writeRepoFile(repoDir, ".github/lgtm/prompts/security.md", "Security prompt");
  writeRepoFile(
    repoDir,
    ".github/lgtm.yml",
    [
      "version: 1",
      "defaults:",
      "  model: gpt-5.3-codex",
      "  effort: xhigh",
      "reviewers:",
      "  - id: security",
      "    display_name: Security",
      "    prompt_file: .github/lgtm/prompts/security.md",
      "    scope: security risk",
    ].join("\n"),
  );
  const sha = commitAll(repoDir, "base");

  const { outputs } = runScript({
    repoDir,
    scriptPath: SCRIPT_PATH,
    env: {
      BASE_SHA: sha,
      HEAD_SHA: sha,
      CONFIG_REL: ".github/lgtm.yml",
      INPUT_MODEL: "gpt-6-review",
      INPUT_EFFORT: "high",
      FALLBACK_MODEL: "fallback-model",
      FALLBACK_EFFORT: "fallback-effort",
    },
  });

  assert.equal(outputs.resolved_model, "gpt-6-review");
  assert.equal(outputs.resolved_effort, "high");
});

test("load-trusted-review-config fails on invalid config keys", (t) => {
  const repoDir = createRepo(t, "lgtm-config-");

  writeRepoFile(repoDir, ".github/lgtm/prompts/security.md", "Security prompt");
  writeRepoFile(
    repoDir,
    ".github/lgtm.yml",
    [
      "version: 1",
      "reviewers:",
      "  - id: security",
      "    display_name: Security",
      "    prompt_file: .github/lgtm/prompts/security.md",
      "    scope: security risk",
      "    unknown_field: bad",
    ].join("\n"),
  );
  const sha = commitAll(repoDir, "base");

  const result = runScriptExpectFailure({
    repoDir,
    scriptPath: SCRIPT_PATH,
    env: {
      BASE_SHA: sha,
      HEAD_SHA: sha,
      CONFIG_REL: ".github/lgtm.yml",
      INPUT_MODEL: "",
      INPUT_EFFORT: "",
      FALLBACK_MODEL: "fallback-model",
      FALLBACK_EFFORT: "fallback-effort",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown_field/);
});

test("load-trusted-review-config fails when trusted prompt is missing in base revision", (t) => {
  const repoDir = createRepo(t, "lgtm-config-");

  writeRepoFile(
    repoDir,
    ".github/lgtm.yml",
    [
      "version: 1",
      "reviewers:",
      "  - id: security",
      "    display_name: Security",
      "    prompt_file: .github/lgtm/prompts/security.md",
      "    scope: security risk",
    ].join("\n"),
  );
  const baseSha = commitAll(repoDir, "base");

  writeRepoFile(repoDir, ".github/lgtm/prompts/security.md", "Head-only prompt");
  const headSha = commitAll(repoDir, "head");

  const result = runScriptExpectFailure({
    repoDir,
    scriptPath: SCRIPT_PATH,
    env: {
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      CONFIG_REL: ".github/lgtm.yml",
      INPUT_MODEL: "",
      INPUT_EFFORT: "",
      FALLBACK_MODEL: "fallback-model",
      FALLBACK_EFFORT: "fallback-effort",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing trusted reviewer prompt in base revision/);
});
