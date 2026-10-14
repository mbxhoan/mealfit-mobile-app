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

const sheetCell = (value, limit) => {
  const text = String(value ?? "").slice(0, limit);
  return /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
};

export function appLogPayload(input, user, id = sheetId()) {
  if (!input || !["info", "error"].includes(input.type)) throw new AppError(400, "INVALID_LOG_TYPE", "Loại log chỉ được là info hoặc error.");
  const source = input.details && typeof input.details === "object" && !Array.isArray(input.details) ? input.details : {};
  const details = {};
  if (Number.isInteger(source.status) && source.status >= 0 && source.status <= 599) details.status = source.status;
  if (Number.isFinite(source.durationMs) && source.durationMs >= 0) details.durationMs = Math.round(source.durationMs);
  if (typeof source.errorCode === "string") details.errorCode = source.errorCode.slice(0, 80);
  return {
    sheet_id: id,
    sheet_name: "app_logs",
    user: sheetCell(user?.name || user?.id || "unknown", 100),
    api: sheetCell(input.api || "app", 120),
    description: sheetCell(input.description || "Hoạt động ứng dụng", 240),
    type: input.type,
    other: JSON.stringify(details)
  };
}

export async function pushAppLog(input, user) {
  const body = appLogPayload(input, user);
  return n8nRequest("log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

export async function fetchSheetOrders({ cursor = "", limit = 100, modifiedSince = "", shipper = "" } = {}) {
  const params = new URLSearchParams({ sheet_id: sheetId(), limit: String(Math.max(1, Math.min(500, limit))) });
  if (cursor) params.set("cursor", cursor);
  if (modifiedSince) params.set("since", modifiedSince);
  if (shipper.trim()) params.set("shipper", shipper.trim());
  const response = await n8nRequest(`shipping-orders?${params}`);
  if (Array.isArray(response)) return { rows: response, nextCursor: null };
  if (Array.isArray(response?.data)) return { rows: response.data, nextCursor: response.nextCursor || null };
  throw new AppError(502, "UPSTREAM_INVALID_RESPONSE", "Webhook danh sách đơn không trả về mảng data.");
}

export async function fetchSheetOrdersForShippers({ shippers = [""], limit = 500, modifiedSince = "" } = {}) {
  const rows = new Map();
  let received = 0;
  let pages = 0;
  for (const shipper of shippers.length ? shippers : [""]) {
    let cursor = "";
    let complete = false;
    for (let page = 0; page < 100; page++) {
      pages++;
      const result = await fetchSheetOrders({ cursor, limit, modifiedSince, shipper });
      received += result.rows.length;
      for (const row of result.rows) {
        const code = String(row?.["Mã đơn"] || row?.code || "").trim();
        if (code && !rows.has(code)) rows.set(code, row);
      }
      if (!result.nextCursor) { complete = true; break; }
      cursor = result.nextCursor;
    }
    if (!complete) throw new AppError(413, "SHEET_PAGE_LIMIT", "Có quá nhiều đơn thay đổi trong một lần đồng bộ. Vui lòng thử lại.");
  }
  return { rows: [...rows.values()], received, pages };
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
