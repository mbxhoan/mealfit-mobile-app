import { createHash } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { handler, readJson, requireMethod, send, AppError } from "./lib/core.mjs";
import { assertSameOrigin, requireUser } from "./lib/auth.mjs";
import { withTransaction } from "./lib/db.mjs";
import { DELIVERY_STATUSES, PAYMENT_STATUSES, PAYMENT_METHODS, validateOrderMutation } from "./lib/orders.mjs";
import { queueUpstream, flushUpstream } from "./lib/upstream.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function applyOrder(client, operation, user) {
  const id = String(operation?.operationId || "");
  const code = String(operation?.entityId || operation?.payload?.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(400, "INVALID_OPERATION", "Mã thao tác không hợp lệ.");
  const payload = validateOrderMutation(operation.payload);
  const bodyHash = hash({ type: "order", code, baseRevision: operation.baseRevision, payload });
  const duplicate = await client.query("SELECT actor_id, body_hash, result FROM mealfit_operations WHERE operation_id = $1", [id]);
  if (duplicate.rows[0]) {
    if (duplicate.rows[0].actor_id !== user.id || duplicate.rows[0].body_hash !== bodyHash) throw new AppError(409, "IDEMPOTENCY_MISMATCH", "Mã thao tác đã được dùng cho nội dung khác.");
    return duplicate.rows[0].result;
  }
  const found = await client.query("SELECT * FROM mealfit_orders WHERE code = $1 FOR UPDATE", [code]);
  const current = found.rows[0];
  if (!current) throw new AppError(404, "ORDER_NOT_FOUND", "Không tìm thấy đơn hàng cần cập nhật.");
  if (user.role === "shipper" && current.assigned_user_id !== user.id) throw new AppError(403, "ORDER_FORBIDDEN", "Shipper chỉ được cập nhật đơn đã nhận.");
  if (Number(operation.baseRevision) !== Number(current.revision)) {
    await client.query(`INSERT INTO mealfit_conflicts (conflict_id, order_code, app_revision, sheet_revision, app_payload, sheet_payload)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb) ON CONFLICT (conflict_id) DO NOTHING`,
      [id, code, Number(operation.baseRevision) || 0, Number(current.source_revision) || 0, JSON.stringify(payload), JSON.stringify(current.row_data || {})]);
    return { conflict: true, id, code, revision: Number(current.revision) };
  }
  if (!DELIVERY_STATUSES.includes(payload.deliveryStatus) || !PAYMENT_STATUSES.includes(payload.paymentStatus)) throw new AppError(400, "INVALID_STATUS", "Trạng thái đơn hàng không hợp lệ.");
  const shipperName = user.role === "shipper" ? user.name : String(payload.shipperName || current.shipper_name || "Chưa phân công");
  if (!shipperName.trim()) throw new AppError(400, "MISSING_SHIPPER", "Thiếu thông tin shipper.");
  const assignedUserId = user.role === "shipper" ? user.id : (payload.assignedUserId ?? current.assigned_user_id);
  const remainingDue = payload.paymentStatus === "Đã thanh toán" ? 0 : Math.max(0, Math.round(Number(payload.remainingDue ?? (Number(payload.total) - Number(payload.paidAmount)))));
  const raw = {
    ...(current.row_data || {}),
    "Mã đơn": code,
    "Trạng thái giao hàng": payload.deliveryStatus,
    "Trạng thái đơn": payload.paymentStatus,
    "Đã thanh toán": Math.round(Number(payload.paidAmount)),
    "TỔNG THANH TOÁN": remainingDue,
    "Ghi chú bởi shipper": payload.note,
    Shipper: shipperName,
    revision: Number(current.source_revision) || 0
  };
  const updated = await client.query(`UPDATE mealfit_orders SET
      row_data = $1::jsonb, total = $2, paid_amount = $3, remaining_due = $4,
      payment_status = $5, shipping_status = $6, shipper_name = $7, assigned_user_id = $8,
      note = $9, maps_url = $10, session_id = $11, payments = $12::jsonb,
      revision = revision + 1, updated_at = now()
    WHERE code = $13 AND revision = $14 RETURNING revision`,
    [JSON.stringify(raw), Math.max(0, Math.round(Number(payload.total))), Math.round(Number(payload.paidAmount)), remainingDue,
      payload.paymentStatus, payload.deliveryStatus, shipperName, assignedUserId, payload.note, payload.mapsLink || "",
      payload.sessionId || null, JSON.stringify(payload.payments || []), code, Number(operation.baseRevision)]);
  if (!updated.rows[0]) throw new AppError(409, "REVISION_CONFLICT", "Đơn vừa được cập nhật ở thiết bị khác. Làm mới dữ liệu để xử lý xung đột.");
  const revision = Number(updated.rows[0].revision);
  const previousPayments = Array.isArray(current.payments) ? current.payments : [];
  const newPayments = (payload.payments || []).slice(previousPayments.length);
  for (const [index, payment] of newPayments.entries()) {
    if (!PAYMENT_METHODS.includes(payment.method) || !Number.isFinite(Number(payment.amount)) || Number(payment.amount) < 0) throw new AppError(400, "INVALID_PAYMENT", "Giao dịch thanh toán không hợp lệ.");
    await client.query(`INSERT INTO mealfit_payment_events (payment_id, order_code, session_id, actor_id, method, amount, paid_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (payment_id) DO NOTHING`,
      [`${id}:${index}`, code, payment.sessionId || null, user.id, payment.method, Math.round(Number(payment.amount)), new Date(payment.paidAt || Date.now()).toISOString()]);
  }
  await queueUpstream(client, id, { ...payload, id: code, shipperName, paidAmount: Math.round(Number(payload.paidAmount)), paymentStatus: payload.paymentStatus, deliveryStatus: payload.deliveryStatus, note: payload.note }, revision);
  await client.query("INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, operation_id, detail) VALUES ($1, 'order', $2, 'update', $3, $4::jsonb)", [user.id, code, id, JSON.stringify({ revision })]);
  const result = { id, code, revision };
  await client.query("INSERT INTO mealfit_operations (operation_id, actor_id, entity_type, entity_id, body_hash, result) VALUES ($1, $2, 'order', $3, $4, $5::jsonb)", [id, user.id, code, bodyHash, JSON.stringify(result)]);
  return result;
}

