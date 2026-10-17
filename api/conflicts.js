import { handler, readJson, requireMethod, send, AppError } from "../server-lib/core.mjs";
import { assertSameOrigin, requireUser } from "../server-lib/auth.mjs";
import { getSql, withTransaction } from "../server-lib/db.mjs";
import { normalizeSheetOrder } from "../server-lib/orders.mjs";

export default handler(async (req, res) => {
  const user = await requireUser(req);
  if (user.role !== "admin") throw new AppError(403, "ADMIN_ONLY", "Chỉ Admin có thể xử lý xung đột.");
  if (req.method === "GET") {
    const rows = await getSql()`SELECT conflict_id AS id, order_code AS code, app_revision AS "appRevision", sheet_revision AS "sheetRevision", app_payload AS "appPayload", sheet_payload AS "sheetPayload", created_at AS "createdAt" FROM mealfit_conflicts WHERE status = 'open' ORDER BY created_at DESC LIMIT 100`;
    send(res, 200, { data: rows });
    return;
  }
  requireMethod(req, "POST");
  assertSameOrigin(req);
  const body = await readJson(req);
  if (!body.id || body.resolution !== "sheet") throw new AppError(400, "INVALID_RESOLUTION", "Dữ liệu Google Sheet là nguồn chuẩn để xử lý xung đột.");
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
    }
    await client.query("UPDATE mealfit_upstream_outbox SET status = 'sent', last_error = NULL, updated_at = now() WHERE order_code = $1 AND status = 'conflict'", [conflict.order_code]);
    await client.query("UPDATE mealfit_conflicts SET status = 'resolved-sheet', resolved_by = $1, resolved_at = now() WHERE conflict_id = $2", [user.id, body.id]);
    await client.query("INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, detail) VALUES ($1, 'order', $2, 'resolve-conflict', $3::jsonb)", [user.id, conflict.order_code, JSON.stringify({ resolution: body.resolution })]);
    return { code: conflict.order_code, resolution: body.resolution };
  });
  send(res, 200, { ok: true, ...result });
});
