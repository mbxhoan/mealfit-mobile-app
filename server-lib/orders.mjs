import { AppError } from "./core.mjs";

export const DELIVERY_STATUSES = ["Chưa giao hàng", "Đang giao hàng", "Đã giao hàng", "Đã huỷ đơn"];
export const PAYMENT_STATUSES = ["Chưa thanh toán", "Đã thanh toán"];
export const PAYMENT_METHODS = ["Tiền mặt", "Chuyển khoản", "Khác"];

const number = value => {
  const parsed = Number(String(value ?? "0").replace(/,/g, ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
};
export const sheetText = value => String(value ?? "").normalize("NFC").trim();

function dateValue(value) {
  if (!value) return null;
  if (typeof value === "number") return new Date(value).toISOString();
  const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), 12).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

export function assignedUserId(value) {
  const name = sheetText(value).toLocaleLowerCase("vi-VN");
  if (!name || name === "chưa phân công" || name === "unassigned") return null;
  if (name.includes("hiếu") || name.includes("hieu")) return "hieu";
  if (name.includes("hoàn") || name.includes("hoan")) return "hoan";
  if (name === "shipper" || name.includes(" shipper")) return "shipper";
  return "external";
}

export function canReuseClaim(order, userId) {
  return order?.assigned_user_id === userId && order?.shipping_status === "Chưa giao hàng";
}

export function normalizeSheetOrder(row, extra = {}) {
  const id = String(row?.["Mã đơn"] || row?.code || "").trim();
  if (!id) return null;
  const shippingFee = number(row["Phí ship"]);
  const subtotal = number(row["Sau giảm (đ)"] ?? row["Tổng CHƯA SHIP"]);
  const total = number(row["Tổng CÓ SHIP"] ?? subtotal + shippingFee);
  const paidAmount = number(row["Đã thanh toán"]);
  const paymentValue = sheetText(row["Trạng thái đơn"] ?? row.payment_status);
  const deliveryValue = sheetText(row["Trạng thái giao hàng"] ?? row.shipping_status);
  const paymentStatus = PAYMENT_STATUSES.includes(paymentValue) ? paymentValue : "Chưa thanh toán";
  const deliveryStatus = DELIVERY_STATUSES.includes(deliveryValue) ? deliveryValue : "Chưa giao hàng";
  const shipperName = sheetText(row.Shipper ?? row.shipper);
  const dueFromSheet = row["TỔNG THANH TOÁN"] == null || row["TỔNG THANH TOÁN"] === "" ? Math.max(0, total - paidAmount) : number(row["TỔNG THANH TOÁN"]);
  return {
    id,
    customer: String(row["Tên KH"] ?? ""),
    phone: String(row["SĐT"] ?? ""),
    address: String(row["Địa chỉ"] ?? ""),
    date: dateValue(row.Ngày) || new Date().toISOString(),
    subtotal,
    shippingFee,
    total,
    paidAmount,
    remainingDue: dueFromSheet,
    paymentStatus,
    deliveryStatus,
    deliveryMethod: null,
    shipperName,
    assignedUserId: assignedUserId(shipperName),
    note: String(row["Ghi chú bởi shipper"] ?? ""),
    customerNote: String(row["Ghi chú"] ?? ""),
    mapsLink: extra.mapsLink || "",
    sessionId: extra.sessionId || null,
    deliveredAt: extra.deliveredAt || null,
    payments: extra.payments || [],
    items: Array.isArray(row.items) ? row.items : null,
    sourceRevision: Number(row.revision ?? row.Revision ?? 0) || 0,
    serverRevision: Number(extra.serverRevision ?? 0),
    raw: row
  };
}

export function validateOrderMutation(order, previousPaymentStatus) {
  if (!order || typeof order !== "object" || !/^[A-Za-z0-9_-]{2,40}$/.test(String(order.id || ""))) throw new AppError(400, "INVALID_ORDER", "Mã đơn hàng không hợp lệ.");
  if (!DELIVERY_STATUSES.includes(order.deliveryStatus)) throw new AppError(400, "INVALID_SHIPPING_STATUS", "Trạng thái giao hàng không hợp lệ.");
  if (!PAYMENT_STATUSES.includes(order.paymentStatus)) throw new AppError(400, "INVALID_PAYMENT_STATUS", "Trạng thái thanh toán không hợp lệ.");
  const validAmount = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  if (!validAmount(order.paidAmount)) throw new AppError(400, "INVALID_TOTAL", "Tổng tiền đã thanh toán phải là số nguyên không âm.");
  for (const field of ["total", "remainingDue"]) {
    if (order[field] != null && !validAmount(order[field])) throw new AppError(400, "INVALID_TOTAL", "Số tiền đơn hàng và số tiền cần thu phải là số nguyên không âm.");
  }
  for (const field of ["customer", "phone", "address", "shipperName"]) {
    if (order[field] != null && typeof order[field] !== "string") throw new AppError(400, "INVALID_FIELD", `Thông tin ${field} không hợp lệ.`);
  }
  if (typeof order.note !== "string") throw new AppError(400, "INVALID_NOTE", "Ghi chú phải là văn bản.");
  if (order.note.length > 2000) throw new AppError(400, "INVALID_NOTE", "Ghi chú tối đa 2.000 ký tự.");
  if (order.mapsLink && !/^https:\/\/(maps\.app\.goo\.gl|www\.google\.com|google\.com|maps\.google\.com)\//.test(order.mapsLink)) throw new AppError(400, "INVALID_MAPS_LINK", "Link Google Maps không hợp lệ.");
  if (previousPaymentStatus != null && previousPaymentStatus !== "Đã thanh toán" && order.paymentStatus === "Đã thanh toán" && !PAYMENT_METHODS.includes(order.paymentMethod)) throw new AppError(400, "INVALID_PAYMENT_METHOD", "Phương thức thanh toán không hợp lệ.");
  return order;
}

export function toN8nBody(order, sheetId) {
  validateOrderMutation(order);
  const total = Math.round(Number(order.total) || 0);
  const paidAmount = Math.round(Number(order.paidAmount));
  const remainingDue = order.paymentStatus === "Đã thanh toán"
    ? 0
    : Math.round(Number(order.remainingDue ?? Math.max(0, total - paidAmount)));
  const paymentMethod = PAYMENT_METHODS.includes(order.paymentMethod) ? order.paymentMethod : Array.isArray(order.payments) ? order.payments.at(-1)?.method : "";
  return {
    sheet_id: sheetId,
    code: order.id,
    shipper: String(order.shipperName || "Chưa phân công"),
    total: String(paidAmount),
    remaining_due: String(remainingDue),
    payment_staus: order.paymentStatus,
    ...(order.paymentStatus === "Đã thanh toán" && PAYMENT_METHODS.includes(paymentMethod) ? { method: paymentMethod } : {}),
    shipping_status: order.deliveryStatus,
    note: order.note,
    expected_revision: Math.max(0, Math.round(Number(order.sourceRevision) || 0))
  };
}
