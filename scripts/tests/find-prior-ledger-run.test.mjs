import test from "node:test";
import assert from "node:assert/strict";
import { findPriorLedgerRun } from "../find-prior-ledger-run.mjs";

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

test("findPriorLedgerRun selects latest valid prior run for same PR using current workflow scope", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requestedUrls = [];

  globalThis.fetch = async (url) => {
    const target = String(url);
    requestedUrls.push(target);

    if (target.endsWith("/actions/runs/120")) {
      return jsonResponse({
        id: 120,
        workflow_id: 999,
      });
    }

    if (target.includes("/actions/workflows/999/runs?")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 130,
            workflow_id: 999,
            created_at: "2026-03-03T10:00:00Z",
            pull_requests: [{ number: 7 }],
          },
          {
            id: 119,
            workflow_id: 999,
            created_at: "2026-03-03T09:00:00Z",
            pull_requests: [{ number: 9 }],
          },
          {
            id: 118,
            workflow_id: 999,
            created_at: "2026-03-03T08:00:00Z",
            pull_requests: [{ number: 7 }],
          },
          {
            id: 117,
            workflow_id: 999,
            created_at: "2026-03-03T07:00:00Z",
            pull_requests: [{ number: 7 }],
          },
          {
            id: 116,
            workflow_id: 999,
            created_at: "2026-03-03T06:00:00Z",
            pull_requests: [{ number: 7 }],
          },
        ],
      });
    }

    if (target.endsWith("/actions/runs/118/artifacts?per_page=100")) {
      return jsonResponse({
        artifacts: [
          {
            name: "lgtm-118",
            expired: true,
          },
        ],
      });
    }

    if (target.endsWith("/actions/runs/117/artifacts?per_page=100")) {
      return jsonResponse({
        artifacts: [],
      });
    }

    if (target.endsWith("/actions/runs/116/artifacts?per_page=100")) {
      return jsonResponse({
        artifacts: [
          {
            name: "lgtm-116",
            expired: false,
          },
        ],
      });
    }

    throw new Error(`Unexpected request: ${target}`);
  };

  const result = await findPriorLedgerRun({
    token: "token",
    repo: "owner/repo",
    prNumber: "7",
    currentRunId: "120",
  });

  assert.deepEqual(result, {
    prior_run_id: "116",
    prior_artifact_name: "lgtm-116",
  });
  assert.ok(
    requestedUrls.some((url) => url.includes("/actions/workflows/999/runs?status=completed&per_page=100&page=1")),
  );
  assert.ok(requestedUrls.every((url) => !url.includes("event=pull_request")));
  assert.ok(requestedUrls.every((url) => !url.endsWith("/actions/runs/130/artifacts?per_page=100")));
  assert.ok(requestedUrls.every((url) => !url.endsWith("/actions/runs/119/artifacts?per_page=100")));
});

test("findPriorLedgerRun paginates workflow runs when first page has no valid artifact", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const target = String(url);

    if (target.endsWith("/actions/runs/220")) {
      return jsonResponse({
        id: 220,
        workflow_id: 55,
      });
    }

    if (target.includes("/actions/workflows/55/runs?status=completed&per_page=100&page=1")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 219,
            workflow_id: 55,
            created_at: "2026-03-03T10:00:00Z",
            pull_requests: [{ number: 3 }],
          },
        ],
      });
    }

    if (target.endsWith("/actions/runs/219/artifacts?per_page=100")) {
      return jsonResponse({
        artifacts: [],
      });
    }

    if (target.includes("/actions/workflows/55/runs?status=completed&per_page=100&page=2")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 218,
            workflow_id: 55,
            created_at: "2026-03-03T09:00:00Z",
            pull_requests: [{ number: 3 }],
          },
        ],
      });
    }

    if (target.endsWith("/actions/runs/218/artifacts?per_page=100")) {
      return jsonResponse({
        artifacts: [
          {
            name: "lgtm-218",
            expired: false,
          },
        ],
      });
    }

    throw new Error(`Unexpected request: ${target}`);
  };

  const result = await findPriorLedgerRun({
    token: "token",
    repo: "owner/repo",
    prNumber: "3",
    currentRunId: "220",
  });

  assert.equal(result.prior_run_id, "218");
  assert.equal(result.prior_artifact_name, "lgtm-218");
});

test("findPriorLedgerRun returns empty values when no prior run has non-expired ledger artifact", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const target = String(url);

    if (target.endsWith("/actions/runs/77")) {
      return jsonResponse({
        id: 77,
        workflow_id: 12,
      });
    }

    if (target.includes("/actions/workflows/12/runs?status=completed&per_page=100&page=1")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 76,
            workflow_id: 12,
            created_at: "2026-03-02T09:00:00Z",
            pull_requests: [{ number: 4 }],
          },
        ],
      });
    }

    if (target.endsWith("/actions/runs/76/artifacts?per_page=100")) {
      return jsonResponse({
        artifacts: [
          {
            name: "lgtm-76",
            expired: true,
          },
        ],
      });
    }

    if (target.includes("/actions/workflows/12/runs?status=completed&per_page=100&page=2")) {
      return jsonResponse({
        workflow_runs: [],
      });
    }

    throw new Error(`Unexpected request: ${target}`);
  };

  const result = await findPriorLedgerRun({
    token: "token",
    repo: "owner/repo",
    prNumber: "4",
    currentRunId: "77",
  });

  assert.deepEqual(result, {
    prior_run_id: "",
    prior_artifact_name: "",
  });
});

test("findPriorLedgerRun falls back to repository run listing when current workflow id is unavailable", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requestedUrls = [];

  globalThis.fetch = async (url) => {
    const target = String(url);
    requestedUrls.push(target);

    if (target.endsWith("/actions/runs/90")) {
      return jsonResponse({
        id: 90,
        workflow_id: null,
      });
    }

    if (target.includes("/actions/runs?status=completed&per_page=100&page=1")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 89,
            workflow_id: 201,
            created_at: "2026-03-01T09:00:00Z",
            pull_requests: [{ number: 11 }],
          },
        ],
      });
    }

    if (target.endsWith("/actions/runs/89/artifacts?per_page=100")) {
      return jsonResponse({
        artifacts: [
          {
            name: "lgtm-89",
            expired: false,
          },
        ],
      });
    }

    throw new Error(`Unexpected request: ${target}`);
  };

  const result = await findPriorLedgerRun({
    token: "token",
    repo: "owner/repo",
    prNumber: "11",
    currentRunId: "90",
  });

  assert.equal(result.prior_run_id, "89");
  assert.ok(requestedUrls.some((url) => url.includes("/actions/runs?status=completed&per_page=100&page=1")));
});
