import test from "node:test";
import assert from "node:assert/strict";
import { sheetOrderMatchesPayload, sheetUpdateMismatches } from "./sync.mjs";

const update = (targetRevision, shippingStatus) => ({
  order_code: "DH0001",
  target_revision: targetRevision,
  request_body: { expected_revision: targetRevision - 5, shipping_status: shippingStatus, payment_staus: "Đã thanh toán" }
});

test("Sheet confirmation requires the expected revision and both order statuses", () => {
  const sent = [update(8, "Đã giao hàng")];
  assert.deepEqual(sheetUpdateMismatches(sent, [{
    "Mã đơn": "DH0001", revision: 4, "Trạng thái giao hàng": "Đã giao hàng", "Trạng thái đơn": "Đã thanh toán"
  }]), []);
  assert.deepEqual(sheetUpdateMismatches(sent, [{
    "Mã đơn": "DH0001", revision: 4, "Trạng thái giao hàng": "Đang giao hàng", "Trạng thái đơn": "Đã thanh toán"
  }]), ["DH0001"]);
  assert.deepEqual(sheetUpdateMismatches(sent, [{
    "Mã đơn": "DH0001", revision: 3, "Trạng thái giao hàng": "Đã giao hàng", "Trạng thái đơn": "Đã thanh toán"
  }]), ["DH0001"]);
  assert.deepEqual(sheetUpdateMismatches(sent, [{
    "Mã đơn": "DH0001", revision: 5, "Trạng thái giao hàng": "Đã giao hàng", "Trạng thái đơn": "Đã thanh toán"
  }]), []);
});

test("Sheet confirmation checks only the latest queued revision for each order", () => {
  const sent = [update(7, "Đang giao hàng"), update(8, "Đã giao hàng")];
  assert.deepEqual(sheetUpdateMismatches(sent, [{
    "Mã đơn": "DH0001", revision: 4, "Trạng thái giao hàng": "Đã giao hàng", "Trạng thái đơn": "Đã thanh toán"
  }]), []);
});

test("Sheet confirmation requires the exact remaining due amount when supplied", () => {
  const body = { ...update(8, "Đã giao hàng").request_body, code: "DH0001", shipper: "Hiếu", total: "70000", remaining_due: "180000", note: "" };
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
