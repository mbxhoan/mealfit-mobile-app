import test from "node:test";
import assert from "node:assert/strict";
import { shouldRetryInflight } from "./local-store.mjs";

test("an interrupted outbox request becomes retryable after its lease expires", () => {
  const now = 100_000;
  assert.equal(shouldRetryInflight({ status: "inflight", updatedAt: now - 60_000 }, now), true);
  assert.equal(shouldRetryInflight({ status: "inflight", updatedAt: now - 59_999 }, now), false);
  assert.equal(shouldRetryInflight({ status: "queued", updatedAt: now - 120_000 }, now), false);
});
