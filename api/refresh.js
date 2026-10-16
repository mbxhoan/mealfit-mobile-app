import { put } from "@vercel/blob";
import { waitUntil } from "@vercel/functions";
import { handler, readJson, requireMethod, send, AppError } from "../server-lib/core.mjs";
import { assertSameOrigin, requireUser } from "../server-lib/auth.mjs";
import { sheetShipperNames } from "../server-lib/accounts.mjs";
import { getSql } from "../server-lib/db.mjs";
import { fetchSheetOrders, fetchSheetOrdersForShippers } from "../server-lib/n8n.mjs";
import { importSheetOrders, markSheetPull, sheetUpdateMismatches } from "../server-lib/sync.mjs";
import { flushUpstream, reconcileUpstreamWithSheet } from "../server-lib/upstream.mjs";

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
  const previousPullAt = meta[0]?.updated_at ? new Date(meta[0].updated_at).toISOString() : null;
  const hasSnapshot = user.role !== "shipper"
    || Boolean((await sql`SELECT 1 FROM mealfit_sync_meta WHERE key = ${`shipper-order-snapshot:${user.id}`} LIMIT 1`).length);
  const recent = body.force !== true && hasSnapshot && meta[0] && Date.now() - new Date(meta[0].updated_at).valueOf() < 15_000;
  let count = 0;
  let received = 0;
  let pages = 0;
  let usedCache = false;
  let pendingCount = 0;
  let conflictCount = 0;
  let stage = "outbox-drain";
  try {
    await acquireUserRefreshSlot(sql, user.id);
    const unverifiedPush = recent ? await sql`SELECT 1 FROM mealfit_upstream_outbox AS outbox
      JOIN mealfit_operations AS operation ON operation.operation_id = outbox.operation_id AND operation.entity_type = 'order'
      WHERE outbox.status = 'sent' AND outbox.updated_at > ${previousPullAt}::timestamptz
        AND (${user.role !== "shipper"} OR operation.actor_id = ${user.id})
      LIMIT 1` : [];
    usedCache = Boolean(recent && !unverifiedPush.length);
    const pending = await sql`SELECT outbox.status, count(*)::int AS count, min(outbox.next_attempt_at) AS retry_at
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
    if (usedCache) {
      req.apiLogDetail = { stage: "cache", pending: pendingCount, conflicts: conflictCount };
      waitUntil(flushUpstream().catch(error => console.error(JSON.stringify({ code: "OUTBOX_RETRY", message: error.message }))));
      send(res, 200, { ok: true, refreshed: false, imported: 0, pendingUpstream: pendingCount, conflicts: conflictCount, message: "Dữ liệu vừa được đồng bộ." });
      return;
    }
    try {
      const shipperNames = user.role === "shipper" ? sheetShipperNames(user).filter(Boolean) : [""];
      if (user.role === "shipper" && !shipperNames.length) throw new AppError(400, "SHIPPER_NAME_REQUIRED", "Tài khoản shipper chưa có tên để lọc đơn hàng.");
      const previousPull = meta[0]?.updated_at ? new Date(new Date(meta[0].updated_at).valueOf() - 120_000).toISOString() : "";
      stage = "n8n-fetch";
      // Fetch each current or legacy shipper name so the webhook filters rows before pagination.
      const pull = await fetchSheetOrdersForShippers({ shippers: shipperNames, limit: 500, modifiedSince: user.role === "shipper" ? "" : previousPull });
      const allowedShippers = user.role === "shipper"
        ? new Set(shipperNames.map(name => name.trim().toLocaleLowerCase("vi-VN")))
        : null;
      const rows = allowedShippers
        ? pull.rows.filter(row => allowedShippers.has(String(row?.Shipper || "").trim().toLocaleLowerCase("vi-VN")))
        : pull.rows;
      received = rows.length;
      pages = pull.pages;
      if (body.force === true) {
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
      }
      stage = "sheet-verification";
      const sentUpdates = await sql`SELECT DISTINCT ON (outbox.order_code)
          outbox.order_code, outbox.request_body, outbox.target_revision
        FROM mealfit_upstream_outbox AS outbox
        JOIN mealfit_operations AS operation ON operation.operation_id = outbox.operation_id AND operation.entity_type = 'order'
        WHERE outbox.status = 'sent'
          AND (${previousPullAt === null} OR outbox.updated_at > ${previousPullAt}::timestamptz)
          AND (${user.role !== "shipper"} OR operation.actor_id = ${user.id})
        ORDER BY outbox.order_code, outbox.target_revision DESC, outbox.updated_at DESC`;
      const mismatches = sheetUpdateMismatches(sentUpdates, rows);
      if (mismatches.length) {
        req.apiLogDetail = { stage, mismatches: mismatches.length, codes: mismatches.slice(0, 5) };
        throw new AppError(502, "SHEET_CONFIRMATION_MISMATCH", `Google Sheet chưa xác nhận phiên bản hoặc trạng thái mới cho ${mismatches.slice(0, 5).join(", ")}. Vui lòng thử đồng bộ lại.`);
      }
      stage = "postgres-import";
      count = await importSheetOrders(rows, { allowOutboxConflicts: body.force === true, allowOpenConflicts: body.force === true });
      if (user.role === "shipper") {
        const codes = [...new Set(rows.map(row => String(row?.["Mã đơn"] || row?.code || "").trim()).filter(Boolean))];
        await sql`INSERT INTO mealfit_sync_meta (key, value, updated_at)
          VALUES (${`shipper-order-snapshot:${user.id}`}, ${JSON.stringify({ codes })}::jsonb, now())
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
    const wrapped = new AppError(503, "UPSTREAM_SYNC_FAILED", "Không thể xác nhận các cập nhật đang chờ trước khi tải danh sách.");
    wrapped.cause = error;
    throw wrapped;
  }
  req.apiLogDetail = { stage: usedCache ? "cache" : "complete", received, imported: count, pages, pendingUpstream: pendingCount, conflicts: conflictCount };
  waitUntil(flushUpstream().catch(error => console.error(JSON.stringify({ code: "OUTBOX_RETRY", message: error.message }))));
  send(res, 200, { ok: true, refreshed: !usedCache, imported: count, pendingUpstream: pendingCount, conflicts: conflictCount, message: usedCache ? "Dữ liệu vừa được đồng bộ." : "Đã cập nhật từ Google Sheet." });
});
