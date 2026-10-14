import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { verifyPin } from "./auth.mjs";

test("production PIN uses only a scrypt hash and enforces six digits", () => {
  const before = { env: process.env.VERCEL_ENV, pin: process.env.MEALFIT_PIN, hash: process.env.MEALFIT_PIN_HASH };
  const salt = randomBytes(16);
  process.env.VERCEL_ENV = "production";
  delete process.env.MEALFIT_PIN;
  process.env.MEALFIT_PIN_HASH = `scrypt$${salt.toString("base64url")}$${scryptSync("654321", salt, 32).toString("base64url")}`;
  try {
    assert.equal(verifyPin("654321"), true);
    assert.equal(verifyPin("1234"), false);
    process.env.MEALFIT_PIN_HASH = "";
    assert.throws(() => verifyPin("654321"), /mã băm/);
  } finally {
    if (before.env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = before.env;
    if (before.pin === undefined) delete process.env.MEALFIT_PIN; else process.env.MEALFIT_PIN = before.pin;
    if (before.hash === undefined) delete process.env.MEALFIT_PIN_HASH; else process.env.MEALFIT_PIN_HASH = before.hash;
  }
});