async function applySession(client, operation, user) {
  const id = String(operation?.operationId || "");
  const sessionId = String(operation?.entityId || operation?.payload?.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id) || !sessionId.startsWith("PS-")) throw new AppError(400, "INVALID_OPERATION", "Mã phiên hoặc thao tác không hợp lệ.");
  if (user.role !== "shipper") throw new AppError(403, "SHIPPER_ONLY", "Chỉ shipper có thể cập nhật phiên giao hàng.");
  const payload = operation.payload;
  if (!payload || !["notStarted", "active", "paused", "completed", "cancelled"].includes(payload.status) || !Array.isArray(payload.orderIds) || payload.orderIds.length > 500 || new Set(payload.orderIds).size !== payload.orderIds.length) throw new AppError(400, "INVALID_SESSION", "Thông tin phiên giao hàng không hợp lệ.");
  if (Object.values(payload.shifts || {}).some(shift => !["Sáng", "Chiều", "Tối", ""].includes(shift))) throw new AppError(400, "INVALID_SESSION", "Ca giao hàng không hợp lệ.");
  if (payload.status === "active" && payload.pausedAt) throw new AppError(400, "INVALID_SESSION", "Phiên đang giao không thể còn thời điểm tạm dừng.");
  const bodyHash = hash({ type: "session", sessionId, baseRevision: operation.baseRevision, payload });
  const duplicate = await client.query("SELECT actor_id, body_hash, result FROM mealfit_operations WHERE operation_id = $1", [id]);
  if (duplicate.rows[0]) {
    if (duplicate.rows[0].actor_id !== user.id || duplicate.rows[0].body_hash !== bodyHash) throw new AppError(409, "IDEMPOTENCY_MISMATCH", "Mã thao tác đã được dùng cho nội dung khác.");
    return duplicate.rows[0].result;
  }
  const found = await client.query("SELECT * FROM mealfit_sessions WHERE session_id = $1 FOR UPDATE", [sessionId]);
  const current = found.rows[0];
  if (current && current.owner_id !== user.id) throw new AppError(403, "SESSION_FORBIDDEN", "Phiên này thuộc shipper khác.");
  const currentRevision = Number(current?.revision || 0);
  if (Number(operation.baseRevision || 0) !== currentRevision) return { conflict: true, id, sessionId, revision: currentRevision };
  if (payload.orderIds.length) {
    const assigned = await client.query("SELECT code FROM mealfit_orders WHERE code = ANY($1::text[]) AND assigned_user_id = $2", [payload.orderIds, user.id]);
    if (assigned.rows.length !== payload.orderIds.length) throw new AppError(403, "SESSION_ORDER_FORBIDDEN", "Phiên chỉ được gồm các đơn đã nhận bởi tài khoản này.");
  }
  const nextRevision = currentRevision + 1;
  const savedPayload = { ...payload, ownerId: user.id, ownerName: user.name, serverRevision: nextRevision };
  await client.query(`INSERT INTO mealfit_sessions (session_id, owner_id, status, payload, revision)
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (session_id) DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload, revision = EXCLUDED.revision, updated_at = now()`,
    [sessionId, user.id, payload.status, JSON.stringify(savedPayload), nextRevision]);
  await client.query("INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, operation_id) VALUES ($1, 'session', $2, 'update', $3)", [user.id, sessionId, id]);
  const result = { id, sessionId, revision: nextRevision };
  await client.query("INSERT INTO mealfit_operations (operation_id, actor_id, entity_type, entity_id, body_hash, result) VALUES ($1, $2, 'session', $3, $4, $5::jsonb)", [id, user.id, sessionId, bodyHash, JSON.stringify(result)]);
  return result;
}

export default handler(async (req, res) => {
  requireMethod(req, "POST");
  assertSameOrigin(req);
  const user = requireUser(req);
  const body = await readJson(req);
  const operations = Array.isArray(body.operations) ? body.operations : [];
  if (!operations.length || operations.length > 50) throw new AppError(400, "INVALID_BATCH", "Mỗi lần đồng bộ nhận từ 1 đến 50 thao tác.");
  const results = await withTransaction(async client => {
    const sorted = [...operations].sort((a, b) => Number(b.type === "session") - Number(a.type === "session"));
    const output = [];
    for (const operation of sorted) {
      if (operation.type === "order") output.push(await applyOrder(client, operation, user));
      else if (operation.type === "session") output.push(await applySession(client, operation, user));
      else throw new AppError(400, "INVALID_OPERATION", "Loại thao tác không hợp lệ.");
    }
    return output;
  });
  const conflict = results.find(result => result.conflict);
  if (conflict) {
    send(res, 409, { error: { code: "REVISION_CONFLICT", message: "Đơn hoặc phiên đã được cập nhật ở nơi khác. Làm mới dữ liệu để xử lý xung đột." }, conflict, results });
    return;
  }
  waitUntil(flushUpstream().catch(error => console.error(JSON.stringify({ code: "OUTBOX_RETRY", message: error.message }))));
  send(res, 200, { results });
});
