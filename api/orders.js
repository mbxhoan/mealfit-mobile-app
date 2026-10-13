import { handler, requireMethod, send, AppError } from "./lib/core.mjs";
import { requireUser } from "./lib/auth.mjs";
import { getSql } from "./lib/db.mjs";
import { orderFromRow } from "./lib/sync.mjs";

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
  const user = requireUser(req);
  const url = new URL(req.url, `https://${req.headers.host || "mealfit.local"}`);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 30));
  const status = url.searchParams.get("status") || "";
  const cursor = cursorFrom(url.searchParams.get("cursor"));
  const cursorAt = cursor?.at || null;
  const cursorCode = cursor?.code || "";
  const sql = getSql();
  if (status && !["Chưa giao hàng", "Đang giao hàng", "Đã giao hàng", "Đã huỷ đơn"].includes(status)) throw new AppError(400, "INVALID_FILTER", "Bộ lọc trạng thái không hợp lệ.");
  const rows = await sql`
    SELECT * FROM mealfit_orders
    WHERE (${user.role !== "shipper"} OR assigned_user_id = ${user.id} OR assigned_user_id IS NULL)
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
      WHERE (${user.role !== "shipper"} OR assigned_user_id = ${user.id} OR assigned_user_id IS NULL)
      GROUP BY shipping_status
    `;
  }
  const last = rows.slice(0, limit).at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ at: last.ordered_at, code: last.code })).toString("base64url") : null;
  send(res, 200, { data: page, total: Number(counts.reduce((sum, row) => sum + Number(row.count), 0)), counts: Object.fromEntries(counts.map(row => [row.shipping_status, Number(row.count)])), nextCursor });
});
