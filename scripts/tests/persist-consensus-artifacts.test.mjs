import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { persistConsensusArtifacts } from "../persist-consensus-artifacts.mjs";

function createTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("persistConsensusArtifacts writes merged files and copies per-reviewer reports", (t) => {
  const runnerTemp = createTempDir(t, "lgtm-consensus-");
  const reportsDir = path.join(runnerTemp, "lgtm-reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, "security.json"), '{"reviewer":"security"}\n', "utf8");

  const commentPath = path.join(runnerTemp, "comment.md");
  fs.writeFileSync(commentPath, "<!-- codex-lgtm -->\nhello\n", "utf8");

  persistConsensusArtifacts({
    runnerTemp,
    reviewersJson: JSON.stringify([{ id: "security" }, { id: "test_quality" }]),
    consensusReports: '{"security":{"run_state":"completed"}}',
    outcome: "PASS",
    blockingFindingsCount: "0",
    reviewerErrorsCount: "0",
    commentPath,
  });

  const outputDir = path.join(runnerTemp, "lgtm");
  assert.equal(
    fs.readFileSync(path.join(outputDir, "security.json"), "utf8"),
    '{"reviewer":"security"}\n',
  );
  assert.equal(fs.readFileSync(path.join(outputDir, "test_quality.json"), "utf8"), "\n");
  assert.equal(
    fs.readFileSync(path.join(outputDir, "reports-merged.json"), "utf8"),
    '{"security":{"run_state":"completed"}}\n',
  );
  assert.equal(fs.readFileSync(path.join(outputDir, "outcome.txt"), "utf8"), "PASS\n");
  assert.equal(
    fs.readFileSync(path.join(outputDir, "blocking-findings-count.txt"), "utf8"),
    "0\n",
  );
  assert.equal(
    fs.readFileSync(path.join(outputDir, "reviewer-errors-count.txt"), "utf8"),
    "0\n",
  );
  assert.equal(
    fs.readFileSync(path.join(outputDir, "comment.md"), "utf8"),
    "<!-- codex-lgtm -->\nhello\n",
  );
});

test("persistConsensusArtifacts rejects malformed reviewer JSON", () => {
  assert.throws(
    () =>
      persistConsensusArtifacts({
        runnerTemp: "/tmp/x",
        reviewersJson: "{bad json",
        consensusReports: "{}",
        outcome: "PASS",
        blockingFindingsCount: "0",
        reviewerErrorsCount: "0",
        commentPath: "/tmp/comment.md",
      }),
    /Invalid REVIEWERS_JSON/,
  );
});
