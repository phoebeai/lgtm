import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrustedReviewerInputs,
  filterFilesForReviewer,
  serializePathForPrompt,
} from "../build-trusted-reviewer-inputs.mjs";
import {
  commitAll,
  createRepo,
  runScript,
  runScriptExpectFailure,
  writeRepoFile,
} from "./test-utils.mjs";

const SCRIPT_PATH = path.resolve("scripts/build-trusted-reviewer-inputs.mjs");

test("build-trusted-reviewer-inputs writes trusted prompt from base revision and copies committed schema file", (t) => {
  const repoDir = createRepo(t, "lgtm-trusted-inputs-");
  writeRepoFile(repoDir, ".github/lgtm/prompts/security.md", "BASE PROMPT CONTENT");
  writeRepoFile(repoDir, "src/keep.txt", "base");
  const baseSha = commitAll(repoDir, "base");

  writeRepoFile(repoDir, ".github/lgtm/prompts/security.md", "UNTRUSTED HEAD PROMPT");
  writeRepoFile(repoDir, "src/changed.txt", "changed");
  writeRepoFile(repoDir, 'src/a"b.txt', "quoted");
  const headSha = commitAll(repoDir, "head");

  const schemaPath = path.join(repoDir, "trusted-reviewer-output.schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify({ marker: "committed-schema" }, null, 2), "utf8");

  const outputDir = path.join(repoDir, "tmp-out");
  const { stdout, outputs } = runScript({
    repoDir,
    scriptPath: SCRIPT_PATH,
    env: {
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      REVIEWER: "security",
      REVIEW_SCOPE: "security risk",
      PR_NUMBER: "123",
      REPOSITORY: "phoebeai/service",
      PROMPT_REL: ".github/lgtm/prompts/security.md",
      SCHEMA_FILE: schemaPath,
      OUTPUT_DIR: outputDir,
    },
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.reviewerActive, true);
  assert.equal(outputs.reviewer_active, "true");
  assert.equal(outputs.skip_reason, "");

  const promptContents = fs.readFileSync(outputs.prompt_path, "utf8");
  assert.match(promptContents, new RegExp(`Base commit: ${baseSha}`));
  assert.match(promptContents, new RegExp(`Head commit: ${headSha}`));
  assert.match(promptContents, /- "src\/changed\.txt"/);
  assert.match(promptContents, /- "src\/a\\"b\.txt"/);
  assert.match(promptContents, /BASE PROMPT CONTENT/);
  assert.doesNotMatch(promptContents, /UNTRUSTED HEAD PROMPT/);

  const outputSchema = fs.readFileSync(outputs.schema_path, "utf8");
  assert.match(outputSchema, /"committed-schema"/);
});

test("build-trusted-reviewer-inputs marks reviewer inactive when no files changed", (t) => {
  const repoDir = createRepo(t, "lgtm-trusted-inputs-");
  writeRepoFile(repoDir, ".github/lgtm/prompts/security.md", "BASE PROMPT CONTENT");
  writeRepoFile(repoDir, "src/file.txt", "base");
  const sha = commitAll(repoDir, "base");

  const schemaPath = path.join(repoDir, "trusted-reviewer-output.schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify({ marker: "schema" }), "utf8");

  const { stdout, outputs } = runScript({
    repoDir,
    scriptPath: SCRIPT_PATH,
    env: {
      BASE_SHA: sha,
      HEAD_SHA: sha,
      REVIEWER: "security",
      REVIEW_SCOPE: "security risk",
      PR_NUMBER: "123",
      REPOSITORY: "phoebeai/service",
      PROMPT_REL: ".github/lgtm/prompts/security.md",
      SCHEMA_FILE: schemaPath,
      OUTPUT_DIR: path.join(repoDir, "tmp-out"),
    },
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.reviewerActive, false);
  assert.equal(outputs.reviewer_active, "false");
  assert.equal(outputs.prompt_path, "");
  assert.equal(outputs.schema_path, "");
  assert.match(outputs.skip_reason, /No changed files detected/);
});

test("build-trusted-reviewer-inputs marks reviewer inactive when changed files do not match path filters", (t) => {
  const repoDir = createRepo(t, "lgtm-trusted-inputs-");
  writeRepoFile(repoDir, ".github/lgtm/prompts/security.md", "BASE PROMPT CONTENT");
  writeRepoFile(repoDir, "src/file.txt", "base");
  const baseSha = commitAll(repoDir, "base");

  writeRepoFile(repoDir, "docs/readme.md", "head");
  const headSha = commitAll(repoDir, "head");

  const schemaPath = path.join(repoDir, "trusted-reviewer-output.schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify({ marker: "schema" }), "utf8");

  const { stdout, outputs } = runScript({
    repoDir,
    scriptPath: SCRIPT_PATH,
    env: {
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      REVIEWER: "security",
      REVIEW_SCOPE: "security risk",
      PR_NUMBER: "123",
      REPOSITORY: "phoebeai/service",
      PROMPT_REL: ".github/lgtm/prompts/security.md",
      SCHEMA_FILE: schemaPath,
      PATH_FILTERS_JSON: JSON.stringify(["src/**"]),
      OUTPUT_DIR: path.join(repoDir, "tmp-out"),
    },
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.reviewerActive, false);
  assert.equal(outputs.reviewer_active, "false");
  assert.match(outputs.skip_reason, /No changed files matched reviewer path filters/);
});

test("build-trusted-reviewer-inputs fails when schema file is missing", (t) => {
  const repoDir = createRepo(t, "lgtm-trusted-inputs-");
  writeRepoFile(repoDir, ".github/lgtm/prompts/security.md", "BASE PROMPT CONTENT");
  writeRepoFile(repoDir, "src/file.txt", "base");
  const baseSha = commitAll(repoDir, "base");

  writeRepoFile(repoDir, "src/file.txt", "head");
  const headSha = commitAll(repoDir, "head");

  const result = runScriptExpectFailure({
    repoDir,
    scriptPath: SCRIPT_PATH,
    env: {
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      REVIEWER: "security",
      REVIEW_SCOPE: "security risk",
      PR_NUMBER: "123",
      REPOSITORY: "phoebeai/service",
      PROMPT_REL: ".github/lgtm/prompts/security.md",
      SCHEMA_FILE: path.join(repoDir, "missing-schema.json"),
      OUTPUT_DIR: path.join(repoDir, "tmp-out"),
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing output schema file/);
});

test("build-trusted-reviewer-inputs rejects invalid reviewer ids before writing files", (t) => {
  const repoDir = createRepo(t, "lgtm-trusted-inputs-");
  writeRepoFile(repoDir, ".github/lgtm/prompts/security.md", "BASE PROMPT CONTENT");
  writeRepoFile(repoDir, "src/file.txt", "base");
  const baseSha = commitAll(repoDir, "base");

  writeRepoFile(repoDir, "src/file.txt", "head");
  const headSha = commitAll(repoDir, "head");

  const schemaPath = path.join(repoDir, "trusted-reviewer-output.schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify({ marker: "schema" }), "utf8");

  const result = runScriptExpectFailure({
    repoDir,
    scriptPath: SCRIPT_PATH,
    env: {
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      REVIEWER: "../security",
      REVIEW_SCOPE: "security risk",
      PR_NUMBER: "123",
      REPOSITORY: "phoebeai/service",
      PROMPT_REL: ".github/lgtm/prompts/security.md",
      SCHEMA_FILE: schemaPath,
      OUTPUT_DIR: path.join(repoDir, "tmp-out"),
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /REVIEWER must match/);
});

test("filterFilesForReviewer supports multiple globs", () => {
  const filtered = filterFilesForReviewer(
    ["src/app/main.ts", "compose.yaml", "docs/readme.md"],
    ["src/**", "compose*.yaml"],
  );

  assert.deepEqual(filtered, ["src/app/main.ts", "compose.yaml"]);
});

test("serializePathForPrompt rejects unsafe control and line-separator characters", () => {
  assert.equal(serializePathForPrompt('safe"file.txt'), '"safe\\"file.txt"');
  assert.throws(
    () => serializePathForPrompt("unsafe\u2028file.txt"),
    /cannot be safely rendered/,
  );
  assert.throws(
    () => serializePathForPrompt("unsafe\u2029file.txt"),
    /cannot be safely rendered/,
  );
  assert.throws(
    () => serializePathForPrompt("unsafe\u009Ffile.txt"),
    /cannot be safely rendered/,
  );
});

test("buildTrustedReviewerInputs helper enforces valid path filters JSON", () => {
  assert.throws(
    () =>
      buildTrustedReviewerInputs({
        baseSha: "a",
        headSha: "b",
        reviewer: "security",
        reviewScope: "security",
        prNumber: "1",
        repository: "owner/repo",
        promptRel: "prompt.md",
        schemaFile: "schema.json",
        pathFiltersJson: "{bad json",
        outputDir: "out",
        runGit: () => {
          throw new Error("unreachable");
        },
      }),
    /PATH_FILTERS_JSON must be valid JSON array/,
  );
});

test("buildTrustedReviewerInputs injects prior finding memory for scoped files", (t) => {
  const repoDir = createRepo(t, "lgtm-trusted-inputs-");
  writeRepoFile(repoDir, ".github/lgtm/prompts/security.md", "BASE PROMPT CONTENT");
  writeRepoFile(repoDir, "src/file.txt", "base");
  const baseSha = commitAll(repoDir, "base");

  writeRepoFile(repoDir, "src/file.txt", "head");
  const headSha = commitAll(repoDir, "head");

  const schemaPath = path.join(repoDir, "trusted-reviewer-output.schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify({ marker: "schema" }), "utf8");

  const result = buildTrustedReviewerInputs({
    baseSha,
    headSha,
    reviewer: "security",
    reviewScope: "security risk",
    prNumber: "123",
    repository: "phoebeai/service",
    promptRel: ".github/lgtm/prompts/security.md",
    schemaFile: schemaPath,
    outputDir: path.join(repoDir, "tmp-out"),
    priorFindingEntries: [
      {
        path: "src/file.txt",
        line: 1,
        resolved: true,
        body: "**Security (blocking):** Existing issue",
        url: "https://example.com/comment/1",
      },
    ],
    runGit: (args, { encoding = "utf8" } = {}) =>
      execFileSync("git", args, {
        cwd: repoDir,
        encoding,
        stdio: ["ignore", "pipe", "pipe"],
      }),
  });

  const promptContents = fs.readFileSync(result.promptPath, "utf8");
  assert.match(promptContents, /Previously posted finding comments for files in this reviewer scope/);
  assert.match(promptContents, /Existing issue/);
  assert.match(promptContents, /Do not repeat or restate findings/);
});

test("buildTrustedReviewerInputs includes all scoped prior findings in prompt", (t) => {
  const repoDir = createRepo(t, "lgtm-trusted-inputs-");
  writeRepoFile(repoDir, ".github/lgtm/prompts/security.md", "BASE PROMPT CONTENT");
  writeRepoFile(repoDir, "src/file.txt", "base");
  const baseSha = commitAll(repoDir, "base");

  writeRepoFile(repoDir, "src/file.txt", "head");
  const headSha = commitAll(repoDir, "head");

  const schemaPath = path.join(repoDir, "trusted-reviewer-output.schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify({ marker: "schema" }), "utf8");

  const priorFindingEntries = Array.from({ length: 25 }, (_, index) => ({
    path: "src/file.txt",
    line: index + 1,
    resolved: index % 2 === 0,
    body: `**Security (blocking):** Existing issue ${index}`,
    url: `https://example.com/comment/${index}`,
  }));

  const result = buildTrustedReviewerInputs({
    baseSha,
    headSha,
    reviewer: "security",
    reviewScope: "security risk",
    prNumber: "123",
    repository: "phoebeai/service",
    promptRel: ".github/lgtm/prompts/security.md",
    schemaFile: schemaPath,
    outputDir: path.join(repoDir, "tmp-out"),
    priorFindingEntries,
    runGit: (args, { encoding = "utf8" } = {}) =>
      execFileSync("git", args, {
        cwd: repoDir,
        encoding,
        stdio: ["ignore", "pipe", "pipe"],
      }),
  });

  const promptContents = fs.readFileSync(result.promptPath, "utf8");
  assert.match(promptContents, /"title":"Existing issue 24"/);
});
