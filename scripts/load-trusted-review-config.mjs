#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import {
  defaultRunGit,
  gitObjectExists,
  readGitBlob,
  requireEnv,
} from "./shared/git-trusted-read.mjs";
import { writeGithubOutput } from "./shared/github-output.mjs";

const REVIEWER_ID_PATTERN = /^[a-z0-9_]+$/;
const UNSAFE_PATH_PATTERN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseYamlOrJson(input, sourceLabel) {
  try {
    return JSON.parse(input);
  } catch {
    // Fall through to YAML parser.
  }

  try {
    return parseYaml(input);
  } catch (error) {
    const reason = String(error?.message || "unknown parse error");
    throw new Error(`Invalid config in trusted base revision (${sourceLabel}): ${reason}`);
  }
}

function stripLegacyReviewerRequired(rawConfig) {
  if (!isPlainObject(rawConfig) || !Array.isArray(rawConfig.reviewers)) {
    return rawConfig;
  }

  return {
    ...rawConfig,
    reviewers: rawConfig.reviewers.map((rawReviewer) => {
      if (!isPlainObject(rawReviewer) || !Object.prototype.hasOwnProperty.call(rawReviewer, "required")) {
        return rawReviewer;
      }
      const { required: _ignoredRequired, ...rest } = rawReviewer;
      return rest;
    }),
  };
}

function loadConfigSchema() {
  const schemaUrl = new URL("../schemas/lgtm-config.schema.json", import.meta.url);
  try {
    return JSON.parse(fs.readFileSync(schemaUrl, "utf8"));
  } catch (error) {
    throw new Error(`Could not read config schema from ${schemaUrl.pathname}: ${error.message}`);
  }
}

function validateConfigAgainstSchema(config, schema, sourceLabel) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
  });
  const validate = ajv.compile(schema);
  if (validate(config)) {
    return;
  }

  const errors = Array.isArray(validate.errors) ? validate.errors : [];
  const reason =
    errors.length > 0
      ? errors
          .map((entry) => {
            const where = entry.instancePath ? entry.instancePath : "/";
            if (
              entry.keyword === "additionalProperties" &&
              entry.params &&
              typeof entry.params.additionalProperty === "string"
            ) {
              return `${where} unknown key: ${entry.params.additionalProperty}`;
            }
            return `${where} ${entry.message || "invalid"}`;
          })
          .join("; ")
      : "unknown schema validation error";

  throw new Error(`Config schema validation failed for ${sourceLabel}: ${reason}`);
}

function assertAllowedKeys(value, allowedKeys, context) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${context} contains unknown key: ${key}`);
    }
  }
}

function normalizeString(value, context) {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${context} must be a non-empty string`);
  }

  return normalized;
}

function ensureSafeRelativePath(value, context) {
  const normalized = normalizeString(value, context);

  if (UNSAFE_PATH_PATTERN.test(normalized)) {
    throw new Error(`${context} contains unsafe control characters`);
  }

  if (normalized.startsWith("/")) {
    throw new Error(`${context} must be a relative path`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`${context} cannot traverse parent directories`);
  }

  return normalized;
}

