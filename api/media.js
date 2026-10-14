import { del, get, put } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import { handler, requireMethod, send, AppError } from "../server-lib/core.mjs";
import { assertSameOrigin, requireUser } from "../server-lib/auth.mjs";
import { getSql } from "../server-lib/db.mjs";
import { requireEnv } from "../server-lib/core.mjs";
import { n8nRequest } from "../server-lib/n8n.mjs";

export const config = { api: { bodyParser: false } };
const MAX_BYTES = 2 * 1024 * 1024;

function readImage(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let exceeded = false;
    req.on("data", chunk => {
      length += chunk.length;
      if (length > MAX_BYTES) {
        if (!exceeded) reject(new AppError(413, "IMAGE_TOO_LARGE", "Ảnh sau khi nén phải nhỏ hơn 2 MB."));
        exceeded = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

async function canAccessOrder(code, user) {
  const rows = await getSql()`SELECT code, customer, assigned_user_id FROM mealfit_orders WHERE code = ${code} LIMIT 1`;
  const order = rows[0];
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Không tìm thấy đơn hàng.");
  if (user.role === "shipper" && order.assigned_user_id !== user.id) throw new AppError(403, "ORDER_FORBIDDEN", "Shipper chỉ được thêm ảnh cho đơn đã nhận.");
  return order;
}

async function uploadToN8n({ mediaId, orderCode, customer, blob, type, filename }) {
  const form = new FormData();
  form.append("sheet_id", requireEnv("N8N_SHEET_ID"));
  form.append("folder_id", requireEnv("N8N_FOLDER_ID", "Chưa cấu hình thư mục ảnh cho môi trường này."));
  form.append("code", orderCode);
  form.append("name", customer || orderCode);
  form.append("message", "Ảnh xác nhận");
  form.append("media_id", mediaId);
  form.append("files", new Blob([blob], { type }), filename);
  return n8nRequest("upload-medias", { method: "POST", headers: { "idempotency-key": mediaId }, body: form });
}

export default handler(async (req, res) => {
  const user = await requireUser(req);
  const sql = getSql();
  const url = new URL(req.url, "https://mealfit.local");
  const id = String(req.query?.id || url.searchParams.get("id") || "");
  if (req.method === "GET" && id && !url.searchParams.has("code")) {
    const rows = await sql`SELECT m.*, o.assigned_user_id FROM mealfit_media m JOIN mealfit_orders o ON o.code = m.order_code WHERE m.media_id = ${id} LIMIT 1`;
    const media = rows[0];
    if (!media) throw new AppError(404, "MEDIA_NOT_FOUND", "Không tìm thấy ảnh.");
    if (user.role === "shipper" && media.assigned_user_id !== user.id) throw new AppError(403, "MEDIA_FORBIDDEN", "Không có quyền xem ảnh này.");
    const result = await get(media.blob_pathname, { access: "private" });
    if (!result || result.statusCode !== 200) throw new AppError(404, "MEDIA_NOT_FOUND", "Ảnh đã bị xóa hoặc không còn khả dụng.");
    res.writeHead(200, { "content-type": media.content_type, "cache-control": "private, max-age=3600", "content-length": result.blob.size, "x-content-type-options": "nosniff" });
    result.stream.pipe(res);
    return;
  }
  if (req.method === "DELETE" && id) {
    assertSameOrigin(req);
    const rows = await sql`SELECT m.*, o.assigned_user_id FROM mealfit_media m JOIN mealfit_orders o ON o.code = m.order_code WHERE m.media_id = ${id} LIMIT 1`;
    const media = rows[0];
    if (!media) throw new AppError(404, "MEDIA_NOT_FOUND", "Không tìm thấy ảnh.");
    if (user.role === "shipper" && media.assigned_user_id !== user.id) throw new AppError(403, "MEDIA_FORBIDDEN", "Không có quyền xóa ảnh này.");
    await del(media.blob_pathname, { access: "private" });
    await sql`UPDATE mealfit_media SET status = 'deleted', updated_at = now() WHERE media_id = ${id}`;
    send(res, 200, { ok: true, id });
    return;
  }
  if (req.method === "GET") {
    const code = String(req.query?.code || url.searchParams.get("code") || "");
    await canAccessOrder(code, user);
    const rows = await sql`SELECT media_id AS id, filename AS name, content_type AS "contentType", status, created_at AS "createdAt" FROM mealfit_media WHERE order_code = ${code} AND status <> 'deleted' ORDER BY created_at`;
    send(res, 200, { data: rows });
    return;
  }
  requireMethod(req, "POST");
  assertSameOrigin(req);
  const orderCode = url.searchParams.get("code") || "";
  const mediaId = url.searchParams.get("id") || randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(mediaId)) throw new AppError(400, "INVALID_MEDIA", "Mã ảnh không hợp lệ.");
  const order = await canAccessOrder(orderCode, user);
  const type = String(req.headers["content-type"] || "");
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new AppError(415, "INVALID_MEDIA_TYPE", "Chỉ nhận ảnh JPG, PNG hoặc WebP.");
  const bytes = await readImage(req);
  if (!bytes.length) throw new AppError(400, "EMPTY_MEDIA", "Không có dữ liệu ảnh.");
  const requestedName = decodeURIComponent(url.searchParams.get("name") || `${mediaId}.jpg`).slice(0, 120);
  const pathname = `mealfit/${encodeURIComponent(orderCode)}/${mediaId}.jpg`;
  const savedBlob = await put(pathname, new Blob([bytes], { type }), { access: "private", addRandomSuffix: false, allowOverwrite: true });
  await sql`INSERT INTO mealfit_media (media_id, order_code, blob_pathname, filename, content_type, status, created_by)
    VALUES (${mediaId}, ${orderCode}, ${savedBlob.pathname}, ${requestedName}, ${type}, 'queued', ${user.id})
    ON CONFLICT (media_id) DO UPDATE SET blob_pathname = EXCLUDED.blob_pathname, filename = EXCLUDED.filename, status = 'queued', updated_at = now()`;
  let uploaded = false;
  try {
    const response = await uploadToN8n({ mediaId, orderCode, customer: order.customer, blob: bytes, type, filename: `${mediaId}.jpg` });
    const n8nId = String(response.id || response.fileId || response.file_id || "");
    await sql`UPDATE mealfit_media SET status = 'sent', n8n_file_id = ${n8nId || null}, updated_at = now() WHERE media_id = ${mediaId}`;
    uploaded = true;
  } catch (error) {
    const code = error?.code || "MEDIA_UPSTREAM_ERROR";
    await sql`UPDATE mealfit_media SET status = 'failed', updated_at = now() WHERE media_id = ${mediaId}`;
    console.error(JSON.stringify({ code, mediaId }));
  }
  send(res, uploaded ? 200 : 202, { id: mediaId, status: uploaded ? "sent" : "queued", message: uploaded ? "Đã đồng bộ ảnh." : "Ảnh đã lưu an toàn, đang chờ đồng bộ." });
});
