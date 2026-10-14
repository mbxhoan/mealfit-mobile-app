import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "./db.mjs";

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
