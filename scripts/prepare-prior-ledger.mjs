#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeGithubOutput } from "./shared/github-output.mjs";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function emptyLedger() {
  return {
    version: 1,
    findings: [],
  };
}

function isLedgerObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function loadPriorLedger(sourceDir) {
  const normalizedSourceDir = normalizeText(sourceDir);
  if (!normalizedSourceDir) {
    return {
      ledger: emptyLedger(),
      source: "empty",
    };
  }

  const sourcePath = path.join(normalizedSourceDir, "findings-ledger.json");
  if (!fs.existsSync(sourcePath)) {
    return {
      ledger: emptyLedger(),
      source: "empty",
    };
  }

  const sourceBody = fs.readFileSync(sourcePath, "utf8");
  let parsed = null;
  try {
    parsed = JSON.parse(sourceBody);
  } catch (error) {
    throw new Error(`Invalid prior ledger JSON at ${sourcePath}: ${error.message}`);
  }

  if (!isLedgerObject(parsed) || !Array.isArray(parsed.findings)) {
    throw new Error(`Invalid prior ledger format at ${sourcePath}: expected object with findings array`);
  }

  return {
    ledger: {
      version: 1,
      findings: parsed.findings,
    },
    source: "artifact",
  };
}

function main() {
  const outputPath = normalizeText(process.env.PRIOR_LEDGER_JSON);
  if (!outputPath) {
    throw new Error("PRIOR_LEDGER_JSON is required");
  }

  const { ledger, source } = loadPriorLedger(process.env.PRIOR_ARTIFACT_DIR || "");

  ensureParentDir(outputPath);
  fs.writeFileSync(outputPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

  writeGithubOutput("prior_ledger_json", outputPath);
  writeGithubOutput("prior_ledger_source", source);

  process.stdout.write(`${JSON.stringify({ prior_ledger_json: outputPath, prior_ledger_source: source })}\n`);
}

function isCliMain() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCliMain()) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

export { loadPriorLedger, main };
