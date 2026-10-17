import { AppError, recordApiCall, requireEnv } from "./core.mjs";
import { withAdvisoryLock } from "./db.mjs";
import { sheetOrderMatchesPayload } from "./sync.mjs";

const N8N_QUEUE_LOCK = 772_024_102;
const N8N_REQUEST_INTERVAL_MS = 1_100;
const N8N_QUEUE_WAIT_MS = 20_000;
const sleep = duration => new Promise(resolve => setTimeout(resolve, duration));
let localQueue = Promise.resolve();
let localLastRequestAt = 0;
let localQueueDepth = 0;

async function waitForN8nSlot(client) {
  if (!client) {
    const waitMs = Math.max(0, N8N_REQUEST_INTERVAL_MS - (Date.now() - localLastRequestAt));
    if (waitMs) await sleep(waitMs);
    localLastRequestAt = Date.now();
    return;
  }
  const rows = await client.query(`SELECT GREATEST(0, CEIL(${N8N_REQUEST_INTERVAL_MS} - EXTRACT(EPOCH FROM (clock_timestamp() - updated_at)) * 1000))::int AS wait_ms
    FROM mealfit_sync_meta WHERE key = 'n8n-last-request'`);
  if (rows.rows[0]?.wait_ms > 0) await sleep(Number(rows.rows[0].wait_ms));
  await client.query(`INSERT INTO mealfit_sync_meta (key, value, updated_at) VALUES ('n8n-last-request', '{}'::jsonb, clock_timestamp())
    ON CONFLICT (key) DO UPDATE SET updated_at = EXCLUDED.updated_at`);
}

async function withN8nQueue(work) {
  if (process.env.VERCEL_ENV || process.env.VERCEL) {
    try {
      return await withAdvisoryLock(N8N_QUEUE_LOCK, client => work(() => waitForN8nSlot(client)), N8N_QUEUE_WAIT_MS);
    } catch (error) {
      if (error?.code !== "55P03") throw error;
      const busy = new AppError(503, "N8N_QUEUE_BUSY", "Dịch vụ đang xử lý nhiều yêu cầu. Vui lòng đợi 5 giây rồi thử lại.");
      busy.retryAfterSeconds = 5;
      throw busy;
    }
  }
  if (localQueueDepth >= 50) {
    const busy = new AppError(503, "N8N_QUEUE_BUSY", "Hàng đợi đồng bộ đang đầy. Vui lòng đợi 5 giây rồi thử lại.");
    busy.retryAfterSeconds = 5;
    throw busy;
  }
  localQueueDepth++;
  const queued = localQueue.then(async () => {
    try { return await work(() => waitForN8nSlot(null)); }
    finally { localQueueDepth--; }
  });
  localQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

function retryAfterMs(response) {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

export async function n8nRequest(path, options = {}) {
  const base = requireEnv("N8N_BASE_URL", "Kết nối Google Sheet chưa được cấu hình.").replace(/\/$/, "");
  const method = options.method || "GET";
  const route = path.replace(/^\//, "").split("?", 1)[0];
  const startedAt = Date.now();
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  headers.set("authorization", `${requireEnv("N8N_API_KEY", "Chưa cấu hình khóa truy cập n8n.")}`);
  const canRetry = method === "GET" || headers.has("idempotency-key");
  const maxAttempts = canRetry ? 3 : 1;
  return withN8nQueue(async waitForSlot => {
    let lastResponse;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await waitForSlot();
      let response;
      try {
        response = await fetch(`${base}/${path.replace(/^\//, "")}`, {
          ...options,
          headers,
          signal: AbortSignal.timeout(12_000)
        });
      } catch (cause) {
        if (canRetry && attempt + 1 < maxAttempts) { await sleep(500 * (2 ** attempt)); continue; }
        recordApiCall({ entityId: `n8n:${route}`, operation: `${method} network-error`, detail: { source: "n8n", durationMs: Date.now() - startedAt, errorCode: "UPSTREAM_UNAVAILABLE", errorMessage: String(cause?.message || "").slice(0, 300) || null, causeCode: cause?.cause?.code || cause?.code || null } });
        const error = new AppError(502, "UPSTREAM_UNAVAILABLE", "Chưa kết nối được dịch vụ đơn hàng. Dữ liệu trên thiết bị vẫn được giữ.");
        error.cause = cause;
        error.retryAfterSeconds = 5;
        throw error;
      }
      lastResponse = response;
      const text = await response.text();
      const waitMs = retryAfterMs(response);
      if (!response.ok && canRetry && attempt + 1 < maxAttempts && [429, 502, 503, 504].includes(response.status) && waitMs <= 10_000) {
        await sleep(Math.max(waitMs, 500 * (2 ** attempt)));
        continue;
      }
      if (!response.ok) {
        recordApiCall({ entityId: `n8n:${route}`, operation: `${method} ${response.status}`, detail: { source: "n8n", status: response.status, durationMs: Date.now() - startedAt, errorCode: response.status === 401 || response.status === 403 ? "UPSTREAM_AUTH" : response.status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_ERROR" } });
        if (response.status === 409) throw new AppError(409, "SHEET_REVISION_CONFLICT", "Dữ liệu Google Sheet đã thay đổi. Admin cần kiểm tra xung đột trước khi đồng bộ tiếp.");
        const message = response.status === 401 || response.status === 403
          ? `Webhook n8n từ chối xác thực (HTTP ${response.status}). Kiểm tra khóa và header xác thực của webhook.`
          : response.status === 429
            ? "Webhook n8n đang giới hạn yêu cầu. Vui lòng chờ trước khi thử lại."
            : `Dịch vụ đơn hàng trả về lỗi ${response.status}. Có thể thử đồng bộ lại.`;
        const error = new AppError(response.status === 429 ? 429 : 502, response.status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_ERROR", message);
        error.upstreamStatus = response.status;
        error.retryAfterSeconds = waitMs > 0 ? Math.ceil(waitMs / 1000) : canRetry && [502, 503, 504].includes(response.status) ? 5 : 0;
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
    throw new AppError(502, "UPSTREAM_ERROR", `Webhook n8n ${lastResponse?.status || "không phản hồi"}.`);
  });
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
  let response = await n8nRequest(`shipping-orders?${params}`);
  if (typeof response === "string") {
    try { response = JSON.parse(response); }
    catch { throw new AppError(502, "UPSTREAM_INVALID_RESPONSE", "Webhook danh sách đơn không trả về JSON hợp lệ."); }
  }
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
  if (result.status === "ok" && Number.isSafeInteger(Number(result.revision))) return result;
  let row = result;
  if (typeof row === "string") {
    try { row = JSON.parse(row); } catch {}
  }
  if (Array.isArray(row)) row = row[0];
  if (row?.data && typeof row.data === "object") row = Array.isArray(row.data) ? row.data[0] : row.data;
  const revision = Number(row?.revision ?? row?.Revision);
  if (!sheetOrderMatchesPayload(row, body) || !Number.isSafeInteger(revision) || revision <= Number(body.expected_revision)) {
    throw new AppError(502, "UPSTREAM_INVALID_RESPONSE", "Google Sheet chưa xác nhận nội dung và phiên bản cập nhật.");
  }
  return { status: "ok", revision };
}
