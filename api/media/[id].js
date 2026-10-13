import { get } from "@vercel/blob";
import { handler, requireMethod, send, AppError } from "../lib/core.mjs";
import { assertSameOrigin, requireUser } from "../lib/auth.mjs";
import { getSql } from "../lib/db.mjs";
import { del } from "@vercel/blob";

export default handler(async (req, res) => {
  const user = requireUser(req);
  const id = String(req.query?.id || new URL(req.url, "https://mealfit.local").pathname.split("/").at(-1) || "");
  const sql = getSql();
  const rows = await sql`SELECT m.*, o.assigned_user_id FROM mealfit_media m JOIN mealfit_orders o ON o.code = m.order_code WHERE m.media_id = ${id} LIMIT 1`;
  const media = rows[0];
  if (!media) throw new AppError(404, "MEDIA_NOT_FOUND", "Không tìm thấy ảnh.");
  if (user.role === "shipper" && media.assigned_user_id !== user.id) throw new AppError(403, "MEDIA_FORBIDDEN", "Không có quyền xem ảnh này.");
  if (req.method === "GET") {
    const result = await get(media.blob_pathname, { access: "private" });
    if (!result || result.statusCode !== 200) throw new AppError(404, "MEDIA_NOT_FOUND", "Ảnh đã bị xóa hoặc không còn khả dụng.");
    res.writeHead(200, { "content-type": media.content_type, "cache-control": "private, max-age=3600", "content-length": result.blob.size, "x-content-type-options": "nosniff" });
    result.stream.pipe(res);
    return;
  }
  requireMethod(req, "DELETE");
  assertSameOrigin(req);
  await del(media.blob_pathname, { access: "private" });
  await sql`UPDATE mealfit_media SET status = 'deleted', updated_at = now() WHERE media_id = ${id}`;
  send(res, 200, { ok: true, id });
});
