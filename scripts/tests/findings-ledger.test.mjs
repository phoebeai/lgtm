import test from "node:test";
import assert from "node:assert/strict";
import {
  applyInlineCommentMetadata,
  buildFindingIdPrefix,
  mergeLedgerWithReports,
} from "../shared/findings-ledger.mjs";

test("buildFindingIdPrefix uses known and derived reviewer prefixes", () => {
  assert.equal(buildFindingIdPrefix("security"), "SEC");
  assert.equal(buildFindingIdPrefix("test_quality"), "TQ");
  assert.equal(buildFindingIdPrefix("infra_ops"), "IO");
  assert.equal(buildFindingIdPrefix("abc"), "ABC");
});

test("mergeLedgerWithReports allocates reviewer-prefixed IDs and preserves open entries", () => {
  const result = mergeLedgerWithReports({
    priorLedger: {
      version: 1,
      findings: [
        {
          id: "SEC-2",
          reviewer: "security",
          status: "open",
          title: "Existing",
          recommendation: "Fix",
          file: "src/a.ts",
          line: 1,
        },
      ],
    },
    reports: {
      security: {
        run_state: "completed",
        resolved_finding_ids: [],
        new_findings: [
          {
            title: "New one",
            file: "src/b.ts",
            line: 2,
            recommendation: "Fix it",
            reopen_finding_id: null,
          },
        ],
      },
    },
    reviewers: [{ id: "security" }],
    runId: "101",
    timestamp: "2026-03-04T00:00:00.000Z",
  });

  assert.equal(result.ledger.findings.length, 2);
  assert.equal(result.ledger.findings[0].id, "SEC-2");
  assert.equal(result.ledger.findings[1].id, "SEC-3");
  assert.equal(result.openEntries.length, 2);
  assert.equal(result.newlyOpenedEntries.length, 1);
});

test("mergeLedgerWithReports resolves and reopens lifecycle using same finding id", () => {
  const mergedResolved = mergeLedgerWithReports({
    priorLedger: {
      version: 1,
      findings: [
        {
          id: "SEC-1",
          reviewer: "security",
          status: "open",
          title: "Existing",
          recommendation: "Fix",
          file: "src/a.ts",
          line: 1,
          inline_thread_id: "thread-1",
        },
      ],
    },
    reports: {
      security: {
        run_state: "completed",
        resolved_finding_ids: ["SEC-1"],
        new_findings: [],
      },
    },
    reviewers: [{ id: "security" }],
    runId: "102",
    timestamp: "2026-03-04T01:00:00.000Z",
  });

  assert.equal(mergedResolved.ledger.findings[0].status, "resolved");
  assert.equal(mergedResolved.newlyResolvedEntries.length, 1);

  const mergedReopened = mergeLedgerWithReports({
    priorLedger: mergedResolved.ledger,
    reports: {
      security: {
        run_state: "completed",
        resolved_finding_ids: [],
        new_findings: [
          {
            title: "Existing reopened",
            file: "src/a.ts",
            line: 1,
            recommendation: "Fix again",
            reopen_finding_id: "SEC-1",
          },
        ],
      },
    },
    reviewers: [{ id: "security" }],
    runId: "103",
    timestamp: "2026-03-04T02:00:00.000Z",
  });

  assert.equal(mergedReopened.ledger.findings.length, 1);
  assert.equal(mergedReopened.ledger.findings[0].id, "SEC-1");
  assert.equal(mergedReopened.ledger.findings[0].status, "open");
  assert.equal(mergedReopened.reopenedEntries.length, 1);
});

test("applyInlineCommentMetadata updates comment linkage fields", () => {
  const updated = applyInlineCommentMetadata({
    ledger: {
      version: 1,
      findings: [
        {
          id: "SEC-1",
          reviewer: "security",
          status: "open",
          title: "Issue",
          recommendation: "Fix",
          file: "src/a.ts",
          line: 1,
        },
      ],
    },
    entries: [
      {
        finding: { id: "SEC-1" },
        comment_id: 321,
        comment_url: "https://example.com/comment/321",
        inline_thread_id: "thread-321",
      },
    ],
  });

  assert.equal(updated.findings[0].inline_comment_id, 321);
  assert.equal(updated.findings[0].inline_comment_url, "https://example.com/comment/321");
  assert.equal(updated.findings[0].inline_thread_id, "thread-321");
});
