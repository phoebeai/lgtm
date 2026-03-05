import test from "node:test";
import assert from "node:assert/strict";
import { approvePrWhenClean } from "../approve-pr-when-clean.mjs";

function makeStderrCapture() {
  let output = "";
  return {
    write(value) {
      output += String(value || "");
    },
    read() {
      return output;
    },
  };
}

test("approvePrWhenClean posts approval when head SHA matches", async () => {
  const calls = [];
  const request = async ({ method, url, body }) => {
    calls.push({ method, url, body });
    if (method === "GET") {
      return { head: { sha: "abc123" } };
    }
    return { id: 1 };
  };

  await approvePrWhenClean({
    token: "token",
    repo: "owner/repo",
    prNumber: "9",
    expectedHeadSha: "abc123",
    request,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].body.event, "APPROVE");
});

test("approvePrWhenClean skips approval when head SHA moved", async () => {
  const calls = [];
  const stderr = makeStderrCapture();
  const request = async ({ method }) => {
    calls.push(method);
    return { head: { sha: "def999" } };
  };

  await approvePrWhenClean({
    token: "token",
    repo: "owner/repo",
    prNumber: "9",
    expectedHeadSha: "abc123",
    request,
    stderr,
  });

  assert.deepEqual(calls, ["GET"]);
  assert.match(stderr.read(), /skipped: PR head moved/);
});

test("approvePrWhenClean treats permission-denied approval as non-fatal", async () => {
  const stderr = makeStderrCapture();
  const request = async ({ method }) => {
    if (method === "GET") {
      return { head: { sha: "abc123" } };
    }
    throw new Error("Resource not accessible by integration");
  };

  await approvePrWhenClean({
    token: "token",
    repo: "owner/repo",
    prNumber: "9",
    expectedHeadSha: "abc123",
    request,
    stderr,
  });

  assert.match(stderr.read(), /non-fatal: unable to auto-approve/);
});

test("approvePrWhenClean throws unexpected request errors", async () => {
  const request = async ({ method }) => {
    if (method === "GET") {
      return { head: { sha: "abc123" } };
    }
    throw new Error("network unavailable");
  };

  await assert.rejects(
    approvePrWhenClean({
      token: "token",
      repo: "owner/repo",
      prNumber: "9",
      expectedHeadSha: "abc123",
      request,
    }),
    /network unavailable/,
  );
});
