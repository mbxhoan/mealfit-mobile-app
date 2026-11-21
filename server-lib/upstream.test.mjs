import test from "node:test";
import assert from "node:assert/strict";
import { queueUpstream } from "./upstream.mjs";

test("queueUpstream supersedes older unsent rows and queues the newest absolute state", async t => {
  const previousSheetId = process.env.N8N_SHEET_ID;
  process.env.N8N_SHEET_ID = "sheet-test";
  t.after(() => {
    if (previousSheetId === undefined) delete process.env.N8N_SHEET_ID;
    else process.env.N8N_SHEET_ID = previousSheetId;
  });

  const calls = [];
  const client = { async query(query, parameters) { calls.push({ query, parameters }); return { rows: [] }; } };
  await queueUpstream(client, "operation-id", {
    id: "DH0001", shipperName: "Hiếu", total: 250_000, paidAmount: 100_000, remainingDue: 0,
    paymentStatus: "Đã thanh toán", deliveryStatus: "Đã giao hàng", note: "", payments: [{ method: "Chuyển khoản", amount: 100_000 }]
  }, 9);

  assert.match(calls[0].query, /SET status = 'sent', last_error = 'SUPERSEDED'/);
  assert.match(calls[0].query, /status IN \('queued', 'failed', 'conflict'\)/);
  assert.deepEqual(calls[0].parameters, ["DH0001"]);
  const body = JSON.parse(calls[1].parameters[3]);
  assert.deepEqual(calls[1].parameters.slice(0, 3), ["operation-id", "DH0001", 9]);
  assert.equal(body.sheet_id, "sheet-test");
  assert.equal(body.code, "DH0001");
  assert.equal(body.total, "100000");
  assert.equal(body.payment_staus, "Đã thanh toán");
  assert.equal(body.shipping_status, "Đã giao hàng");
  assert.equal(body.method, "Chuyển khoản");
  assert.equal("expected_sheet_state" in body, false);
});
