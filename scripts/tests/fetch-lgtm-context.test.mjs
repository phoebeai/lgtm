import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = path.resolve(".agents/skills/lgtm/scripts/fetch_lgtm_context.sh");

function hasCommand(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
    stdio: "ignore",
  });
  return result.status === 0;
}

function createTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function createMockGh(t) {
  const rootDir = createTempDir(t, "fetch-lgtm-context-");
  const mockBinDir = path.join(rootDir, "bin");
  fs.mkdirSync(mockBinDir, { recursive: true });
  const logPath = path.join(rootDir, "gh.log");

  const mockGhPath = path.join(mockBinDir, "gh");
  writeExecutable(
    mockGhPath,
    `#!/usr/bin/env bash
set -euo pipefail

if [[ -n "\${MOCK_GH_LOG:-}" ]]; then
  printf '%s\\n' "$*" >> "\${MOCK_GH_LOG}"
fi

if [[ "\${1:-}" == "repo" && "\${2:-}" == "view" ]]; then
  printf '%s\\n' "\${MOCK_GH_REPO:-owner/repo}"
  exit 0
fi

if [[ "\${1:-}" == "run" && "\${2:-}" == "list" ]]; then
  if [[ " $* " == *" --workflow "* ]]; then
    if [[ -n "\${MOCK_GH_RUN_LIST_WORKFLOW:-}" ]]; then
      printf '%b\\n' "\${MOCK_GH_RUN_LIST_WORKFLOW}"
    fi
  else
    if [[ -n "\${MOCK_GH_RUN_LIST_FALLBACK:-}" ]]; then
      printf '%b\\n' "\${MOCK_GH_RUN_LIST_FALLBACK}"
    fi
  fi
  exit 0
fi

if [[ "\${1:-}" == "api" ]]; then
  endpoint="\${2:-}"
  if [[ "$endpoint" =~ ^repos/.+/actions/runs/([0-9]+)/artifacts\\?per_page=100$ ]]; then
    run_id="\${BASH_REMATCH[1]}"
    if [[ " \${MOCK_GH_ARTIFACT_RUNS:-} " == *" $run_id "* ]]; then
      printf 'artifact-%s\\n' "$run_id"
    fi
    exit 0
  fi
  if [[ "$endpoint" == repos/*/issues/*/comments?per_page=100 ]]; then
    printf '%b\\n' "\${MOCK_GH_ISSUE_COMMENTS_OUTPUT:-}"
    exit 0
  fi
  if [[ "$endpoint" == repos/*/pulls/*/comments?per_page=100 ]]; then
    printf '%b\\n' "\${MOCK_GH_INLINE_COMMENTS_OUTPUT:-}"
    exit 0
  fi
  echo "Unexpected gh api endpoint: $endpoint" >&2
  exit 1
fi

if [[ "\${1:-}" == "run" && "\${2:-}" == "download" ]]; then
  run_id="\${3:-}"
  dest=""
  next_is_dest=0
  for arg in "$@"; do
    if [[ "$next_is_dest" -eq 1 ]]; then
      dest="$arg"
      next_is_dest=0
      continue
    fi
    if [[ "$arg" == "-D" ]]; then
      next_is_dest=1
    fi
  done

  if [[ -z "$dest" ]]; then
    echo "Missing -D destination for gh run download" >&2
    exit 1
  fi

  mkdir -p "$dest"
  if [[ "\${MOCK_GH_SKIP_MERGED_REPORT:-0}" != "1" ]]; then
    cat > "$dest/reports-merged.json" <<'JSON'
{"security":{"run_state":"completed","new_findings":[],"resolved_finding_ids":[],"errors":[]}}
JSON
  fi
  if [[ "\${MOCK_GH_SKIP_LEDGER_REPORT:-0}" != "1" ]]; then
    cat > "$dest/findings-ledger.json" <<'JSON'
{"version":1,"findings":[]}
JSON
  fi
  exit 0
fi

if [[ "\${1:-}" == "run" && "\${2:-}" == "view" ]]; then
  run_id="\${3:-unknown}"
  printf 'https://example.test/runs/%s\\n' "$run_id"
  exit 0
fi

if [[ "\${1:-}" == "pr" && "\${2:-}" == "view" ]]; then
  if [[ "\${MOCK_GH_PR_VIEW_FAIL:-0}" == "1" ]]; then
    exit 1
  fi
  printf '%s\\n' "\${MOCK_GH_PR_NUMBER:-42}"
  exit 0
fi

echo "Unexpected gh invocation: $*" >&2
exit 1
`,
  );

  return {
    mockBinDir,
    logPath,
    rootDir,
  };
}

