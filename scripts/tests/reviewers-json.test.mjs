import test from "node:test";
import assert from "node:assert/strict";
import {
  parseReviewerIds,
  parseReviewersForConsensus,
  parseReviewersForRunner,
} from "../shared/reviewers-json.mjs";

test("parseReviewersForRunner validates required fields and defaults paths_json", () => {
  const reviewers = parseReviewersForRunner(
    JSON.stringify([
      {
        id: "security",
        prompt_file: ".github/lgtm/prompts/security.md",
        scope: "security",
      },
    ]),
  );

  assert.deepEqual(reviewers, [
    {
      id: "security",
      prompt_file: ".github/lgtm/prompts/security.md",
      scope: "security",
      paths_json: "[]",
    },
  ]);
});

test("parseReviewersForConsensus returns reviewer labels with fallback to id", () => {
  const reviewers = parseReviewersForConsensus(
    JSON.stringify([
      { id: "security", display_name: "Security" },
      { id: "code_quality" },
    ]),
  );

  assert.deepEqual(reviewers, [
    { id: "security", display_name: "Security" },
    { id: "code_quality", display_name: "code_quality" },
  ]);
});

test("parseReviewerIds allows empty arrays for artifact persistence flows", () => {
  assert.deepEqual(parseReviewerIds("[]"), []);
});

test("parseReviewers helpers reject duplicate ids consistently", () => {
  assert.throws(
    () =>
      parseReviewersForRunner(
        JSON.stringify([
          { id: "security", prompt_file: "a.md", scope: "a" },
          { id: "security", prompt_file: "b.md", scope: "b" },
        ]),
      ),
    /Duplicate reviewer id in REVIEWERS_JSON: security/,
  );
});
