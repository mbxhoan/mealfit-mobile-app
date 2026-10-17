import { randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { handler, readJson, requireMethod, send, AppError } from "../server-lib/core.mjs";
import { assertSameOrigin, requireUser } from "../server-lib/auth.mjs";
import { withTransaction } from "../server-lib/db.mjs";
import { queueUpstream, flushUpstream } from "../server-lib/upstream.mjs";
import { canReuseClaim } from "../server-lib/orders.mjs";

export default handler(async (req, res) => {
  requireMethod(req, "POST");
  assertSameOrigin(req);
  const user = await requireUser(req);
  if (user.role !== "shipper") throw new AppError(403, "SHIPPER_ONLY", "Chỉ shipper có thể nhận đơn chưa phân công.");
  const body = await readJson(req);
  const codes = [...new Set((Array.isArray(body.codes) ? body.codes : []).map(String))];
  if (!codes.length || codes.length > 50) throw new AppError(400, "INVALID_CLAIM", "Chọn từ 1 đến 50 đơn để nhận.");
  const claimed = await withTransaction(async client => {
    const results = [];
    for (const code of codes) {
      const update = await client.query(
        "UPDATE mealfit_orders SET assigned_user_id = $1, shipper_name = $2, revision = revision + 1, updated_at = now() WHERE code = $3 AND shipping_status = 'Chưa giao hàng' AND assigned_user_id IS NULL RETURNING *",
        [user.id, user.name, code]
      );
      const order = update.rows[0] || (await client.query("SELECT * FROM mealfit_orders WHERE code = $1 FOR UPDATE", [code])).rows[0];
      if (!order || (!update.rows[0] && !canReuseClaim(order, user.id))) throw new AppError(409, "ORDER_ALREADY_CLAIMED", `${code} đã được nhận bởi người khác. Làm mới danh sách rồi thử lại.`);
      const normalized = {
        id: order.code,
        customer: order.customer,
        phone: order.phone,
        address: order.address,
        shipperName: user.name,
        total: Number(order.total),
        paidAmount: Number(order.paid_amount),
        paymentStatus: order.payment_status,
        deliveryStatus: order.shipping_status,
        note: order.note,
        sourceRevision: Number(order.source_revision)
      };
      if (update.rows[0]) {
        const operationId = randomUUID();
        await queueUpstream(client, operationId, normalized, order.revision);
        await client.query(
          "INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, operation_id) VALUES ($1, 'order', $2, 'claim', $3)",
          [user.id, code, operationId]
        );
      }
      results.push({ order, claimed: Boolean(update.rows[0]) });
    }
    return results;
  });
  waitUntil(flushUpstream(50, codes).catch(error => console.error(JSON.stringify({ code: "OUTBOX_RETRY", message: error.message }))));
  send(res, 200, { data: claimed.map(({ order, claimed: newlyClaimed }) => ({ id: order.code, assignedUserId: user.id, shipperName: user.name, serverRevision: Number(order.revision), claimed: newlyClaimed })) });
});
