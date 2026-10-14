import { waitUntil } from "@vercel/functions";
import { put } from "@vercel/blob";
import { handler, readJson, requireMethod, send, AppError } from "../server-lib/core.mjs";
import { assertSameOrigin, requireUser } from "../server-lib/auth.mjs";
import { sheetShipperNames } from "../server-lib/accounts.mjs";
import { getSql } from "../server-lib/db.mjs";
import { fetchSheetOrders, fetchSheetOrdersForShippers } from "../server-lib/n8n.mjs";
import { importSheetOrders, markSheetPull } from "../server-lib/sync.mjs";
import { flushUpstream } from "../server-lib/upstream.mjs";

const TABLES = ["mealfit_accounts", "mealfit_orders", "mealfit_sessions", "mealfit_operations", "mealfit_payment_events", "mealfit_upstream_outbox", "mealfit_media", "mealfit_conflicts", "mealfit_audit_log", "mealfit_auth_attempts", "mealfit_sync_meta"];
const REFRESH_COOLDOWN_MS = 10_000;

async function acquireUserRefreshSlot(sql, userId) {
  const key = `sheet-refresh:${userId}`;
  const allowed = await sql`INSERT INTO mealfit_sync_meta (key, value, updated_at)
    VALUES (${key}, '{}'::jsonb, clock_timestamp())
    ON CONFLICT (key) DO UPDATE SET updated_at = EXCLUDED.updated_at
    WHERE mealfit_sync_meta.updated_at <= EXCLUDED.updated_at - interval '10 seconds'
    RETURNING key`;
  if (allowed.length) return;
  const rows = await sql`SELECT updated_at FROM mealfit_sync_meta WHERE key = ${key} LIMIT 1`;
  const retryAfter = Math.max(1, Math.ceil((new Date(rows[0].updated_at).getTime() + REFRESH_COOLDOWN_MS - Date.now()) / 1000));
  const error = new AppError(429, "SYNC_COOLDOWN", `Đồng bộ vừa được thử. Vui lòng chờ ${retryAfter} giây rồi thử lại.`);
  error.retryAfterSeconds = retryAfter;
  throw error;
}

async function runMaintenance(req, res) {
  requireMethod(req, "GET", "POST");
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.authorization !== `Bearer ${expected}`) throw new AppError(401, "CRON_UNAUTHORIZED", "Không được phép chạy tác vụ nền.");
  const sync = { imported: 0, pushed: 0, error: null };
  try {
    const meta = await getSql()`SELECT updated_at FROM mealfit_sync_meta WHERE key = 'last-sheet-pull' LIMIT 1`;
    const modifiedSince = meta[0]?.updated_at ? new Date(new Date(meta[0].updated_at).valueOf() - 120_000).toISOString() : "";
    let cursor = "";
    let complete = false;
    for (let page = 0; page < 100; page++) {
      const result = await fetchSheetOrders({ cursor, limit: 500, modifiedSince });
      sync.imported += await importSheetOrders(result.rows);
      if (!result.nextCursor) { complete = true; break; }
      cursor = result.nextCursor;
    }
    if (!complete) throw new AppError(413, "SHEET_PAGE_LIMIT", "Vượt giới hạn phân trang đồng bộ.");
    await markSheetPull(sync.imported);
    sync.pushed = await flushUpstream();
  } catch (error) {
    sync.error = error?.code || "UPSTREAM_ERROR";
  }
  const snapshot = { format: 1, createdAt: new Date().toISOString(), tables: {} };
  const sql = getSql();
  for (const table of TABLES) snapshot.tables[table] = await sql.unsafe(`SELECT * FROM ${table}`);
  const pathname = `mealfit-backups/${new Date().toISOString().slice(0, 10)}.json`;
  await put(pathname, JSON.stringify(snapshot), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
  send(res, 200, { ok: true, sync, backup: pathname });
}

export default handler(async (req, res) => {
  if (req.method === "GET" || req.headers.authorization) {
    await runMaintenance(req, res);
    return;
  }
  requireMethod(req, "POST");
  assertSameOrigin(req);
  const user = await requireUser(req);
  const body = await readJson(req);
  const sql = getSql();
  const syncKey = user.role === "shipper" ? `last-sheet-pull:${user.id}` : "last-sheet-pull";
  const meta = await sql`SELECT updated_at FROM mealfit_sync_meta WHERE key = ${syncKey} LIMIT 1`;
  const recent = body.force !== true && meta[0] && Date.now() - new Date(meta[0].updated_at).valueOf() < 15_000;
  let count = 0;
  let received = 0;
  let pages = 0;
  let stage = recent ? "cache" : "n8n-fetch";
  if (!recent) {
    try {
      await acquireUserRefreshSlot(sql, user.id);
      const previousPull = meta[0]?.updated_at ? new Date(new Date(meta[0].updated_at).valueOf() - 120_000).toISOString() : "";
      const pull = await fetchSheetOrdersForShippers({ shippers: sheetShipperNames(user), limit: 500, modifiedSince: previousPull });
      received = pull.received;
      pages = pull.pages;
      stage = "postgres-import";
      count = await importSheetOrders(pull.rows);
      stage = "sync-checkpoint";
      await markSheetPull(count, syncKey);
    } catch (error) {
      req.apiLogDetail = { stage, received, imported: count, pages };
      if (error instanceof AppError) throw error;
      const wrapped = new AppError(502, "SHEET_IMPORT_FAILED", "Không thể đồng bộ đơn từ Google Sheet.");
      wrapped.cause = error;
      throw wrapped;
    }
  }
  req.apiLogDetail = { stage: recent ? "cache" : "complete", received, imported: count, pages };
  waitUntil(flushUpstream().catch(error => console.error(JSON.stringify({ code: "OUTBOX_RETRY", message: error.message }))));
  send(res, 200, { ok: true, refreshed: !recent, imported: count, message: recent ? "Dữ liệu vừa được đồng bộ." : "Đã cập nhật từ Google Sheet." });
});