function runFetchScript({ mockBinDir, env, args }) {
  return spawnSync("bash", [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${mockBinDir}:${process.env.PATH}`,
      ...env,
    },
  });
}

test("fetch_lgtm_context falls back from LGTM workflow query to repo-wide run list", (t) => {
  if (!hasCommand("jq") || !hasCommand("git")) {
    t.skip("requires jq and git");
    return;
  }

  const { mockBinDir, logPath, rootDir } = createMockGh(t);
  const destRoot = path.join(rootDir, "bundle");

  const result = runFetchScript({
    mockBinDir,
    args: ["-R", "owner/repo", "-b", "feature/test", "-d", destRoot, "-p", "77"],
    env: {
      MOCK_GH_LOG: logPath,
      MOCK_GH_RUN_LIST_WORKFLOW: "",
      MOCK_GH_RUN_LIST_FALLBACK: "9201",
      MOCK_GH_ARTIFACT_RUNS: "9201",
      MOCK_GH_ISSUE_COMMENTS_OUTPUT: "",
      MOCK_GH_INLINE_COMMENTS_OUTPUT: "",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LGTM_RUN_ID=9201/);
  assert.match(result.stdout, /LGTM_PR_NUMBER=77/);

  const ghLog = fs.readFileSync(logPath, "utf8");
  const workflowQueryIndex = ghLog.indexOf("run list --workflow LGTM");
  const fallbackQueryIndex = ghLog.indexOf("run list --branch feature/test");
  assert.ok(workflowQueryIndex >= 0, "expected workflow-scoped run query");
  assert.ok(fallbackQueryIndex > workflowQueryIndex, "expected fallback run query after workflow query");
});

test("fetch_lgtm_context fails when reports-merged.json is missing from artifact", (t) => {
  if (!hasCommand("jq") || !hasCommand("git")) {
    t.skip("requires jq and git");
    return;
  }

  const { mockBinDir, rootDir } = createMockGh(t);
  const destRoot = path.join(rootDir, "bundle");

  const result = runFetchScript({
    mockBinDir,
    args: ["-R", "owner/repo", "-b", "feature/test", "-r", "9301", "-d", destRoot, "-p", "77"],
    env: {
      MOCK_GH_SKIP_MERGED_REPORT: "1",
      MOCK_GH_INLINE_COMMENTS_OUTPUT: "",
      MOCK_GH_ISSUE_COMMENTS_OUTPUT: "",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Downloaded artifact missing reports-merged\.json/);
});

test("fetch_lgtm_context fails when findings-ledger.json is missing from artifact", (t) => {
  if (!hasCommand("jq") || !hasCommand("git")) {
    t.skip("requires jq and git");
    return;
  }

  const { mockBinDir, rootDir } = createMockGh(t);
  const destRoot = path.join(rootDir, "bundle");

  const result = runFetchScript({
    mockBinDir,
    args: ["-R", "owner/repo", "-b", "feature/test", "-r", "9401", "-d", destRoot, "-p", "77"],
    env: {
      MOCK_GH_SKIP_LEDGER_REPORT: "1",
      MOCK_GH_INLINE_COMMENTS_OUTPUT: "",
      MOCK_GH_ISSUE_COMMENTS_OUTPUT: "",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Downloaded artifact missing findings-ledger\.json/);
});

test("fetch_lgtm_context skips PR steering when PR number cannot be resolved", (t) => {
  if (!hasCommand("jq") || !hasCommand("git")) {
    t.skip("requires jq and git");
    return;
  }

  const { mockBinDir, rootDir } = createMockGh(t);
  const destRoot = path.join(rootDir, "bundle");

  const result = runFetchScript({
    mockBinDir,
    args: ["-R", "owner/repo", "-b", "feature/test", "-r", "9501", "-d", destRoot],
    env: {
      MOCK_GH_PR_VIEW_FAIL: "1",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LGTM_PR_NUMBER=unknown/);
  assert.match(result.stdout, /PR comment steering skipped: unable to resolve PR number/);
});
