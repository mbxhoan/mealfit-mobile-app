import { handler, requireMethod, send, AppError } from "../server-lib/core.mjs";
import { requireUser } from "../server-lib/auth.mjs";
import { getSql } from "../server-lib/db.mjs";
import { importSheetOrders, orderFromRow } from "../server-lib/sync.mjs";
import { fetchSheetOrder } from "../server-lib/n8n.mjs";

function cursorFrom(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!cursor || !(cursor.at === null || (typeof cursor.at === "string" && Number.isFinite(Date.parse(cursor.at)))) || !/^[A-Za-z0-9_-]{2,40}$/.test(cursor.code || "")) throw new Error();
    return cursor;
  }
  catch { throw new AppError(400, "INVALID_CURSOR", "Không thể đọc vị trí trang đơn hàng."); }
}

export default handler(async (req, res) => {
  requireMethod(req, "GET");
  const user = await requireUser(req);
  const url = new URL(req.url, `https://${req.headers.host || "mealfit.local"}`);
  const code = String(req.query?.code || url.searchParams.get("code") || "");
  if (code) {
    const sql = getSql();
    let rows = await sql`SELECT * FROM mealfit_orders WHERE code = ${code} LIMIT 1`;
    let order = rows[0] && orderFromRow(rows[0]);
    if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Không tìm thấy đơn hàng.");
    if (user.role === "shipper" && order.assignedUserId && order.assignedUserId !== user.id) throw new AppError(403, "ORDER_FORBIDDEN", "Đơn hàng này chưa được giao cho tài khoản của bạn.");
    if (url.searchParams.get("refresh") === "1") {
      const sheetRow = await fetchSheetOrder(code).catch(error => { throw error instanceof AppError ? error : new AppError(502, "ORDER_REFRESH_FAILED", "Không thể làm mới chi tiết đơn hàng."); });
      await importSheetOrders([sheetRow]);
      rows = await sql`SELECT * FROM mealfit_orders WHERE code = ${code} LIMIT 1`;
      order = rows[0] && orderFromRow(rows[0]);
      if (user.role === "shipper" && order.assignedUserId && order.assignedUserId !== user.id) throw new AppError(403, "ORDER_FORBIDDEN", "Đơn hàng này chưa được giao cho tài khoản của bạn.");
    }
    send(res, 200, { data: order });
    return;
  }
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 30));
  const status = url.searchParams.get("status") || "";
  const cursor = cursorFrom(url.searchParams.get("cursor"));
  const cursorAt = cursor?.at || null;
  const cursorCode = cursor?.code || "";
  const sql = getSql();
  if (status && !["Chưa giao hàng", "Đang giao hàng", "Đã giao hàng", "Đã huỷ đơn"].includes(status)) throw new AppError(400, "INVALID_FILTER", "Bộ lọc trạng thái không hợp lệ.");
  let shipperSnapshot = false;
  let shipperScope = null;
  if (user.role === "shipper") {
    const snapshots = await sql`SELECT value FROM mealfit_sync_meta WHERE key = ${`shipper-order-snapshot:${user.id}`} LIMIT 1`;
    shipperSnapshot = Boolean(snapshots[0]);
    if (shipperSnapshot) {
      const active = await sql`SELECT DISTINCT item.order_code
        FROM mealfit_sessions AS session
        CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(session.payload->'orderIds', '[]'::jsonb)) AS item(order_code)
        WHERE session.owner_id = ${user.id} AND session.status IN ('notStarted', 'active', 'paused')`;
      shipperScope = [...new Set([...(snapshots[0].value?.codes || []), ...active.map(row => row.order_code)])];
    }
  }
  const rows = await sql`
    SELECT * FROM mealfit_orders
    WHERE (${user.role !== "shipper"}
      OR (${shipperScope === null} AND (assigned_user_id = ${user.id} OR assigned_user_id IS NULL))
      OR (${shipperScope !== null} AND code = ANY(${shipperScope || []}::text[])))
      AND (${status} = '' OR shipping_status = ${status})
      AND (${cursor === null} OR
        (${cursorAt}::timestamptz IS NOT NULL AND (ordered_at < ${cursorAt}::timestamptz OR (ordered_at = ${cursorAt}::timestamptz AND code < ${cursorCode}) OR ordered_at IS NULL)) OR
        (${cursor !== null && cursorAt === null} AND ordered_at IS NULL AND code < ${cursorCode}))
    ORDER BY ordered_at DESC NULLS LAST, code DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(orderFromRow).filter(Boolean);
  let counts = [];
  if (!cursor) {
    counts = await sql`
      SELECT shipping_status, count(*)::int AS count
      FROM mealfit_orders
      WHERE (${user.role !== "shipper"}
        OR (${shipperScope === null} AND (assigned_user_id = ${user.id} OR assigned_user_id IS NULL))
        OR (${shipperScope !== null} AND code = ANY(${shipperScope || []}::text[])))
      GROUP BY shipping_status
    `;
  }
  const last = rows.slice(0, limit).at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ at: last.ordered_at, code: last.code })).toString("base64url") : null;
  send(res, 200, { data: page, total: Number(counts.reduce((sum, row) => sum + Number(row.count), 0)), counts: Object.fromEntries(counts.map(row => [row.shipping_status, Number(row.count)])), nextCursor, shipperSnapshot });
});
