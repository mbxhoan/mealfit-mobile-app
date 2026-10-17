import { createHash } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { handler, readJson, requireMethod, send, AppError } from "../server-lib/core.mjs";
import { assertSameOrigin, requireUser } from "../server-lib/auth.mjs";
import { withTransaction } from "../server-lib/db.mjs";
import { sheetOrderBelongsToShipper } from "../server-lib/accounts.mjs";
import { DELIVERY_STATUSES, PAYMENT_STATUSES, PAYMENT_METHODS, validateOrderMutation } from "../server-lib/orders.mjs";
import { queueUpstream, flushUpstream, pendingUpstream } from "../server-lib/upstream.mjs";

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
  if (user.role === "shipper" && current.assigned_user_id !== user.id) {
    return { id, code, conflict: true, errorCode: "ORDER_FORBIDDEN", revision: Number(current.revision) };
  }
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
  const total = Math.round(Number(payload.total ?? current.total) || 0);
  const paidAmount = Math.round(Number(payload.paidAmount));
  const remainingDue = payload.paymentStatus === "Đã thanh toán" ? 0 : Math.max(0, Math.round(Number(payload.remainingDue ?? current.remaining_due ?? (total - paidAmount))));
  const raw = {
    ...(current.row_data || {}),
    "Mã đơn": code,
    "Trạng thái giao hàng": payload.deliveryStatus,
    "Trạng thái đơn": payload.paymentStatus,
    "Đã thanh toán": paidAmount,
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
    [JSON.stringify(raw), total, paidAmount, remainingDue,
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
  await queueUpstream(client, id, { ...payload, id: code, shipperName, total, paidAmount, remainingDue, paymentStatus: payload.paymentStatus, deliveryStatus: payload.deliveryStatus, note: payload.note }, revision);
  await client.query("INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, operation_id, detail) VALUES ($1, 'order', $2, 'update', $3, $4::jsonb)", [user.id, code, id, JSON.stringify({ revision })]);
  const result = { id, code, revision };
  await client.query("INSERT INTO mealfit_operations (operation_id, actor_id, entity_type, entity_id, body_hash, result) VALUES ($1, $2, 'order', $3, $4, $5::jsonb)", [id, user.id, code, bodyHash, JSON.stringify(result)]);
  return result;
}

async function applySession(client, operation, user) {
  const id = String(operation?.operationId || "");
  const sessionId = String(operation?.entityId || operation?.payload?.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id) || !sessionId.startsWith("PS-")) throw new AppError(400, "INVALID_OPERATION", "Mã phiên hoặc thao tác không hợp lệ.");
  const payload = operation.payload;
  const deleting = payload?.deleted === true;
  if (user.role !== "shipper" && !(deleting && user.role === "admin")) throw new AppError(403, "SHIPPER_ONLY", "Chỉ shipper có thể cập nhật phiên giao hàng.");
  if (!payload || !["notStarted", "active", "paused", "completed", "cancelled"].includes(payload.status) || !Array.isArray(payload.orderIds) || payload.orderIds.length > 500 || new Set(payload.orderIds).size !== payload.orderIds.length) throw new AppError(400, "INVALID_SESSION", "Thông tin phiên giao hàng không hợp lệ.");
  if (deleting && payload.status !== "cancelled") throw new AppError(400, "INVALID_SESSION", "Phiên đã xóa phải ở trạng thái đã hủy.");
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
  if (deleting && user.role === "admin" && !current) throw new AppError(404, "SESSION_NOT_FOUND", "Không tìm thấy phiên cần xóa.");
  if (current && current.owner_id !== user.id && !(deleting && user.role === "admin")) throw new AppError(403, "SESSION_FORBIDDEN", "Phiên này thuộc shipper khác.");
  const ownerId = current?.owner_id || user.id;
  const currentRevision = Number(current?.revision || 0);
  if (Number(operation.baseRevision || 0) !== currentRevision) return { conflict: true, id, sessionId, revision: currentRevision };
  if (payload.orderIds.length) {
    const assigned = await client.query(`SELECT code, assigned_user_id, shipper_name, shipping_status FROM mealfit_orders WHERE code = ANY($1::text[])`, [payload.orderIds]);
    const ordersByCode = new Map(assigned.rows.map(order => [order.code, order]));
    const unassignedCodes = payload.orderIds.filter(code => !sheetOrderBelongsToShipper(ordersByCode.get(code), user));
    if (unassignedCodes.length) {
      return { id, sessionId, conflict: true, errorCode: "SESSION_ORDER_FORBIDDEN", unassignedCodes, revision: currentRevision };
    }
    const repairCodes = assigned.rows.filter(order => order.assigned_user_id !== ownerId).map(order => order.code);
    const repaired = repairCodes.length
      ? await client.query(`UPDATE mealfit_orders SET assigned_user_id = $2 WHERE code = ANY($1::text[]) RETURNING code`, [repairCodes, ownerId])
      : { rows: [] };
    if (repaired.rows.length) await client.query(`INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, detail)
      SELECT $1, 'order', code, 'assignment-repair', '{"source":"session-sync"}'::jsonb
      FROM unnest($2::text[]) AS code`, [user.id, repaired.rows.map(row => row.code)]);
    if (payload.status === "active") {
      const pending = await client.query(`SELECT order_code, status, next_attempt_at FROM mealfit_upstream_outbox
        WHERE order_code = ANY($1::text[]) AND status IN ('queued', 'sending', 'failed', 'conflict')`, [payload.orderIds]);
      const conflicts = pending.rows.filter(row => row.status === "conflict").map(row => row.order_code);
      if (conflicts.length) return { id, sessionId, conflict: true, errorCode: "SESSION_ORDER_SHEET_CONFLICT", orderCodes: [...new Set(conflicts)], revision: currentRevision };
      if (pending.rows.length) {
        waitUntil(flushUpstream(50, payload.orderIds).catch(error => console.error(JSON.stringify({ code: "OUTBOX_RETRY", message: error.message }))));
        const retryAt = Math.min(...pending.rows.filter(row => row.status === "failed").map(row => new Date(row.next_attempt_at).getTime()).filter(Number.isFinite));
        const retryAfterSeconds = Number.isFinite(retryAt) ? Math.max(3, Math.min(30, Math.ceil((retryAt - Date.now()) / 1000))) : 5;
        const error = new AppError(503, "SESSION_ORDERS_PENDING", "Đang chờ webhook xác nhận trạng thái của các đơn trong lộ trình.");
        error.retryAfterSeconds = retryAfterSeconds;
        throw error;
      }
      const notInTransit = payload.orderIds.filter(code => ordersByCode.get(code)?.shipping_status !== "Đang giao hàng");
      if (notInTransit.length) return { id, sessionId, conflict: true, errorCode: "SESSION_ORDER_STATUS_MISMATCH", orderCodes: notInTransit, revision: currentRevision };
    }
  }
  const nextRevision = currentRevision + 1;
  const ownerName = current?.owner_id === user.id ? user.name : current?.payload?.ownerName || user.name;
  const savedPayload = { ...payload, ownerId, ownerName, serverRevision: nextRevision };
  await client.query(`INSERT INTO mealfit_sessions (session_id, owner_id, status, payload, revision)
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (session_id) DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload, revision = EXCLUDED.revision, updated_at = now()`,
    [sessionId, ownerId, payload.status, JSON.stringify(savedPayload), nextRevision]);
  await client.query("INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, operation_id) VALUES ($1, 'session', $2, $3, $4)", [user.id, sessionId, deleting ? "delete" : "update", id]);
  const result = { id, sessionId, revision: nextRevision };
  await client.query("INSERT INTO mealfit_operations (operation_id, actor_id, entity_type, entity_id, body_hash, result) VALUES ($1, $2, 'session', $3, $4, $5::jsonb)", [id, user.id, sessionId, bodyHash, JSON.stringify(result)]);
  return result;
}

