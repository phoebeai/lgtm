import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function git(repoDir, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: options.encoding ?? "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function writeRepoFile(repoDir, relativePath, contents) {
  const filePath = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

export function createRepo(t, prefix) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  git(repoDir, ["init"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test User"]);

  return repoDir;
}

export function commitAll(repoDir, message) {
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", message]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

export function parseGithubOutput(content) {
  const outputs = {};
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;

    const match = /^([^<]+)<<(.+)$/.exec(line);
    if (!match) continue;

    const [, key, delimiter] = match;
    const valueLines = [];
    i += 1;
    while (i < lines.length && lines[i] !== delimiter) {
      valueLines.push(lines[i]);
      i += 1;
    }
    outputs[key] = valueLines.join("\n");
  }

  return outputs;
}

export function runScript({ repoDir, scriptPath, env }) {
  const outputPath = path.join(repoDir, "github-output.txt");
  const stdout = execFileSync(process.execPath, [scriptPath], {
    cwd: repoDir,
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      ...env,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    stdout,
    outputs: parseGithubOutput(fs.readFileSync(outputPath, "utf8")),
  };
}

export function runScriptExpectFailure({ repoDir, scriptPath, env }) {
  try {
    runScript({ repoDir, scriptPath, env });
  } catch (error) {
    return {
      status: error.status,
      stderr: String(error.stderr || ""),
    };
  }
  throw new Error("Expected script to fail");
}
