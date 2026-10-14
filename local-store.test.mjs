import test from "node:test";
import assert from "node:assert/strict";
import { appLogRetryDelay, isFirstInstallSync, shouldRetryInflight } from "./local-store.mjs";

test("an interrupted outbox request becomes retryable after its lease expires", () => {
  const now = 100_000;
  assert.equal(shouldRetryInflight({ status: "inflight", updatedAt: now - 60_000 }, now), true);
  assert.equal(shouldRetryInflight({ status: "inflight", updatedAt: now - 59_999 }, now), false);
  assert.equal(shouldRetryInflight({ status: "queued", updatedAt: now - 120_000 }, now), false);
});

test("app log retries back off and cap their delay", () => {
  assert.equal(appLogRetryDelay(0), 1_000);
  assert.equal(appLogRetryDelay(1), 2_000);
  assert.equal(appLogRetryDelay(20), 256_000);
});

test("the initial order sync is limited to a fresh install", () => {
  assert.equal(isFirstInstallSync({}), true);
  assert.equal(isFirstInstallSync({ attempted: true }), false);
  assert.equal(isFirstInstallSync({ lastUser: "hoan" }), false);
  assert.equal(isFirstInstallSync({ hasStoredState: true }), false);
});
