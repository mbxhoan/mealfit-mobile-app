import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { waitUntil } from "@vercel/functions";

const requestLogs = new AsyncLocalStorage();

export function recordApiCall(entry) {
  const context = requestLogs.getStore();
  if (context) context.entries.push({ ...entry, actorId: entry.actorId || context.actorId || "system" });
}

export function setApiActor(actorId) {
  const context = requestLogs.getStore();
  if (context) context.actorId = actorId;
}

function persistApiCalls(entries) {
  if (!entries.length || (!process.env.VERCEL && !process.env.VERCEL_ENV)) return;
  const rows = entries.map(entry => ({
    actor_id: entry.actorId || "system",
    entity_id: String(entry.entityId || "").slice(0, 200),
    operation: String(entry.operation || "").slice(0, 120),
    operation_id: entry.operationId || null,
    detail: entry.detail || {}
  }));
  const task = import("./db.mjs").then(({ getSql }) => getSql()`INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, operation_id, detail)
    SELECT actor_id, 'api', entity_id, operation, operation_id, detail
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(actor_id text, entity_id text, operation text, operation_id text, detail jsonb)`)
    .catch(error => console.error(JSON.stringify({ code: "API_LOG_WRITE_FAILED", name: error?.name || "Error" })));
  try { waitUntil(task); }
  catch { void task; }
}

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

export function handler(fn) {
  return async (req, res) => {
    const traceId = randomUUID();
    const startedAt = Date.now();
    const pathname = String(req.url || "/").split("?", 1)[0];
    const logContext = { entries: [] };
    let responseStatus = 200;
    let failure = null;
    let logged = false;
    const writeHead = res.writeHead.bind(res);
    const end = res.end.bind(res);
    const scheduleLog = () => {
      if (logged || pathname === "/api/ping" || (pathname === "/api/diagnostics" && String(req.url).includes("view=logs"))) return;
      logged = true;
      const cause = failure?.cause?.sourceError?.cause || failure?.cause?.sourceError || failure?.cause;
      logContext.entries.push({
        actorId: req.mealfitUser?.id || "system",
        entityId: pathname.slice(0, 200),
        operation: `${req.method || "GET"} ${responseStatus}`,
        operationId: traceId,
        detail: {
          source: "app",
          status: responseStatus,
          durationMs: Date.now() - startedAt,
          errorCode: failure?.code || (failure ? "INTERNAL" : null),
          errorMessage: String(cause?.message || failure?.message || "").slice(0, 500) || null,
          causeCode: cause?.code || null,
          ...(req.apiLogDetail || {})
        }
      });
      persistApiCalls(logContext.entries);
    };
    res.writeHead = (status, ...args) => {
      responseStatus = status;
      return writeHead(status, ...args);
    };
    res.end = (...args) => { scheduleLog(); return end(...args); };
    try {
      await requestLogs.run(logContext, () => fn(req, res, traceId));
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      const message = error instanceof AppError ? error.message : "Hệ thống đang bận. Dữ liệu đã giữ trên thiết bị; vui lòng thử lại.";
      responseStatus = status;
      failure = error;
      const cause = error?.cause?.sourceError?.cause || error?.cause?.sourceError || error?.cause;
      console.error(JSON.stringify({ traceId, path: pathname, code: error?.code || "INTERNAL", name: error?.name || "Error", causeCode: cause?.code || null, causeMessage: String(cause?.message || "").slice(0, 300) || null }));
      if (!res.headersSent) send(res, status, { error: { code: error?.code || "INTERNAL", message, traceId } }, Number(error?.retryAfterSeconds) > 0 ? { "retry-after": String(Math.ceil(error.retryAfterSeconds)) } : {});
      else res.end();
    } finally {
      scheduleLog();
      res.writeHead = writeHead;
      res.end = end;
    }
  };
}

export function requireMethod(req, ...methods) {
  if (!methods.includes(req.method)) throw new AppError(405, "METHOD_NOT_ALLOWED", "Thao tác này không được hỗ trợ.");
}

export function requireEnv(name, message = `Thiếu cấu hình ${name}.`) {
  const value = process.env[name];
  if (!value) throw new AppError(503, "CONFIGURATION", message);
  return value;
}

export function readJson(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new AppError(413, "BODY_TOO_LARGE", "Yêu cầu vượt quá dung lượng cho phép."));
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new AppError(400, "INVALID_JSON", "Dữ liệu gửi lên không hợp lệ.")); }
    });
    req.on("error", reject);
  });
}

export function jsonErrorMessage(error) {
  return error?.error?.message || error?.message || "Không thể hoàn tất thao tác.";
}
