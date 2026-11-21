import test from "node:test";
import assert from "node:assert/strict";
import { dbClock, importSheetOrders, sheetOrderMatchesPayload } from "./sync.mjs";

const recordingSql = (log, rows = []) => (strings, ...values) => {
  log.push({ text: strings.join("$"), values });
  return Promise.resolve(rows);
};

const upsertOf = log => log.find(entry => entry.text.includes("ON CONFLICT (code) DO UPDATE"));

test("a Sheet-authoritative import never overwrites an order whose app change has not reached the Sheet", async () => {
  const log = [];
  const cutoff = "2026-11-21T10:00:00.123456Z";
  await importSheetOrders([{ "Mã đơn": "DH0001", "Tên KH": "An" }], { sheetAuthoritative: true, fetchStartedAt: cutoff, sql: recordingSql(log) });
  const upsert = upsertOf(log);
  // The unsent-outbox guard is the first, unconditional alternative: it must not be switched off by sheetAuthoritative.
  assert.match(upsert.text, /queued\.order_code = mealfit_orders\.code\s+AND \(queued\.status IN \('queued', 'sending', 'failed'\)/);
  // A change confirmed after the Sheet read began is newer than the snapshot as well.
  assert.match(upsert.text, /queued\.status = 'sent' AND queued\.updated_at >=/);
  assert.ok(upsert.values.includes(cutoff));
  assert.match(upsert.text, /ORDER BY code\s+ON CONFLICT \(code\)/);
});

test("an import without a fetch cut-off skips the recently-sent check", async () => {
  const log = [];
  await importSheetOrders([{ "Mã đơn": "DH0001" }], { sql: recordingSql(log) });
  const upsert = upsertOf(log);
  assert.ok(!upsert.values.some(value => typeof value === "string" && value.endsWith("Z")));
  assert.ok(upsert.values.includes(false));
});

test("dbClock returns the database clock reading", async () => {
  assert.equal(await dbClock(recordingSql([], [{ now: "2026-11-21T10:00:00.000001Z" }])), "2026-11-21T10:00:00.000001Z");
});

test("Sheet confirmation requires the exact remaining due amount when supplied", () => {
  const body = { expected_revision: 3, shipping_status: "Đã giao hàng", payment_staus: "Đã thanh toán", code: "DH0001", shipper: "Hiếu", total: "70000", remaining_due: "180000", note: "" };
  assert.equal(sheetOrderMatchesPayload({
    "Mã đơn": "DH0001", Shipper: "Hiếu", "Đã thanh toán": "70,000", "TỔNG THANH TOÁN": "180,000",
    "Trạng thái đơn": "Đã thanh toán", "Trạng thái giao hàng": "Đã giao hàng", "Ghi chú bởi shipper": ""
  }, body), true);
  assert.equal(sheetOrderMatchesPayload({
    "Mã đơn": "DH0001", Shipper: "Hiếu", "Đã thanh toán": "70,000", "TỔNG THANH TOÁN": "179,000",
    "Trạng thái đơn": "Đã thanh toán", "Trạng thái giao hàng": "Đã giao hàng", "Ghi chú bởi shipper": ""
  }, body), false);
  assert.equal(sheetOrderMatchesPayload({
    "Mã đơn": "DH0001", Shipper: "Hiếu", "Đã thanh toán": "70,000",
    "Trạng thái đơn": "Đã thanh toán", "Trạng thái giao hàng": "Đã giao hàng", "Ghi chú bởi shipper": ""
  }, body), false);
});
