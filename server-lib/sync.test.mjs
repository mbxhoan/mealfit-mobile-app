import test from "node:test";
import assert from "node:assert/strict";
import { sheetUpdateMismatches } from "./sync.mjs";

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
});

test("Sheet confirmation checks only the latest queued revision for each order", () => {
  const sent = [update(7, "Đang giao hàng"), update(8, "Đã giao hàng")];
  assert.deepEqual(sheetUpdateMismatches(sent, [{
    "Mã đơn": "DH0001", revision: 4, "Trạng thái giao hàng": "Đã giao hàng", "Trạng thái đơn": "Đã thanh toán"
  }]), []);
});
