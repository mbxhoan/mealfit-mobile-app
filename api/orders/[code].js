import { handler, requireMethod, send, AppError } from "../lib/core.mjs";
import { requireUser } from "../lib/auth.mjs";
import { getSql } from "../lib/db.mjs";
import { orderFromRow, importSheetOrders } from "../lib/sync.mjs";
import { fetchSheetOrder } from "../lib/n8n.mjs";

export default handler(async (req, res) => {
  requireMethod(req, "GET");
  const user = requireUser(req);
  const code = String(req.query?.code || new URL(req.url, "https://mealfit.local").pathname.split("/").at(-1) || "");
  const sql = getSql();
  let rows = await sql`SELECT * FROM mealfit_orders WHERE code = ${code} LIMIT 1`;
  let order = rows[0] && orderFromRow(rows[0]);
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Không tìm thấy đơn hàng.");
  if (user.role === "shipper" && order.assignedUserId && order.assignedUserId !== user.id) throw new AppError(403, "ORDER_FORBIDDEN", "Đơn hàng này chưa được giao cho tài khoản của bạn.");
  const url = new URL(req.url, "https://mealfit.local");
  if (url.searchParams.get("refresh") === "1") {
    const sheetRow = await fetchSheetOrder(code).catch(error => { throw error instanceof AppError ? error : new AppError(502, "ORDER_REFRESH_FAILED", "Không thể làm mới chi tiết đơn hàng."); });
    await importSheetOrders([sheetRow]);
    rows = await sql`SELECT * FROM mealfit_orders WHERE code = ${code} LIMIT 1`;
    order = rows[0] && orderFromRow(rows[0]);
  }
  send(res, 200, { data: order });
});