export default handler(async (req, res) => {
  requireMethod(req, "POST");
  assertSameOrigin(req);
  const user = await requireUser(req);
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
  const orderCodes = [...new Set(operations
    .filter(operation => operation.type === "order")
    .map(operation => operation.entityId || operation.payload?.id)
    .filter(Boolean).map(String))];
  if (orderCodes.length) {
    await flushUpstream(50, orderCodes);
    const pending = await pendingUpstream(orderCodes);
    const conflicts = new Set(pending.filter(item => item.status === "conflict").map(item => item.order_code));
    if (conflicts.size) {
      send(res, 409, {
        error: { code: "SHEET_REVISION_CONFLICT", message: "Google Sheet đã có dữ liệu mới hơn. Danh sách sẽ được làm mới từ Sheet." },
        results: results.map(result => conflicts.has(result.code) ? { ...result, conflict: true, errorCode: "SHEET_REVISION_CONFLICT" } : result)
      });
      return;
    }
    if (pending.length) {
      const retryAt = Math.min(...pending.map(item => new Date(item.next_attempt_at).getTime()).filter(Number.isFinite));
      const error = new AppError(503, "SHEET_SYNC_PENDING", "Google Sheet chưa xác nhận đủ số tiền và trạng thái. Thay đổi đã được lưu và sẽ tự đồng bộ lại.");
      error.retryAfterSeconds = Number.isFinite(retryAt) ? Math.max(3, Math.min(30, Math.ceil((retryAt - Date.now()) / 1000))) : 5;
      throw error;
    }
  }
  const conflict = results.find(result => result.conflict && result.errorCode !== "SESSION_ORDER_FORBIDDEN")
    || results.find(result => result.conflict);
  if (conflict) {
    const sessionConflict = conflict.errorCode === "SESSION_ORDER_FORBIDDEN";
    send(res, 409, {
      error: {
        code: conflict.errorCode || "REVISION_CONFLICT",
        message: sessionConflict
          ? `Các đơn ${conflict.unassignedCodes?.join(", ") || "trong phiên"} chưa được gán cho tài khoản này. Phiên được giữ trong lịch sử trên thiết bị.`
          : conflict.errorCode === "SESSION_ORDER_SHEET_CONFLICT"
            ? `Google Sheet chưa xác nhận các đơn ${conflict.orderCodes?.join(", ") || "trong phiên"}. Làm mới dữ liệu để xử lý theo trạng thái trên Sheet.`
            : conflict.errorCode === "SESSION_ORDER_STATUS_MISMATCH"
              ? `Trạng thái trên máy chủ chưa là Đang giao hàng cho ${conflict.orderCodes?.join(", ") || "một số đơn"}. Làm mới dữ liệu rồi thử lại.`
              : "Đơn hoặc phiên đã được cập nhật ở nơi khác. Làm mới dữ liệu để xử lý xung đột."
      },
      conflict, results
    });
    return;
  }
  send(res, 200, { results, upstreamPending: 0 });
});
