import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "@neondatabase/serverless";
import { getSql, withAdvisoryLock } from "./db.mjs";

test("Preview requires a dedicated database and never falls back to the shared Neon URL", () => {
  const keys = ["DATABASE_URL", "POSTGRES_URL", "MEALFIT_PREVIEW_DATABASE_URL", "VERCEL_ENV"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.DATABASE_URL = "postgres://mealfit:example@localhost/mealfit";
    process.env.POSTGRES_URL = "postgres://mealfit:example@localhost/mealfit";
    process.env.VERCEL_ENV = "production";
    assert.equal(typeof getSql(), "function");
    process.env.VERCEL_ENV = "preview";
    assert.throws(getSql, /database riêng cho Preview/);
    process.env.MEALFIT_PREVIEW_DATABASE_URL = "postgres://mealfit:example@localhost/mealfit-preview";
    assert.equal(typeof getSql(), "function");
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("withAdvisoryLock rolls back and releases the database connection when work fails", async t => {
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://mealfit:example@localhost/mealfit";
  const calls = [];
  const client = {
    async query(sql, params) { calls.push([sql, params]); return { rows: [] }; },
    release() { calls.push("release"); }
  };
  t.mock.method(Pool.prototype, "connect", async () => client);
  t.mock.method(Pool.prototype, "end", async () => calls.push("end"));

  try {
    await assert.rejects(withAdvisoryLock(772_024_101, async () => { calls.push("work"); throw Error("failed"); }), /failed/);
    assert.deepEqual(calls, [
      ["BEGIN", undefined],
      ["SELECT pg_advisory_xact_lock($1)", [772_024_101]],
      "work",
      ["ROLLBACK", undefined],
      "release",
      "end"
    ]);
  } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
});
