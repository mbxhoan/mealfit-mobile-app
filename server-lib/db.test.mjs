import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "./db.mjs";

test("Neon integration URL is used only in Production, not shared with Preview", () => {
  const original = Object.fromEntries(["DATABASE_URL", "POSTGRES_URL", "VERCEL_ENV"].map(key => [key, process.env[key]]));
  try {
    delete process.env.DATABASE_URL;
    process.env.POSTGRES_URL = "postgres://mealfit:example@localhost/mealfit";
    process.env.VERCEL_ENV = "production";
    assert.equal(typeof getSql(), "function");
    process.env.VERCEL_ENV = "preview";
    assert.throws(getSql, /Cơ sở dữ liệu chưa được cấu hình/);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
