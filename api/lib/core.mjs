import { randomUUID } from "node:crypto";

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
    try {
      await fn(req, res, traceId);
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      const message = error instanceof AppError ? error.message : "Hệ thống đang bận. Dữ liệu đã giữ trên thiết bị; vui lòng thử lại.";
      console.error(JSON.stringify({ traceId, code: error?.code || "INTERNAL", name: error?.name || "Error" }));
      if (!res.headersSent) send(res, status, { error: { code: error?.code || "INTERNAL", message, traceId } });
      else res.end();
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
