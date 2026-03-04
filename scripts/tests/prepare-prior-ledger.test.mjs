import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadPriorLedger } from "../prepare-prior-ledger.mjs";
import { runScript, runScriptExpectFailure } from "./test-utils.mjs";

const SCRIPT_PATH = path.resolve("scripts/prepare-prior-ledger.mjs");

function createTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("loadPriorLedger returns empty ledger when PRIOR_ARTIFACT_DIR is not provided", () => {
  const result = loadPriorLedger("");
  assert.deepEqual(result, {
    ledger: {
      version: 1,
      findings: [],
    },
    source: "empty",
  });
});

test("loadPriorLedger returns empty ledger when findings-ledger.json is missing", (t) => {
  const sourceDir = createTempDir(t, "prepare-prior-ledger-missing-");
  const result = loadPriorLedger(sourceDir);
  assert.deepEqual(result, {
    ledger: {
      version: 1,
      findings: [],
    },
    source: "empty",
  });
});

test("loadPriorLedger throws when findings-ledger.json is malformed", (t) => {
  const sourceDir = createTempDir(t, "prepare-prior-ledger-malformed-");
  fs.writeFileSync(path.join(sourceDir, "findings-ledger.json"), "{not-json", "utf8");
  assert.throws(() => loadPriorLedger(sourceDir), /Invalid prior ledger JSON/);
});

test("loadPriorLedger throws when findings-ledger.json has invalid shape", (t) => {
  const sourceDir = createTempDir(t, "prepare-prior-ledger-invalid-shape-");
  fs.writeFileSync(path.join(sourceDir, "findings-ledger.json"), "[]", "utf8");
  assert.throws(() => loadPriorLedger(sourceDir), /Invalid prior ledger format/);
});

test("loadPriorLedger loads valid findings-ledger.json from prior artifact", (t) => {
  const sourceDir = createTempDir(t, "prepare-prior-ledger-valid-");
  fs.writeFileSync(
    path.join(sourceDir, "findings-ledger.json"),
    `${JSON.stringify(
      {
        version: 1,
        findings: [
          {
            id: "SEC001",
            reviewer: "security",
            status: "open",
            title: "Issue",
            recommendation: "Fix it",
            file: "src/a.ts",
            line: 3,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const result = loadPriorLedger(sourceDir);
  assert.equal(result.source, "artifact");
  assert.equal(result.ledger.version, 1);
  assert.equal(result.ledger.findings.length, 1);
  assert.equal(result.ledger.findings[0].id, "SEC001");
});

test("prepare-prior-ledger CLI writes output path and source metadata", (t) => {
  const repoDir = createTempDir(t, "prepare-prior-ledger-cli-");
  const sourceDir = path.join(repoDir, "artifact");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, "findings-ledger.json"),
    '{"version":1,"findings":[{"id":"TQ001","reviewer":"test_quality","status":"open","title":"x"}]}\n',
    "utf8",
  );

  const outputPath = path.join(repoDir, "out", "prior-ledger.json");
  const { outputs } = runScript({
    repoDir,
    scriptPath: SCRIPT_PATH,
    env: {
      PRIOR_ARTIFACT_DIR: sourceDir,
      PRIOR_LEDGER_JSON: outputPath,
    },
  });

  assert.equal(outputs.prior_ledger_json, outputPath);
  assert.equal(outputs.prior_ledger_source, "artifact");
  const written = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(written.version, 1);
  assert.equal(written.findings.length, 1);
  assert.equal(written.findings[0].id, "TQ001");
});

test("prepare-prior-ledger CLI fails when PRIOR_LEDGER_JSON is missing", (t) => {
  const repoDir = createTempDir(t, "prepare-prior-ledger-cli-env-");
  const result = runScriptExpectFailure({
    repoDir,
    scriptPath: SCRIPT_PATH,
    env: {
      PRIOR_ARTIFACT_DIR: "",
      PRIOR_LEDGER_JSON: "",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /PRIOR_LEDGER_JSON is required/);
});

test("prepare-prior-ledger CLI fails when findings-ledger.json is malformed", (t) => {
  const repoDir = createTempDir(t, "prepare-prior-ledger-cli-invalid-");
  const sourceDir = path.join(repoDir, "artifact");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "findings-ledger.json"), "{oops", "utf8");

  const result = runScriptExpectFailure({
    repoDir,
    scriptPath: SCRIPT_PATH,
    env: {
      PRIOR_ARTIFACT_DIR: sourceDir,
      PRIOR_LEDGER_JSON: path.join(repoDir, "out", "prior-ledger.json"),
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid prior ledger JSON/);
});
