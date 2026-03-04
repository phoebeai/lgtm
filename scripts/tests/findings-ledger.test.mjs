import test from "node:test";
import assert from "node:assert/strict";
import {
  applyInlineCommentMetadata,
  buildFindingIdPrefix,
  mergeLedgerWithReports,
  normalizeLedger,
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
          id: "SEC002",
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
  assert.equal(result.ledger.findings[0].id, "SEC002");
  assert.equal(result.ledger.findings[1].id, "SEC003");
  assert.equal(result.openEntries.length, 2);
  assert.equal(result.newlyOpenedEntries.length, 1);
});

test("mergeLedgerWithReports resolves and reopens lifecycle using same finding id", () => {
  const mergedResolved = mergeLedgerWithReports({
    priorLedger: {
      version: 1,
      findings: [
        {
          id: "SEC001",
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
        resolved_finding_ids: ["SEC001"],
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
            reopen_finding_id: "SEC001",
          },
        ],
      },
    },
    reviewers: [{ id: "security" }],
    runId: "103",
    timestamp: "2026-03-04T02:00:00.000Z",
  });

  assert.equal(mergedReopened.ledger.findings.length, 1);
  assert.equal(mergedReopened.ledger.findings[0].id, "SEC001");
  assert.equal(mergedReopened.ledger.findings[0].status, "open");
  assert.equal(mergedReopened.reopenedEntries.length, 1);
});

test("mergeLedgerWithReports resolves finding when reviewer reports resolved_finding_ids", () => {
  const merged = mergeLedgerWithReports({
    priorLedger: {
      version: 1,
      findings: [
        {
          id: "SEC001",
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
        resolved_finding_ids: ["SEC001"],
        new_findings: [],
      },
    },
    reviewers: [{ id: "security" }],
    runId: "102",
    timestamp: "2026-03-04T01:00:00.000Z",
  });

  assert.equal(merged.ledger.findings[0].status, "resolved");
  assert.equal(merged.newlyResolvedEntries.length, 1);
});

test("mergeLedgerWithReports throws when reopen_finding_id does not exist", () => {
  assert.throws(
    () =>
      mergeLedgerWithReports({
        priorLedger: {
          version: 1,
          findings: [],
        },
        reports: {
          security: {
            run_state: "completed",
            resolved_finding_ids: [],
            new_findings: [
              {
                title: "Reopen missing finding",
                recommendation: "Fix",
                file: "src/a.ts",
                line: 1,
                reopen_finding_id: "SEC001",
              },
            ],
          },
        },
        reviewers: [{ id: "security" }],
        runId: "104",
        timestamp: "2026-03-04T03:00:00.000Z",
      }),
    /reopen_finding_id SEC001 does not exist in prior ledger/,
  );
});

test("mergeLedgerWithReports throws when resolved_finding_ids contains malformed ids", () => {
  assert.throws(
    () =>
      mergeLedgerWithReports({
        priorLedger: {
          version: 1,
          findings: [
            {
              id: "SEC001",
              reviewer: "security",
              status: "open",
              title: "Issue",
              recommendation: "Fix",
              file: "src/a.ts",
              line: 1,
            },
          ],
        },
        reports: {
          security: {
            run_state: "completed",
            resolved_finding_ids: ["SEC-ABC"],
            new_findings: [],
          },
        },
        reviewers: [{ id: "security" }],
        runId: "105",
        timestamp: "2026-03-04T04:00:00.000Z",
      }),
    /resolved_finding_ids includes invalid finding id/,
  );
});

test("applyInlineCommentMetadata updates comment linkage fields", () => {
  const updated = applyInlineCommentMetadata({
    ledger: {
      version: 1,
      findings: [
        {
          id: "SEC001",
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
        finding: { id: "SEC001" },
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

test("normalizeLedger throws when findings contain malformed entries", () => {
  assert.throws(
    () =>
      normalizeLedger({
        version: 1,
        findings: [{ id: "", reviewer: "security", status: "open", title: "" }],
      }),
    /must include non-empty id, reviewer, and title/,
  );
});

test("normalizeLedger throws when duplicate finding ids are present", () => {
  assert.throws(
    () =>
      normalizeLedger({
        version: 1,
        findings: [
          { id: "SEC001", reviewer: "security", status: "open", title: "one" },
          { id: "sec-1", reviewer: "security", status: "open", title: "two" },
        ],
      }),
    /duplicate finding id in ledger: SEC001/,
  );
});
