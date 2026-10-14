import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { verifyPin } from "./auth.mjs";

test("production accepts a precomputed scrypt hash when configured", () => {
  const before = { env: process.env.VERCEL_ENV, pin: process.env.MEALFIT_PIN, hash: process.env.MEALFIT_PIN_HASH };
  const salt = randomBytes(16);
  process.env.VERCEL_ENV = "production";
  delete process.env.MEALFIT_PIN;
  process.env.MEALFIT_PIN_HASH = `scrypt$${salt.toString("base64url")}$${scryptSync("654321", salt, 32).toString("base64url")}`;
  try {
    assert.equal(verifyPin("654321"), true);
    assert.equal(verifyPin("1234"), false);
    process.env.MEALFIT_PIN_HASH = "";
    assert.throws(() => verifyPin("654321"), /MEALFIT_PIN/);
  } finally {
    if (before.env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = before.env;
    if (before.pin === undefined) delete process.env.MEALFIT_PIN; else process.env.MEALFIT_PIN = before.pin;
    if (before.hash === undefined) delete process.env.MEALFIT_PIN_HASH; else process.env.MEALFIT_PIN_HASH = before.hash;
  }
});

test("production PIN prefers the configured six digit PIN over a stale legacy hash", () => {
  const before = {
    env: process.env.VERCEL_ENV,
    pin: process.env.MEALFIT_PIN,
    hash: process.env.MEALFIT_PIN_HASH,
    secret: process.env.SESSION_SECRET
  };
  process.env.VERCEL_ENV = "production";
  process.env.MEALFIT_PIN = "654321";
  process.env.SESSION_SECRET = "test-session-secret-with-more-than-32-characters";
  process.env.MEALFIT_PIN_HASH = "stale-hash-value";
  try {
    assert.equal(verifyPin("654321"), true);
    assert.equal(verifyPin("123456"), false);
  } finally {
    if (before.env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = before.env;
    if (before.pin === undefined) delete process.env.MEALFIT_PIN; else process.env.MEALFIT_PIN = before.pin;
    if (before.hash === undefined) delete process.env.MEALFIT_PIN_HASH; else process.env.MEALFIT_PIN_HASH = before.hash;
    if (before.secret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = before.secret;
  }
});
