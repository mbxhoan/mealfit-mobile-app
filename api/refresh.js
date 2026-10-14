import { waitUntil } from "@vercel/functions";
import { put } from "@vercel/blob";
import { handler, readJson, requireMethod, send, AppError } from "../server-lib/core.mjs";
import { assertSameOrigin, requireUser } from "../server-lib/auth.mjs";
import { getSql } from "../server-lib/db.mjs";
import { fetchSheetOrders } from "../server-lib/n8n.mjs";
import { importSheetOrders, markSheetPull } from "../server-lib/sync.mjs";
import { flushUpstream } from "../server-lib/upstream.mjs";

const TABLES = ["mealfit_orders", "mealfit_sessions", "mealfit_operations", "mealfit_payment_events", "mealfit_upstream_outbox", "mealfit_media", "mealfit_conflicts", "mealfit_audit_log", "mealfit_auth_attempts", "mealfit_sync_meta"];

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
  requireUser(req);
  const body = await readJson(req);
  const sql = getSql();
  const meta = await sql`SELECT updated_at FROM mealfit_sync_meta WHERE key = 'last-sheet-pull' LIMIT 1`;
  const recent = body.force !== true && meta[0] && Date.now() - new Date(meta[0].updated_at).valueOf() < 15_000;
  let count = 0;
  let received = 0;
  let pages = 0;
  let stage = recent ? "cache" : "n8n-fetch";
  if (!recent) {
    try {
      const previousPull = meta[0]?.updated_at ? new Date(new Date(meta[0].updated_at).valueOf() - 120_000).toISOString() : "";
      let cursor = "";
      let complete = false;
      for (let page = 0; page < 100; page++) {
        pages++;
        const result = await fetchSheetOrders({ cursor, limit: 500, modifiedSince: previousPull });
        received += result.rows.length;
        stage = "postgres-import";
        count += await importSheetOrders(result.rows);
        stage = "n8n-fetch";
        if (!result.nextCursor) { complete = true; break; }
        cursor = result.nextCursor;
      }
      if (!complete) throw new AppError(413, "SHEET_PAGE_LIMIT", "Có quá nhiều đơn thay đổi trong một lần đồng bộ. Vui lòng thử lại.");
      stage = "sync-checkpoint";
      await markSheetPull(count);
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
