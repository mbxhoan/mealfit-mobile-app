import test from "node:test";
import assert from "node:assert/strict";
import { canReuseClaim, normalizeSheetOrder, toN8nBody, validateOrderMutation } from "./orders.mjs";

test("Sheet row normalization preserves payment and delivery status for operations", () => {
  const order = normalizeSheetOrder({
    "Mã đơn": "DH0899", "Tên KH": "Khách A", "SĐT": "0900000000", "Địa chỉ": "Quận 1",
    "Phí ship": "15,000", "Sau giảm (đ)": "100,000", "Đã thanh toán": "40,000",
    "TỔNG THANH TOÁN": "75,000", "Trạng thái đơn": "Chưa thanh toán", "Trạng thái giao hàng": "Đang giao hàng", Shipper: "Hiếu"
  });
  assert.equal(order.id, "DH0899");
  assert.equal(order.total, 115_000);
  assert.equal(order.paidAmount, 40_000);
  assert.equal(order.remainingDue, 75_000);
  assert.equal(order.assignedUserId, "hieu");
  assert.equal(order.deliveryStatus, "Đang giao hàng");
});

test("normalized order details keep item rows supplied by the Sheet workflow", () => {
  const order = normalizeSheetOrder({
    "Mã đơn": "DH0899", "Tên KH": "Khách A", items: [{ name: "Ức gà", quantity: 2, unitPrice: 48_000, total: 96_000 }]
  });
  assert.deepEqual(order.items, [{ name: "Ức gà", quantity: 2, unitPrice: 48_000, total: 96_000 }]);
});

test("keeps the default order note separate from the shipper note", () => {
  const order = normalizeSheetOrder({
    "Mã đơn": "DH0899", "Ghi chú": "Đơn này là đơn test", "Ghi chú bởi shipper": "Gọi trước khi đến"
  });
  assert.equal(order.customerNote, "Đơn này là đơn test");
  assert.equal(order.note, "Gọi trước khi đến");
});

test("n8n updates send the full validated body and cumulative paid amount", () => {
  const body = toN8nBody({
    id: "DH0899", customer: "Khách A", phone: "0900000000", address: "Quận 1", shipperName: "Hiếu",
    total: 250_000, paidAmount: 70_000, remainingDue: 180_000, paymentStatus: "Chưa thanh toán",
    deliveryStatus: "Đã giao hàng", note: "", sourceRevision: 4
  }, "sheet-test");
  assert.deepEqual(body, {
    sheet_id: "sheet-test", code: "DH0899", shipper: "Hiếu", total: "70000",
    remaining_due: "180000",
    payment_staus: "Chưa thanh toán", shipping_status: "Đã giao hàng", note: "", expected_revision: 4
  });
  assert.throws(() => toN8nBody({
    id: "DH0899", customer: "Khách A", phone: "0900000000", address: "Quận 1", shipperName: "Hiếu",
    total: 250_000, paidAmount: -1, paymentStatus: "Chưa thanh toán", deliveryStatus: "Đã giao hàng", note: ""
  }, "sheet-test"), /đã thanh toán/);
});

test("n8n paid updates send only one of the supported payment methods", () => {
  for (const method of ["Chuyển khoản", "Tiền mặt", "Khác"]) {
    const body = toN8nBody({
      id: "DH0899", paidAmount: 250_000, paymentStatus: "Đã thanh toán", paymentMethod: method,
      deliveryStatus: "Đang giao hàng", note: ""
    }, "sheet-test");
    assert.equal(body.method, method);
  }
  const paidOrder = { id: "DH0899", paidAmount: 250_000, paymentStatus: "Đã thanh toán", deliveryStatus: "Đang giao hàng", note: "" };
  assert.throws(() => validateOrderMutation(paidOrder, "Chưa thanh toán"), /Phương thức thanh toán/);
  assert.throws(() => validateOrderMutation({ ...paidOrder, paymentMethod: "Ví điện tử" }, "Chưa thanh toán"), /Phương thức thanh toán/);
  assert.doesNotThrow(() => validateOrderMutation({ ...paidOrder, paymentMethod: "Tiền mặt" }, "Chưa thanh toán"));
});

test("n8n updates allow missing customer contact details while preserving required API fields", () => {
  const body = toN8nBody({
    id: "DH0899", customer: "", phone: "", address: "", shipperName: "",
    paidAmount: 0, paymentStatus: "Chưa thanh toán", deliveryStatus: "Đang giao hàng", note: ""
  }, "sheet-test");
  assert.equal(body.shipper, "Chưa phân công");
  assert.equal(body.total, "0");
  assert.equal(body.remaining_due, "0");
  assert.throws(() => toN8nBody({
    id: "DH0899", phone: 123, paidAmount: 0, paymentStatus: "Chưa thanh toán", deliveryStatus: "Đang giao hàng", note: ""
  }, "sheet-test"), /phone không hợp lệ/);
  assert.throws(() => toN8nBody({
    id: "DH0899", paidAmount: 0, remainingDue: -1, paymentStatus: "Chưa thanh toán", deliveryStatus: "Đang giao hàng", note: ""
  }, "sheet-test"), /số tiền cần thu/);
});

test("claim retry succeeds only for the same shipper while the order is still pending", () => {
  assert.equal(canReuseClaim({ assigned_user_id: "hieu", shipping_status: "Chưa giao hàng" }, "hieu"), true);
  assert.equal(canReuseClaim({ assigned_user_id: "hoan", shipping_status: "Chưa giao hàng" }, "hieu"), false);
  assert.equal(canReuseClaim({ assigned_user_id: "hieu", shipping_status: "Đang giao hàng" }, "hieu"), false);
});
