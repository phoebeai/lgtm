#!/usr/bin/env node

import { execFileSync } from "node:child_process";

export function requireEnv(name, value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return normalized;
}

export function defaultRunGit(args, { encoding = "utf8" } = {}) {
  return execFileSync("git", args, {
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function gitObjectExists(spec, runGit = defaultRunGit) {
  try {
    runGit(["cat-file", "-e", spec], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

export function readGitBlob(spec, label, runGit = defaultRunGit) {
  try {
    return runGit(["show", spec], { encoding: "utf8" });
  } catch {
    throw new Error(`Missing ${label}: ${spec}`);
  }
}
