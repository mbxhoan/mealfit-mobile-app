import test from "node:test";
import assert from "node:assert/strict";
import { queueUpstream } from "./upstream.mjs";

test("queueUpstream replaces only unattempted changes and keeps the next sheet revision", async t => {
  const previousSheetId = process.env.N8N_SHEET_ID;
  process.env.N8N_SHEET_ID = "sheet-test";
  t.after(() => {
    if (previousSheetId === undefined) delete process.env.N8N_SHEET_ID;
    else process.env.N8N_SHEET_ID = previousSheetId;
  });

  const calls = [];
  const client = {
    async query(query, parameters) {
      calls.push({ query, parameters });
      if (query.includes("SELECT o.source_revision")) return { rows: [{ source_revision: 4, pending: 2 }] };
      return { rows: [] };
    }
  };
  await queueUpstream(client, "operation-id", {
    id: "DH0001", shipperName: "Hiếu", paidAmount: 100_000,
    paymentStatus: "Đã thanh toán", deliveryStatus: "Đã giao hàng", note: ""
  }, 9);

  assert.match(calls[0].query, /status = 'queued' AND attempts = 0/);
  assert.deepEqual(calls[0].parameters, ["DH0001"]);
  assert.match(calls[1].query, /status IN \('queued', 'sending', 'failed'\)/);
  const inserted = JSON.parse(calls[2].parameters[3]);
  assert.equal(inserted.expected_revision, 6);
  assert.equal(inserted.shipping_status, "Đã giao hàng");
  assert.deepEqual(calls[2].parameters.slice(0, 3), ["operation-id", "DH0001", 9]);
});
