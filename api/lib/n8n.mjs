import { AppError, requireEnv } from "./core.mjs";

export async function n8nRequest(path, options = {}) {
  const base = requireEnv("N8N_BASE_URL", "Kết nối Google Sheet chưa được cấu hình.").replace(/\/$/, "");
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${requireEnv("N8N_API_KEY", "Chưa cấu hình khóa truy cập n8n.")}`);
  const response = await fetch(`${base}/${path.replace(/^\//, "")}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(12_000)
  }).catch(() => { throw new AppError(502, "UPSTREAM_UNAVAILABLE", "Chưa kết nối được dịch vụ đơn hàng. Dữ liệu trên thiết bị vẫn được giữ."); });
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 409) throw new AppError(409, "SHEET_REVISION_CONFLICT", "Dữ liệu Google Sheet đã thay đổi. Admin cần kiểm tra xung đột trước khi đồng bộ tiếp.");
    throw new AppError(502, "UPSTREAM_ERROR", `Dịch vụ đơn hàng trả về lỗi ${response.status}. Có thể thử đồng bộ lại.`);
  }
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new AppError(502, "UPSTREAM_INVALID_RESPONSE", "Dịch vụ đơn hàng trả dữ liệu không hợp lệ."); }
}

export function sheetId() {
  return requireEnv("N8N_SHEET_ID", "Chưa chọn Google Sheet cho môi trường này.");
}

export async function fetchSheetOrders({ cursor = "", limit = 100, modifiedSince = "" } = {}) {
  const params = new URLSearchParams({ sheet_id: sheetId(), limit: String(Math.max(1, Math.min(500, limit))) });
  if (cursor) params.set("cursor", cursor);
  if (modifiedSince) params.set("since", modifiedSince);
  const response = await n8nRequest(`shipping-orders?${params}`);
  return { rows: Array.isArray(response) ? response : Array.isArray(response.data) ? response.data : [], nextCursor: response.nextCursor || null };
}

export async function fetchSheetOrder(code) {
  const response = await n8nRequest(`shipping-order?${new URLSearchParams({ sheet_id: sheetId(), code })}`);
  return response.data && !Array.isArray(response.data) ? response.data : response;
}

export async function pushSheetOrder(body, idempotencyKey) {
  const result = await n8nRequest("shipping-order", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ ...body, operation_id: idempotencyKey })
  });
  if (result.status === "conflict") throw new AppError(409, "SHEET_REVISION_CONFLICT", "Dữ liệu Google Sheet đã thay đổi. Admin cần kiểm tra xung đột trước khi đồng bộ tiếp.");
  if (result.status !== "ok" || !Number.isSafeInteger(Number(result.revision))) throw new AppError(502, "UPSTREAM_INVALID_RESPONSE", "Google Sheet chưa xác nhận nội dung cập nhật.");
  return result;
}
