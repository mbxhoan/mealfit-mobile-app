import { put } from "@vercel/blob";
import { handler, readJson, requireMethod, send, AppError } from "../server-lib/core.mjs";
import { assertSameOrigin, requireUser } from "../server-lib/auth.mjs";
import { sheetShipperNames } from "../server-lib/accounts.mjs";
import { getSql } from "../server-lib/db.mjs";
import { fetchSheetOrders, fetchSheetOrdersForShippers } from "../server-lib/n8n.mjs";
import { importSheetOrders, markSheetPull, sheetUpdateMismatches } from "../server-lib/sync.mjs";
import { flushUpstream, reconcileUpstreamWithSheet } from "../server-lib/upstream.mjs";

const TABLES = ["mealfit_accounts", "mealfit_orders", "mealfit_sessions", "mealfit_operations", "mealfit_payment_events", "mealfit_upstream_outbox", "mealfit_media", "mealfit_conflicts", "mealfit_audit_log", "mealfit_auth_attempts", "mealfit_sync_meta"];

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
  await readJson(req);
  const sql = getSql();
  const syncKey = user.role === "shipper" ? `last-sheet-pull:${user.id}` : "last-sheet-pull";
  const meta = await sql`SELECT updated_at FROM mealfit_sync_meta WHERE key = ${syncKey} LIMIT 1`;
  const previousPullAt = meta[0]?.updated_at ? new Date(meta[0].updated_at).toISOString() : null;
  let count = 0;
  let received = 0;
  let pages = 0;
  let pendingCount = 0;
  let conflictCount = 0;
  let stage = "n8n-fetch";
  try {
    const pending = await sql`SELECT outbox.status, count(*)::int AS count
      FROM mealfit_upstream_outbox AS outbox
      WHERE outbox.status IN ('queued', 'sending', 'failed', 'conflict')
        AND (${user.role !== "shipper"} OR EXISTS (
          SELECT 1 FROM mealfit_operations AS operation
          WHERE operation.operation_id = outbox.operation_id AND operation.actor_id = ${user.id}
        ) OR EXISTS (
          SELECT 1 FROM mealfit_orders AS order_row
          WHERE order_row.code = outbox.order_code AND order_row.assigned_user_id = ${user.id}
        ))
      GROUP BY outbox.status`;
    pendingCount = pending.filter(row => row.status !== "conflict").reduce((sum, row) => sum + Number(row.count), 0);
    conflictCount = pending.filter(row => row.status === "conflict").reduce((sum, row) => sum + Number(row.count), 0);
    try {
      const shipperNames = user.role === "shipper" ? sheetShipperNames(user).filter(Boolean) : [""];
      if (user.role === "shipper" && !shipperNames.length) throw new AppError(400, "SHIPPER_NAME_REQUIRED", "Tài khoản shipper chưa có tên để lọc đơn hàng.");
      stage = "n8n-fetch";
      // Fetch each current or legacy shipper name so the webhook filters rows before pagination.
      const verificationCutoff = new Date().toISOString();
      const pull = await fetchSheetOrdersForShippers({ shippers: shipperNames, limit: 500 });
      const allowedShippers = user.role === "shipper"
        ? new Set(shipperNames.map(name => name.trim().toLocaleLowerCase("vi-VN")))
        : null;
      const rows = allowedShippers
        ? pull.rows.filter(row => allowedShippers.has(String(row?.Shipper || "").trim().toLocaleLowerCase("vi-VN")))
        : pull.rows;
      received = rows.length;
      pages = pull.pages;
      await reconcileUpstreamWithSheet(rows);
      const reconciledPending = await sql`SELECT outbox.status, count(*)::int AS count
          FROM mealfit_upstream_outbox AS outbox
          WHERE outbox.status IN ('queued', 'sending', 'failed', 'conflict')
            AND (${user.role !== "shipper"} OR EXISTS (
              SELECT 1 FROM mealfit_operations AS operation
              WHERE operation.operation_id = outbox.operation_id AND operation.actor_id = ${user.id}
            ) OR EXISTS (
              SELECT 1 FROM mealfit_orders AS order_row
              WHERE order_row.code = outbox.order_code AND order_row.assigned_user_id = ${user.id}
            ))
          GROUP BY outbox.status`;
      pendingCount = reconciledPending.filter(row => row.status !== "conflict").reduce((sum, row) => sum + Number(row.count), 0);
      conflictCount = reconciledPending.filter(row => row.status === "conflict").reduce((sum, row) => sum + Number(row.count), 0);
      stage = "sheet-verification";
      const sentUpdates = await sql`SELECT DISTINCT ON (outbox.order_code)
          outbox.order_code, outbox.request_body, outbox.target_revision
        FROM mealfit_upstream_outbox AS outbox
        JOIN mealfit_operations AS operation ON operation.operation_id = outbox.operation_id AND operation.entity_type = 'order'
        WHERE outbox.status = 'sent'
          AND (${previousPullAt === null} OR outbox.updated_at > ${previousPullAt}::timestamptz)
          AND outbox.updated_at <= ${verificationCutoff}::timestamptz
          AND (${user.role !== "shipper"} OR operation.actor_id = ${user.id})
        ORDER BY outbox.order_code, outbox.target_revision DESC, outbox.updated_at DESC`;
      const mismatches = sheetUpdateMismatches(sentUpdates, rows);
      if (mismatches.length) {
        req.apiLogDetail = { stage, mismatches: mismatches.length, codes: mismatches.slice(0, 5) };
        await sql`UPDATE mealfit_upstream_outbox SET status = 'conflict', last_error = 'SHEET_STATE_DIVERGED', updated_at = now()
          WHERE status = 'sent' AND order_code = ANY(${mismatches}::text[])`;
        await reconcileUpstreamWithSheet(rows);
      }
      stage = "postgres-import";
      count = await importSheetOrders(rows, { sheetAuthoritative: true });
      const sheetCodes = [...new Set(rows.map(row => String(row?.["Mã đơn"] || row?.code || "").trim()).filter(Boolean))];
      if (sheetCodes.length) {
        await sql`UPDATE mealfit_operations operation
          SET result = COALESCE(operation.result, '{}'::jsonb) || '{"conflict":true,"errorCode":"SHEET_SOURCE_WINS"}'::jsonb
          FROM mealfit_upstream_outbox outbox
          WHERE operation.operation_id = outbox.operation_id AND operation.entity_type = 'order'
            AND outbox.order_code = ANY(${sheetCodes}::text[]) AND outbox.status = 'conflict'`;
        await sql`UPDATE mealfit_upstream_outbox SET status = 'sent', last_error = NULL, updated_at = now()
          WHERE order_code = ANY(${sheetCodes}::text[]) AND status = 'conflict'`;
        await sql`UPDATE mealfit_conflicts SET status = 'resolved-sheet', resolved_by = ${user.id}, resolved_at = now()
          WHERE order_code = ANY(${sheetCodes}::text[]) AND status = 'open'`;
      }
      if (user.role === "shipper") {
        await sql`INSERT INTO mealfit_sync_meta (key, value, updated_at)
          VALUES (${`shipper-order-snapshot:${user.id}`}, ${JSON.stringify({ codes: sheetCodes })}::jsonb, now())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
      }
      stage = "sync-checkpoint";
      await markSheetPull(count, syncKey);
    } catch (error) {
      req.apiLogDetail ||= { stage, received, imported: count, pages };
      if (error instanceof AppError) throw error;
      const wrapped = new AppError(502, "SHEET_IMPORT_FAILED", "Không thể đồng bộ đơn từ Google Sheet.");
      wrapped.cause = error;
      throw wrapped;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const wrapped = new AppError(503, "UPSTREAM_SYNC_FAILED", "Không thể tải danh sách đơn từ webhook.");
    wrapped.cause = error;
    throw wrapped;
  }
  const currentPending = await sql`SELECT outbox.status, count(*)::int AS count
    FROM mealfit_upstream_outbox AS outbox
    WHERE outbox.status IN ('queued', 'sending', 'failed', 'conflict')
      AND (${user.role !== "shipper"} OR EXISTS (
        SELECT 1 FROM mealfit_operations AS operation
        WHERE operation.operation_id = outbox.operation_id AND operation.actor_id = ${user.id}
      ) OR EXISTS (
        SELECT 1 FROM mealfit_orders AS order_row
        WHERE order_row.code = outbox.order_code AND order_row.assigned_user_id = ${user.id}
      ))
    GROUP BY outbox.status`;
  pendingCount = currentPending.filter(row => row.status !== "conflict").reduce((sum, row) => sum + Number(row.count), 0);
  conflictCount = currentPending.filter(row => row.status === "conflict").reduce((sum, row) => sum + Number(row.count), 0);
  req.apiLogDetail = { stage: "complete", received, imported: count, pages, pendingUpstream: pendingCount, conflicts: conflictCount };
  send(res, 200, { ok: true, refreshed: true, imported: count, pendingUpstream: pendingCount, conflicts: conflictCount, message: "Đã cập nhật từ Google Sheet." });
});
