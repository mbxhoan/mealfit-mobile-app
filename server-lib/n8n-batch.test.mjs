import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { pushSheetOrders } from "./n8n.mjs";
import { sheetUpdateMatches } from "./sync.mjs";

const workflow = JSON.parse(readFileSync(new URL("../../docs/api/n8n.json", import.meta.url), "utf8"));
const node = name => workflow.nodes.find(item => item.name === name);
const evaluate = (name, input, dependencies = {}) => {
  const outputs = vm.runInNewContext("(function () {\n" + node(name).parameters.jsCode + "\n})()", {
    $input: { first: () => input[0], all: () => input },
    $: previous => ({ first: () => ({ json: dependencies[previous] }) })
  });
  return JSON.parse(JSON.stringify(outputs));
};
const order = (code, operationId) => ({
  sheet_id: "test-sheet",
  code,
  shipper: "Hiếu",
  total: "100",
  remaining_due: "50",
  payment_staus: "Chưa thanh toán",
  shipping_status: "Đang giao hàng",
  note: "Đã gọi",
  expected_revision: 0,
  operation_id: operationId
});

test("batch webhook validates updates and writes only rows matched by order code", () => {
  const webhook = node("update /shipping-orders/batch");
  const validator = node("Validate batch order payload");
  const reader = node("Read batch sheet codes");
  const plan = node("Build batch update plan");
  const writer = node("Write batch to Google Sheet");
  assert.equal(webhook.parameters.path, "shipping-orders/batch");
  assert.equal(webhook.parameters.httpMethod, "POST");
  assert.equal(webhook.parameters.authentication, "headerAuth");
  assert.deepEqual(webhook.credentials, node("upsert /shipping-order").credentials);
  assert.equal(workflow.connections[webhook.name].main[0][0].node, validator.name);
  assert.equal(workflow.connections[validator.name].main[0][0].node, reader.name);
  assert.equal(workflow.connections[reader.name].main[0][0].node, plan.name);
  assert.equal(workflow.connections[plan.name].main[0][0].node, "Has batch updates");
  assert.equal(writer.parameters.operation, "update");
  assert.deepEqual(writer.parameters.columns.matchingColumns, ["Mã đơn"]);
  assert.match(reader.parameters.url, /sheets\.googleapis\.com/);
  assert.equal(JSON.stringify(workflow.nodes).includes("APPS_SCRIPT"), false);

  const valid = order("DH01", "op-1");
  const checked = evaluate(validator.name, [{ json: { body: { orders: [valid] } } }])[0].json;
  assert.deepEqual(checked.orders, [valid]);
  for (const invalid of [
    [{ ...valid, total: "-1" }],
    [{ ...valid, payment_staus: "Đang chờ" }],
    [{ ...valid, shipping_status: "Đang xử lý" }],
    [{ ...valid, unknown: "extra" }],
    [{ ...valid }, { ...valid, code: "DH02", operation_id: "op-1" }]
  ]) {
    assert.throws(() => evaluate(validator.name, [{ json: { body: { orders: invalid } } }]));
  }
  assert.throws(() => evaluate(validator.name, [{ json: { body: { orders: Array(21).fill(valid) } } }]));
});

test("batch update plan preserves field scope and reports missing or duplicate keys", () => {
  const valid = order("DH01", "op-1");
  const missing = order("DH404", "op-2");
  const headers = ["Mã đơn", "Shipper", "Đã thanh toán", "Trạng thái đơn", "Trạng thái giao hàng", "Ghi chú bởi shipper", "Phương thức thanh toán"];
  const response = { valueRanges: [{ values: [headers] }, { values: [["DH01"], ["DH02"]] }] };
  const plan = evaluate("Build batch update plan", [{ json: response }], {
    "Validate batch order payload": { sheet_id: "test-sheet", orders: [valid, missing] }
  })[0].json;
  assert.equal(plan.updates.length, 1);
  assert.deepEqual(Object.keys(plan.updates[0].row).sort(), ["Mã đơn", "Shipper", "Đã thanh toán", "Trạng thái đơn", "Trạng thái giao hàng", "Ghi chú bởi shipper"].sort());
  assert.deepEqual(plan.results, [{ code: "DH404", status: "not-found" }]);

  const duplicate = evaluate("Build batch update plan", [{ json: { valueRanges: [{ values: [headers] }, { values: [["DH01"], ["DH01"]] }] } }], {
    "Validate batch order payload": { sheet_id: "test-sheet", orders: [valid] }
  })[0].json;
  assert.equal(duplicate.updates.length, 0);
  assert.deepEqual(duplicate.results, [{ code: "DH01", status: "conflict" }]);
});