function normalizeReviewers(rawReviewers) {
  if (!Array.isArray(rawReviewers)) {
    throw new Error("reviewers must be an array");
  }

  if (rawReviewers.length === 0) {
    throw new Error("reviewers must contain at least one reviewer entry");
  }

  const ids = new Set();

  return rawReviewers.map((rawReviewer, index) => {
    const label = `reviewers[${index}]`;
    if (!isPlainObject(rawReviewer)) {
      throw new Error(`${label} must be an object`);
    }

    assertAllowedKeys(
      rawReviewer,
      new Set(["id", "display_name", "prompt_file", "scope", "paths"]),
      label,
    );

    const id = normalizeString(rawReviewer.id, `${label}.id`);
    if (!REVIEWER_ID_PATTERN.test(id)) {
      throw new Error(`${label}.id must match ${REVIEWER_ID_PATTERN}`);
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate reviewer id: ${id}`);
    }
    ids.add(id);

    const displayName = normalizeString(rawReviewer.display_name, `${label}.display_name`);
    const promptFile = ensureSafeRelativePath(rawReviewer.prompt_file, `${label}.prompt_file`);
    const scope = normalizeString(rawReviewer.scope, `${label}.scope`);

    let paths = [];
    if (rawReviewer.paths !== undefined) {
      if (!Array.isArray(rawReviewer.paths)) {
        throw new Error(`${label}.paths must be an array when provided`);
      }
      paths = rawReviewer.paths.map((entry, pathIndex) =>
        ensureSafeRelativePath(entry, `${label}.paths[${pathIndex}]`),
      );
    }

    return {
      id,
      display_name: displayName,
      prompt_file: promptFile,
      scope,
      paths_json: JSON.stringify(paths),
    };
  });
}

function normalizeConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) {
    throw new Error("config root must be an object");
  }

  assertAllowedKeys(rawConfig, new Set(["version", "defaults", "reviewers"]), "config");

  if (rawConfig.version !== 1) {
    throw new Error("config.version must be exactly 1");
  }

  let defaults = {};
  if (rawConfig.defaults !== undefined) {
    if (!isPlainObject(rawConfig.defaults)) {
      throw new Error("defaults must be an object when provided");
    }
    assertAllowedKeys(rawConfig.defaults, new Set(["model", "effort"]), "defaults");

    defaults = {
      model:
        rawConfig.defaults.model === undefined ? "" : normalizeString(rawConfig.defaults.model, "defaults.model"),
      effort:
        rawConfig.defaults.effort === undefined ? "" : normalizeString(rawConfig.defaults.effort, "defaults.effort"),
    };
  }

  const reviewers = normalizeReviewers(rawConfig.reviewers);

  return {
    version: 1,
    defaults,
    reviewers,
  };
}

function resolveModelOrEffort({ inputValue, configDefault, fallbackValue, fieldName }) {
  const trimmedInput = String(inputValue || "").trim();
  if (trimmedInput) return trimmedInput;

  const trimmedConfigDefault = String(configDefault || "").trim();
  if (trimmedConfigDefault) return trimmedConfigDefault;

  const trimmedFallback = String(fallbackValue || "").trim();
  if (!trimmedFallback) {
    throw new Error(`Missing fallback ${fieldName}; set ${fieldName} input or defaults.${fieldName}`);
  }

  return trimmedFallback;
}

export function loadTrustedReviewConfig({
  baseSha,
  headSha,
  configRel,
  inputModel,
  inputEffort,
  fallbackModel,
  fallbackEffort,
  runGit = defaultRunGit,
}) {
  const normalizedBaseSha = requireEnv("BASE_SHA", baseSha);
  const normalizedHeadSha = requireEnv("HEAD_SHA", headSha);
  const normalizedConfigRel = ensureSafeRelativePath(configRel, "CONFIG_REL");

  if (!gitObjectExists(`${normalizedBaseSha}^{commit}`, runGit)) {
    throw new Error(`Missing base commit in checkout: ${normalizedBaseSha}`);
  }

  if (!gitObjectExists(`${normalizedHeadSha}^{commit}`, runGit)) {
    throw new Error(`Missing head commit in checkout: ${normalizedHeadSha}`);
  }

  if (!gitObjectExists(`${normalizedBaseSha}:${normalizedConfigRel}`, runGit)) {
    throw new Error(`Missing trusted config in base revision: ${normalizedBaseSha}:${normalizedConfigRel}`);
  }

  const rawConfig = readGitBlob(
    `${normalizedBaseSha}:${normalizedConfigRel}`,
    "trusted review config in base revision",
    runGit,
  );
  const parsed = stripLegacyReviewerRequired(
    parseYamlOrJson(rawConfig, `${normalizedBaseSha}:${normalizedConfigRel}`),
  );
  validateConfigAgainstSchema(parsed, loadConfigSchema(), `${normalizedBaseSha}:${normalizedConfigRel}`);
  const config = normalizeConfig(parsed);

  for (const reviewer of config.reviewers) {
    if (!gitObjectExists(`${normalizedBaseSha}:${reviewer.prompt_file}`, runGit)) {
      throw new Error(
        `Missing trusted reviewer prompt in base revision: ${normalizedBaseSha}:${reviewer.prompt_file}`,
      );
    }
  }

  const resolvedModel = resolveModelOrEffort({
    inputValue: inputModel,
    configDefault: config.defaults.model,
    fallbackValue: fallbackModel,
    fieldName: "model",
  });

  const resolvedEffort = resolveModelOrEffort({
    inputValue: inputEffort,
    configDefault: config.defaults.effort,
    fallbackValue: fallbackEffort,
    fieldName: "effort",
  });

  return {
    reviewersJson: JSON.stringify(config.reviewers),
    resolvedModel,
    resolvedEffort,
  };
}

function main() {
  const result = loadTrustedReviewConfig({
    baseSha: process.env.BASE_SHA,
    headSha: process.env.HEAD_SHA,
    configRel: process.env.CONFIG_REL,
    inputModel: process.env.INPUT_MODEL,
    inputEffort: process.env.INPUT_EFFORT,
    fallbackModel: process.env.FALLBACK_MODEL,
    fallbackEffort: process.env.FALLBACK_EFFORT,
  });

  writeGithubOutput("reviewers_json", result.reviewersJson);
  writeGithubOutput("resolved_model", result.resolvedModel);
  writeGithubOutput("resolved_effort", result.resolvedEffort);

  process.stdout.write(
    JSON.stringify({
      reviewer_count: JSON.parse(result.reviewersJson).length,
      resolved_model: result.resolvedModel,
      resolved_effort: result.resolvedEffort,
    }),
  );
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
    process.exitCode = 1;
  }
}
