import { waitUntil } from "@vercel/functions";
import { handler, readJson, requireMethod, send, AppError } from "./lib/core.mjs";
import { assertSameOrigin, requireUser } from "./lib/auth.mjs";
import { getSql } from "./lib/db.mjs";
import { fetchSheetOrders } from "./lib/n8n.mjs";
import { importSheetOrders, markSheetPull } from "./lib/sync.mjs";
import { flushUpstream } from "./lib/upstream.mjs";

export default handler(async (req, res) => {
  requireMethod(req, "POST");
  assertSameOrigin(req);
  requireUser(req);
  const body = await readJson(req);
  const sql = getSql();
  const meta = await sql`SELECT updated_at FROM mealfit_sync_meta WHERE key = 'last-sheet-pull' LIMIT 1`;
  const recent = body.force !== true && meta[0] && Date.now() - new Date(meta[0].updated_at).valueOf() < 15_000;
  let count = 0;
  if (!recent) {
    try {
      const previousPull = meta[0]?.updated_at ? new Date(new Date(meta[0].updated_at).valueOf() - 120_000).toISOString() : "";
      let cursor = "";
      let complete = false;
      for (let page = 0; page < 100; page++) {
        const result = await fetchSheetOrders({ cursor, limit: 500, modifiedSince: previousPull });
        count += await importSheetOrders(result.rows);
        if (!result.nextCursor) { complete = true; break; }
        cursor = result.nextCursor;
      }
      if (!complete) throw new AppError(413, "SHEET_PAGE_LIMIT", "Có quá nhiều đơn thay đổi trong một lần đồng bộ. Vui lòng thử lại.");
      await markSheetPull(count);
    } catch (error) { throw error instanceof AppError ? error : new AppError(502, "SHEET_UNAVAILABLE", "Không thể đồng bộ đơn từ Google Sheet."); }
  }
  waitUntil(flushUpstream().catch(error => console.error(JSON.stringify({ code: "OUTBOX_RETRY", message: error.message }))));
  send(res, 200, { ok: true, refreshed: !recent, imported: count, message: recent ? "Dữ liệu vừa được đồng bộ." : "Đã cập nhật từ Google Sheet." });
});
