import test from "node:test";
import assert from "node:assert/strict";
import { appLogPayload, fetchSheetOrders, fetchSheetOrdersForShippers, n8nRequest } from "./n8n.mjs";
import { recordBatches } from "./sync.mjs";

test("app logs only accept supported types and always target the fixed sheet", () => {
  const payload = appLogPayload({ type: "error", api: "=POST /api/operations", description: "Failed", details: { status: 502, durationMs: 1200, errorCode: "UPSTREAM_ERROR", secret: "discard" } }, { id: "hoan", name: "Hoàn" }, "test-sheet");
  assert.equal(payload.sheet_id, "test-sheet");
  assert.equal(payload.sheet_name, "app_logs");
  assert.equal(payload.type, "error");
  assert.equal(payload.api, "'=POST /api/operations");
  assert.deepEqual(JSON.parse(payload.other), { status: 502, durationMs: 1200, errorCode: "UPSTREAM_ERROR" });
  assert.throws(() => appLogPayload({ type: "debug" }, { name: "Hoàn" }, "test-sheet"), error => error.code === "INVALID_LOG_TYPE");
});

test("n8n authorization failures identify the webhook HTTP status", async t => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.N8N_BASE_URL;
  const originalKey = process.env.N8N_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.N8N_BASE_URL;
    else process.env.N8N_BASE_URL = originalBase;
    if (originalKey === undefined) delete process.env.N8N_API_KEY;
    else process.env.N8N_API_KEY = originalKey;
  });
  process.env.N8N_BASE_URL = "https://example.test/webhook";
  process.env.N8N_API_KEY = "test-only-secret";
  globalThis.fetch = async (_url, { headers }) => {
    assert.equal(headers.get("authorization"), "test-only-secret");
    return new Response("forbidden", { status: 403 });
  };

  await assert.rejects(n8nRequest("shipping-orders"), error => {
    assert.equal(error.upstreamStatus, 403);
    assert.match(error.message, /header xác thực/);
    return true;
  });
});

