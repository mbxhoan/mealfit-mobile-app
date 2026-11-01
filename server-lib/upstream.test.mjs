import test from "node:test";
import assert from "node:assert/strict";
import { captureSheetState, queueUpstream, sheetMatchesExpectedState } from "./upstream.mjs";

test("outbox preflight matches only the app-managed Sheet fields from its baseline", () => {
  const row = {
    Shipper: "Hoàn", "Đã thanh toán": "1,000", "TỔNG THANH TOÁN": "200,000",
    "Trạng thái đơn": "Chưa thanh toán", "Trạng thái giao hàng": "Đang giao hàng",
    "Ghi chú bởi shipper": "Giao CN", "Phương thức thanh toán": "Tiền mặt"
  };
  const body = { method: "Chuyển khoản" };
  const expected_sheet_state = captureSheetState(row, body);
  assert.equal(expected_sheet_state.complete, true);
  assert.equal(sheetMatchesExpectedState(row, { ...body, expected_sheet_state }), true);
  assert.equal(sheetMatchesExpectedState({ ...row, "Đã thanh toán": "1,001" }, { ...body, expected_sheet_state }), false);
  assert.equal(sheetMatchesExpectedState({ ...row, "Phương thức thanh toán": "Khác" }, { ...body, expected_sheet_state }), false);
  assert.equal(sheetMatchesExpectedState({ ...row, "Tên KH": "Khách đã đổi" }, { ...body, expected_sheet_state }), true);
  assert.equal(sheetMatchesExpectedState({ Shipper: "Hoàn" }, { ...body, expected_sheet_state }), false);
});

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
  const sourceRow = {
    Shipper: "Hiếu", "Đã thanh toán": "100000", "TỔNG THANH TOÁN": "0",
    "Trạng thái đơn": "Đã thanh toán", "Trạng thái giao hàng": "Đang giao hàng", "Ghi chú bởi shipper": ""
  };
  await queueUpstream(client, "operation-id", {
    id: "DH0001", shipperName: "Hiếu", paidAmount: 100_000,
    paymentStatus: "Đã thanh toán", deliveryStatus: "Đã giao hàng", note: ""
  }, 9, sourceRow);

  assert.match(calls[0].query, /SELECT request_body FROM mealfit_upstream_outbox/);
  assert.match(calls[1].query, /status = 'queued' AND attempts = 0/);
  assert.deepEqual(calls[1].parameters, ["DH0001"]);
  assert.match(calls[2].query, /status IN \('queued', 'sending', 'failed'\)/);
  const inserted = JSON.parse(calls[3].parameters[3]);
  assert.equal(inserted.expected_revision, 6);
  assert.equal(inserted.shipping_status, "Đã giao hàng");
  assert.equal(inserted.expected_sheet_state.complete, true);
  assert.equal(inserted.expected_sheet_state.values.shipping_status, "Đang giao hàng");
  assert.deepEqual(calls[3].parameters.slice(0, 3), ["operation-id", "DH0001", 9]);
});
