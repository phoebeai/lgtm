#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";

function buildDelimiter(serialized) {
  const base = `EOF_${crypto.randomUUID().replace(/-/g, "")}`;
  if (!serialized.includes(base)) return base;

  let suffix = 0;
  while (serialized.includes(`${base}_${suffix}`)) {
    suffix += 1;
  }

  return `${base}_${suffix}`;
}

export function writeGithubOutput(name, value, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;

  const serialized = String(value ?? "");
  const delimiter = buildDelimiter(serialized);
  fs.appendFileSync(outputPath, `${name}<<${delimiter}\n${serialized}\n${delimiter}\n`);
}
