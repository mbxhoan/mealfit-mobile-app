import { put } from "@vercel/blob";
import { handler, requireMethod, send, AppError } from "../lib/core.mjs";
import { getSql } from "../lib/db.mjs";
import { fetchSheetOrders } from "../lib/n8n.mjs";
import { importSheetOrders, markSheetPull } from "../lib/sync.mjs";
import { flushUpstream } from "../lib/upstream.mjs";

const TABLES = ["mealfit_orders", "mealfit_sessions", "mealfit_operations", "mealfit_payment_events", "mealfit_upstream_outbox", "mealfit_media", "mealfit_conflicts", "mealfit_audit_log", "mealfit_auth_attempts", "mealfit_sync_meta"];

async function backupSnapshot() {
  const sql = getSql();
  const snapshot = { format: 1, createdAt: new Date().toISOString(), tables: {} };
  for (const table of TABLES) snapshot.tables[table] = await sql.unsafe(`SELECT * FROM ${table}`);
  const pathname = `mealfit-backups/${new Date().toISOString().slice(0, 10)}.json`;
  await put(pathname, JSON.stringify(snapshot), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
  return pathname;
}

export default handler(async (req, res) => {
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
  const backup = await backupSnapshot();
  send(res, 200, { ok: true, sync, backup });
});