test("all webhook calls share a serialized queue with a minimum start interval", async t => {
  const original = {
    fetch: globalThis.fetch,
    base: process.env.N8N_BASE_URL,
    key: process.env.N8N_API_KEY,
    vercel: process.env.VERCEL,
    vercelEnv: process.env.VERCEL_ENV
  };
  t.after(() => {
    globalThis.fetch = original.fetch;
    for (const [key, value] of [["N8N_BASE_URL", original.base], ["N8N_API_KEY", original.key], ["VERCEL", original.vercel], ["VERCEL_ENV", original.vercelEnv]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.N8N_BASE_URL = "https://example.test/webhook";
  process.env.N8N_API_KEY = "test-only-secret";
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  let active = 0;
  let maxActive = 0;
  const started = [];
  globalThis.fetch = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    started.push(Date.now());
    await new Promise(resolve => setTimeout(resolve, 20));
    active--;
    return Response.json({ ok: true });
  };

  await Promise.all([n8nRequest("shipping-orders"), n8nRequest("shipping-order?code=DH1")]);
  assert.equal(maxActive, 1);
  assert.ok(started[1] - started[0] >= 1_000, `requests started only ${started[1] - started[0]}ms apart`);
});

test("webhook automatic retries stop after three attempts", async t => {
  const original = {
    fetch: globalThis.fetch,
    base: process.env.N8N_BASE_URL,
    key: process.env.N8N_API_KEY,
    vercel: process.env.VERCEL,
    vercelEnv: process.env.VERCEL_ENV
  };
  t.after(() => {
    globalThis.fetch = original.fetch;
    for (const [key, value] of [["N8N_BASE_URL", original.base], ["N8N_API_KEY", original.key], ["VERCEL", original.vercel], ["VERCEL_ENV", original.vercelEnv]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.N8N_BASE_URL = "https://example.test/webhook";
  process.env.N8N_API_KEY = "test-only-secret";
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("busy", { status: 503, headers: { "retry-after": "0" } }); };

  await assert.rejects(n8nRequest("shipping-orders"), error => error.upstreamStatus === 503);
  assert.equal(calls, 3);
});

test("long webhook Retry-After reaches the caller without an automatic retry", async t => {
  const original = {
    fetch: globalThis.fetch,
    base: process.env.N8N_BASE_URL,
    key: process.env.N8N_API_KEY,
    vercel: process.env.VERCEL,
    vercelEnv: process.env.VERCEL_ENV
  };
  t.after(() => {
    globalThis.fetch = original.fetch;
    for (const [key, value] of [["N8N_BASE_URL", original.base], ["N8N_API_KEY", original.key], ["VERCEL", original.vercel], ["VERCEL_ENV", original.vercelEnv]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.N8N_BASE_URL = "https://example.test/webhook";
  process.env.N8N_API_KEY = "test-only-secret";
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("busy", { status: 429, headers: { "retry-after": "60" } }); };

  await assert.rejects(n8nRequest("log", { method: "POST" }), error => error.retryAfterSeconds === 60);
  assert.equal(calls, 1);
});

test("shipping-orders accepts n8n's total/data response and preserves all returned rows", async t => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.N8N_BASE_URL;
  const originalKey = process.env.N8N_API_KEY;
  const originalSheet = process.env.N8N_SHEET_ID;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [["N8N_BASE_URL", originalBase], ["N8N_API_KEY", originalKey], ["N8N_SHEET_ID", originalSheet]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.N8N_BASE_URL = "https://example.test/webhook";
  process.env.N8N_API_KEY = "test-only-secret";
  process.env.N8N_SHEET_ID = "test-sheet";
  const rows = Array.from({ length: 898 }, (_, index) => ({ "Mã đơn": `DH${String(index + 1).padStart(4, "0")}` }));
  globalThis.fetch = async url => {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.pathname, "/webhook/shipping-orders");
    assert.equal(requestUrl.searchParams.get("shipper"), "Hoàn");
    return Response.json({ total: rows.length, data: rows });
  };

  const result = await fetchSheetOrders({ limit: 500, shipper: "Hoàn" });
  assert.equal(result.rows.length, 898);
  assert.equal(result.rows[0]["Mã đơn"], "DH0001");
  assert.equal(result.nextCursor, null);
});

test("shipping-orders rejects a successful response without an order list", async t => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.N8N_BASE_URL;
  const originalKey = process.env.N8N_API_KEY;
  const originalSheet = process.env.N8N_SHEET_ID;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [["N8N_BASE_URL", originalBase], ["N8N_API_KEY", originalKey], ["N8N_SHEET_ID", originalSheet]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.N8N_BASE_URL = "https://example.test/webhook";
  process.env.N8N_API_KEY = "test-only-secret";
  process.env.N8N_SHEET_ID = "test-sheet";
  globalThis.fetch = async () => Response.json({ total: 898, orders: [] });
  await assert.rejects(fetchSheetOrders(), error => error.code === "UPSTREAM_INVALID_RESPONSE");
});

test("shipper list sync fetches each current or previous name and deduplicates orders", async t => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.N8N_BASE_URL;
  const originalKey = process.env.N8N_API_KEY;
  const originalSheet = process.env.N8N_SHEET_ID;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [["N8N_BASE_URL", originalBase], ["N8N_API_KEY", originalKey], ["N8N_SHEET_ID", originalSheet]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.N8N_BASE_URL = "https://example.test/webhook";
  process.env.N8N_API_KEY = "test-only-secret";
  process.env.N8N_SHEET_ID = "test-sheet";
  const names = [];
  globalThis.fetch = async url => {
    const shipper = new URL(String(url)).searchParams.get("shipper");
    names.push(shipper);
    return Response.json({ data: shipper === "Hiếu"
      ? [{ "Mã đơn": "DH1", source: "current" }, { "Mã đơn": "DH2" }]
      : [{ "Mã đơn": "DH1", source: "alias" }, { "Mã đơn": "DH3" }] });
  };

  const result = await fetchSheetOrdersForShippers({ shippers: ["Hiếu", "Hieu"] });
  assert.deepEqual(names, ["Hiếu", "Hieu"]);
  assert.equal(result.received, 4);
  assert.equal(result.pages, 2);
  assert.deepEqual(result.rows.map(row => row["Mã đơn"]), ["DH1", "DH2", "DH3"]);
  assert.equal(result.rows[0].source, "current");
});

test("database import batches keep every order and cap each JSON payload", () => {
  const rows = Array.from({ length: 898 }, (_, index) => ({ code: `DH${index}` }));
  const batches = recordBatches(rows);
  assert.deepEqual(batches.map(batch => batch.length), [100, 100, 100, 100, 100, 100, 100, 100, 98]);
  assert.deepEqual(batches.flat(), rows);
});
