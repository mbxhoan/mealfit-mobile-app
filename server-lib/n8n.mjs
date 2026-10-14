import { AppError, recordApiCall, requireEnv } from "./core.mjs";

export async function n8nRequest(path, options = {}) {
  const base = requireEnv("N8N_BASE_URL", "Kết nối Google Sheet chưa được cấu hình.").replace(/\/$/, "");
  const method = options.method || "GET";
  const route = path.replace(/^\//, "").split("?", 1)[0];
  const startedAt = Date.now();
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  headers.set("authorization", `${requireEnv("N8N_API_KEY", "Chưa cấu hình khóa truy cập n8n.")}`);
  const response = await fetch(`${base}/${path.replace(/^\//, "")}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(12_000)
  }).catch(cause => {
    recordApiCall({ entityId: `n8n:${route}`, operation: `${method} network-error`, detail: { source: "n8n", durationMs: Date.now() - startedAt, errorCode: "UPSTREAM_UNAVAILABLE", errorMessage: String(cause?.message || "").slice(0, 300) || null, causeCode: cause?.cause?.code || cause?.code || null } });
    const error = new AppError(502, "UPSTREAM_UNAVAILABLE", "Chưa kết nối được dịch vụ đơn hàng. Dữ liệu trên thiết bị vẫn được giữ.");
    error.cause = cause;
    throw error;
  });
  const text = await response.text();
  if (!response.ok) {
    recordApiCall({ entityId: `n8n:${route}`, operation: `${method} ${response.status}`, detail: { source: "n8n", status: response.status, durationMs: Date.now() - startedAt, errorCode: response.status === 401 || response.status === 403 ? "UPSTREAM_AUTH" : "UPSTREAM_ERROR" } });
    if (response.status === 409) throw new AppError(409, "SHEET_REVISION_CONFLICT", "Dữ liệu Google Sheet đã thay đổi. Admin cần kiểm tra xung đột trước khi đồng bộ tiếp.");
    const error = new AppError(502, "UPSTREAM_ERROR", response.status === 401 || response.status === 403
      ? `Webhook n8n từ chối xác thực (HTTP ${response.status}). Kiểm tra khóa và header xác thực của webhook.`
      : `Dịch vụ đơn hàng trả về lỗi ${response.status}. Có thể thử đồng bộ lại.`);
    error.upstreamStatus = response.status;
    throw error;
  }
  if (!text) {
    recordApiCall({ entityId: `n8n:${route}`, operation: `${method} ${response.status}`, detail: { source: "n8n", status: response.status, durationMs: Date.now() - startedAt, rowCount: 0 } });
    return {};
  }
  try {
    const result = JSON.parse(text);
    const rowCount = Array.isArray(result) ? result.length : Array.isArray(result?.data) ? result.data.length : null;
    recordApiCall({ entityId: `n8n:${route}`, operation: `${method} ${response.status}`, detail: { source: "n8n", status: response.status, durationMs: Date.now() - startedAt, rowCount } });
    return result;
  } catch (error) {
    if (error instanceof SyntaxError) {
      recordApiCall({ entityId: `n8n:${route}`, operation: `${method} ${response.status}`, detail: { source: "n8n", status: response.status, durationMs: Date.now() - startedAt, errorCode: "UPSTREAM_INVALID_RESPONSE" } });
      throw new AppError(502, "UPSTREAM_INVALID_RESPONSE", "Dịch vụ đơn hàng trả dữ liệu không hợp lệ.");
    }
    throw error;
  }
}

export function sheetId() {
  return requireEnv("N8N_SHEET_ID", "Chưa chọn Google Sheet cho môi trường này.");
}

export async function fetchSheetOrders({ cursor = "", limit = 100, modifiedSince = "" } = {}) {
  const params = new URLSearchParams({ sheet_id: sheetId(), limit: String(Math.max(1, Math.min(500, limit))) });
  if (cursor) params.set("cursor", cursor);
  if (modifiedSince) params.set("since", modifiedSince);
  const response = await n8nRequest(`shipping-orders?${params}`);
  if (Array.isArray(response)) return { rows: response, nextCursor: null };
  if (Array.isArray(response?.data)) return { rows: response.data, nextCursor: response.nextCursor || null };
  throw new AppError(502, "UPSTREAM_INVALID_RESPONSE", "Webhook danh sách đơn không trả về mảng data.");
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
