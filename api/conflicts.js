import { randomUUID } from "node:crypto";
import { handler, readJson, requireMethod, send, AppError } from "./lib/core.mjs";
import { assertSameOrigin, requireUser } from "./lib/auth.mjs";
import { getSql, withTransaction } from "./lib/db.mjs";
import { normalizeSheetOrder, validateOrderMutation } from "./lib/orders.mjs";
import { queueUpstream } from "./lib/upstream.mjs";

export default handler(async (req, res) => {
  const user = requireUser(req);
  if (user.role !== "admin") throw new AppError(403, "ADMIN_ONLY", "Chỉ Admin có thể xử lý xung đột.");
  if (req.method === "GET") {
    const rows = await getSql()`SELECT conflict_id AS id, order_code AS code, app_revision AS "appRevision", sheet_revision AS "sheetRevision", app_payload AS "appPayload", sheet_payload AS "sheetPayload", created_at AS "createdAt" FROM mealfit_conflicts WHERE status = 'open' ORDER BY created_at DESC LIMIT 100`;
    send(res, 200, { data: rows });
    return;
  }
  requireMethod(req, "POST");
  assertSameOrigin(req);
  const body = await readJson(req);
  if (!body.id || !["sheet", "app"].includes(body.resolution)) throw new AppError(400, "INVALID_RESOLUTION", "Chọn dữ liệu Sheet hoặc ứng dụng để xử lý xung đột.");
  const result = await withTransaction(async client => {
    const found = await client.query("SELECT * FROM mealfit_conflicts WHERE conflict_id = $1 AND status = 'open' FOR UPDATE", [String(body.id)]);
    const conflict = found.rows[0];
    if (!conflict) throw new AppError(404, "CONFLICT_NOT_FOUND", "Xung đột này đã được xử lý.");
    const currentOrder = await client.query("SELECT * FROM mealfit_orders WHERE code = $1 FOR UPDATE", [conflict.order_code]);
    const current = currentOrder.rows[0];
    if (!current) throw new AppError(404, "ORDER_NOT_FOUND", "Không tìm thấy đơn hàng.");
    if (body.resolution === "sheet") {
      const order = normalizeSheetOrder(conflict.sheet_payload, { mapsLink: current.maps_url, sessionId: current.session_id, payments: current.payments, serverRevision: Number(current.revision) + 1 });
      if (!order) throw new AppError(409, "INVALID_SHEET_ROW", "Dòng Google Sheet không đủ thông tin để khôi phục.");
      await client.query(`UPDATE mealfit_orders SET row_data = $1::jsonb, customer = $2, phone = $3, address = $4,
        ordered_at = $5, subtotal = $6, shipping_fee = $7, total = $8, paid_amount = $9, remaining_due = $10,
        payment_status = $11, shipping_status = $12, shipper_name = $13, assigned_user_id = $14,
        note = $15, items = COALESCE($16::jsonb, items), source_revision = $17, revision = revision + 1, updated_at = now() WHERE code = $18`,
        [JSON.stringify(conflict.sheet_payload), order.customer, order.phone, order.address, order.date, order.subtotal, order.shippingFee, order.total, order.paidAmount, order.remainingDue, order.paymentStatus, order.deliveryStatus, order.shipperName || "Chưa phân công", order.assignedUserId, order.note, JSON.stringify(order.items || null), order.sourceRevision, conflict.order_code]);
    } else {
      const order = validateOrderMutation(conflict.app_payload);
      const nextRevision = Number(current.revision) + 1;
      await client.query(`UPDATE mealfit_orders SET shipping_status = $1, payment_status = $2, paid_amount = $3,
        remaining_due = $4, shipper_name = $5, note = $6, maps_url = $7, session_id = $8,
        source_revision = $10, row_data = jsonb_set(row_data, '{revision}', to_jsonb($10::bigint), true),
        revision = $9, updated_at = now() WHERE code = $11`,
        [order.deliveryStatus, order.paymentStatus, order.paidAmount, order.paymentStatus === "Đã thanh toán" ? 0 : order.remainingDue,
          order.shipperName, order.note, order.mapsLink || "", order.sessionId || null, nextRevision, conflict.sheet_revision, conflict.order_code]);
      await client.query("UPDATE mealfit_upstream_outbox SET status = 'sent', last_error = NULL, updated_at = now() WHERE order_code = $1 AND status = 'conflict'", [conflict.order_code]);
      await queueUpstream(client, randomUUID(), { ...order, id: conflict.order_code }, nextRevision);
    }
    if (body.resolution === "sheet") await client.query("UPDATE mealfit_upstream_outbox SET status = 'sent', last_error = NULL, updated_at = now() WHERE order_code = $1 AND status = 'conflict'", [conflict.order_code]);
    await client.query("UPDATE mealfit_conflicts SET status = $1, resolved_by = $2, resolved_at = now() WHERE conflict_id = $3", [body.resolution === "sheet" ? "resolved-sheet" : "resolved-app", user.id, body.id]);
    await client.query("INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, detail) VALUES ($1, 'order', $2, 'resolve-conflict', $3::jsonb)", [user.id, conflict.order_code, JSON.stringify({ resolution: body.resolution })]);
    return { code: conflict.order_code, resolution: body.resolution };
  });
  send(res, 200, { ok: true, ...result });
});