test("batch response confirms writes with app-side revision and Sheet fields", () => {
  const valid = order("DH01", "op-1");
  const missing = order("DH404", "op-2");
  const plan = {
    sheet_id: "test-sheet",
    orders: [valid, missing],
    updates: [{
      code: "DH01",
      expected_revision: 4,
      remaining_due: "50",
      row: { "Mã đơn": "DH01", Shipper: "Hiếu", "Đã thanh toán": "100", "Trạng thái đơn": "Chưa thanh toán", "Trạng thái giao hàng": "Đang giao hàng", "Ghi chú bởi shipper": "Đã gọi" }
    }],
    results: [{ code: "DH404", status: "not-found" }]
  };
  const response = evaluate("Build batch response", [{ json: { "Mã đơn": "DH01" } }], { "Build batch update plan": plan })[0].json;
  assert.deepEqual(response.results.map(item => item.status), ["ok", "not-found"]);
  assert.equal(response.results[0].revision, 5);
  assert.equal(response.results[0].row["TỔNG THANH TOÁN"], "50");
  assert.equal(response.results[0].row.revision, 5);
  assert.equal(response.results[1].row, undefined);
  assert.throws(() => evaluate("Build batch response", [], { "Build batch update plan": plan }));
});

test("single update maps only allowed columns and preserves the payment-status spelling", () => {
  const input = order("DH01", "op-1");
  const mapped = evaluate("Code in JavaScript1", [{ json: { body: input } }], { "upsert /shipping-order": { body: input } })[0].json;
  assert.equal(mapped["Trạng thái đơn"], "Chưa thanh toán");
  assert.deepEqual(Object.keys(mapped).sort(), ["Mã đơn", "Shipper", "Đã thanh toán", "Trạng thái đơn", "Trạng thái giao hàng", "Ghi chú bởi shipper"].sort());
  const response = evaluate("Build single order response", [{ json: {} }], { "upsert /shipping-order": { body: input } })[0].json;
  assert.equal(response.status, "ok");
  assert.equal(response.revision, 1);
  assert.equal(response.row["TỔNG THANH TOÁN"], "50");
});

test("Sheet confirmation accepts matching legacy rows without extra metadata columns", () => {
  const body = order("DH01", "op-1");
  const row = { "Mã đơn": "DH01", Shipper: "Hiếu", "Đã thanh toán": "100", "TỔNG THANH TOÁN": "50", "Trạng thái đơn": "Chưa thanh toán", "Trạng thái giao hàng": "Đang giao hàng", "Ghi chú bởi shipper": "Đã gọi" };
  assert.equal(sheetUpdateMatches(row, body), true);
  assert.equal(sheetUpdateMatches({ ...row, Shipper: "Khác" }, body), false);
});

test("batch API checks exact confirmations and returns per-code statuses", async t => {
  const original = { fetch: globalThis.fetch, base: process.env.N8N_BASE_URL, key: process.env.N8N_API_KEY, vercel: process.env.VERCEL, vercelEnv: process.env.VERCEL_ENV };
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
  const body = order("DH01", "op-1");
  const batch = [{ operation_id: "op-1", request_body: body }, { operation_id: "op-2", request_body: { ...body, code: "DH02" } }];
  const row = { "Mã đơn": "DH01", Shipper: "Hiếu", "Đã thanh toán": "100", "TỔNG THANH TOÁN": "50", "Trạng thái đơn": "Chưa thanh toán", "Trạng thái giao hàng": "Đang giao hàng", "Ghi chú bởi shipper": "Đã gọi", revision: 1 };
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, "/webhook/shipping-orders/batch");
    assert.equal(JSON.parse(options.body).orders.length, 2);
    return Response.json({ status: "ok", results: [{ code: "DH01", status: "ok", revision: 1, row }, { code: "DH02", status: "not-found" }] });
  };
  assert.deepEqual(await pushSheetOrders(batch), [{ status: "ok", code: "DH01", revision: 1 }, { code: "DH02", status: "not-found" }]);
  row["Đã thanh toán"] = "90";
  await assert.rejects(pushSheetOrders(batch), error => error.code === "UPSTREAM_INVALID_RESPONSE");
});
