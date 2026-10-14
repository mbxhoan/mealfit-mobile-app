import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { AppError, requireEnv, setApiActor } from "./core.mjs";
import { getSql } from "./db.mjs";

if (process.env.VERCEL_ENV !== "production") {
  try { process.loadEnvFile(new URL("../../.env.local", import.meta.url)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

const COOKIE = "mealfit_session";
export const ACCOUNTS = {
  admin: { id: "admin", name: "Admin", role: "admin" },
  user: { id: "user", name: "Nhân viên", role: "user" },
  hieu: { id: "hieu", name: "Hiếu", role: "shipper" },
  hoan: { id: "hoan", name: "Hoàn", role: "shipper" },
  shipper: { id: "shipper", name: "Shipper", role: "shipper" }
};

const signature = payload => createHmac("sha256", requireEnv("SESSION_SECRET", "Phiên đăng nhập chưa được cấu hình.")).update(payload).digest("base64url");

function cookieValue(req) {
  const item = (req.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`));
  return item ? decodeURIComponent(item.slice(COOKIE.length + 1)) : "";
}

export function sessionCookie(userId, maxAge = 60 * 60 * 24 * 7) {
  const payload = `${userId}.${Math.floor(Date.now() / 1000) + maxAge}.${randomBytes(12).toString("base64url")}`;
  const secure = process.env.VERCEL ? "; Secure" : "";
  return `${COOKIE}=${encodeURIComponent(`${payload}.${signature(payload)}`)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export function expiredCookie() {
  const secure = process.env.VERCEL ? "; Secure" : "";
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

export function getSessionUser(req) {
  const value = cookieValue(req);
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const payload = parts.slice(0, 3).join(".");
  const [id, expires] = parts;
  if (!ACCOUNTS[id] || Number(expires) <= Date.now() / 1000) return null;
  const actual = Buffer.from(parts[3]);
  const expected = Buffer.from(signature(payload));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return ACCOUNTS[id];
}

export function requireUser(req) {
  const user = getSessionUser(req);
  if (!user) throw new AppError(401, "AUTH_REQUIRED", "Đăng nhập lại khi có kết nối mạng.");
  req.mealfitUser = user;
  setApiActor(user.id);
  return user;
}

export function verifyPin(pin) {
  if (!/^\d{4,6}$/.test(String(pin || ""))) return false;
  const encoded = process.env.MEALFIT_PIN_HASH || "";
  if (process.env.VERCEL_ENV === "production") {
    const configured = process.env.MEALFIT_PIN || "";
    if (configured) {
      if (!/^\d{6}$/.test(configured)) throw new AppError(503, "CONFIGURATION", "MEALFIT_PIN trong Production phải gồm 6 chữ số.");
      const salt = requireEnv("SESSION_SECRET");
      const actual = scryptSync(String(pin), salt, 32);
      const expected = scryptSync(configured, salt, 32);
      return timingSafeEqual(actual, expected);
    }
    const match = encoded.match(/^scrypt\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{40,})$/);
    if (!match) throw new AppError(503, "CONFIGURATION", "Chưa cấu hình MEALFIT_PIN gồm 6 chữ số trong Production.");
    const actual = scryptSync(String(pin), Buffer.from(match[1], "base64url"), 32);
    const expected = Buffer.from(match[2], "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  if (encoded) {
    const match = encoded.match(/^scrypt\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{40,})$/);
    if (!match) throw new AppError(503, "CONFIGURATION", "MEALFIT_PIN_HASH không hợp lệ.");
    const actual = scryptSync(String(pin), Buffer.from(match[1], "base64url"), 32);
    const expected = Buffer.from(match[2], "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  const configured = requireEnv("MEALFIT_PIN", "PIN đăng nhập chưa được cấu hình.");
  const salt = requireEnv("SESSION_SECRET");
  const expected = scryptSync(configured, salt, 32);
  const actual = scryptSync(String(pin), salt, 32);
  return timingSafeEqual(actual, expected);
}

export async function assertLoginRateLimit(req) {
  const sql = getSql();
  const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim().slice(0, 80);
  const rows = await sql`
    INSERT INTO mealfit_auth_attempts (ip_key, window_started_at, attempts)
    VALUES (${ip}, now(), 1)
    ON CONFLICT (ip_key) DO UPDATE SET
      attempts = CASE WHEN mealfit_auth_attempts.window_started_at < now() - interval '15 minutes' THEN 1 ELSE mealfit_auth_attempts.attempts + 1 END,
      window_started_at = CASE WHEN mealfit_auth_attempts.window_started_at < now() - interval '15 minutes' THEN now() ELSE mealfit_auth_attempts.window_started_at END
    RETURNING attempts
  `;
  if (Number(rows[0]?.attempts) > 10) throw new AppError(429, "LOGIN_RATE_LIMIT", "Thử đăng nhập quá nhiều lần. Vui lòng đợi 15 phút.");
  return ip;
}

export async function clearLoginRateLimit(ip) {
  await getSql()`DELETE FROM mealfit_auth_attempts WHERE ip_key = ${ip}`;
}

export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (new URL(origin).host !== host) throw new AppError(403, "ORIGIN_REJECTED", "Yêu cầu đến từ một nguồn không được phép.");
}
