import { put } from "@vercel/blob";
import { handler, readJson, requireMethod, send, AppError } from "../server-lib/core.mjs";
import { assertSameOrigin, requireUser } from "../server-lib/auth.mjs";
import { sheetShipperNames } from "../server-lib/accounts.mjs";
import { getSql } from "../server-lib/db.mjs";
import { fetchSheetOrders, fetchSheetOrdersForShippers } from "../server-lib/n8n.mjs";
import { dbClock, importSheetOrders, markSheetPull } from "../server-lib/sync.mjs";
import { sheetText } from "../server-lib/orders.mjs";
import { flushUpstream } from "../server-lib/upstream.mjs";
import { reconcileAccounts } from "../server-lib/commands.mjs";

const MIN_PULL_INTERVAL_MS = 20_000;

// A Sheet import can finish or orphan a delivery session (e.g. an order delivered directly on the Sheet), so the
// invariants are repaired for the affected shipper accounts right after it. Never fails the sync itself.
async function repairSessions(ownerIds) {
  try { return (await reconcileAccounts(ownerIds)).filter(report => report.changed).length; }
  catch (error) { console.error(JSON.stringify({ code: "RECONCILE_FAILED", message: String(error?.message || "").slice(0, 200) })); return 0; }
}

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
      const fetchStartedAt = await dbClock();
      const result = await fetchSheetOrders({ cursor, limit: 500, modifiedSince });
      sync.imported += await importSheetOrders(result.rows, { fetchStartedAt });
      if (!result.nextCursor) { complete = true; break; }
      cursor = result.nextCursor;
    }
    if (!complete) throw new AppError(413, "SHEET_PAGE_LIMIT", "Vượt giới hạn phân trang đồng bộ.");
    await markSheetPull(sync.imported);
    sync.pushed = await flushUpstream();
    const shippers = await getSql()`SELECT id FROM mealfit_accounts WHERE role = 'shipper'`;
    sync.repaired = await repairSessions(shippers.map(row => row.id));
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
  const previousPullAt = meta[0]?.updated_at ? new Date(meta[0].updated_at).valueOf() : null;
  // n8n serialises every request at 2.5s, so a pull started right after another would only queue behind it.
  if (previousPullAt !== null && Date.now() - previousPullAt < MIN_PULL_INTERVAL_MS) {
    send(res, 200, { ok: true, refreshed: false, throttled: true, imported: 0, pendingUpstream: 0, conflicts: 0, resolvedSheetConflicts: 0, upstreamError: null, message: "Dữ liệu vừa được cập nhật từ Google Sheet." });
    return;
  }
  let count = 0;
  let received = 0;
  let pages = 0;
  let pendingCount = 0;
  let conflictCount = 0;
  let resolvedSheetConflicts = 0;
  let upstreamError = null;
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
      // Fetch current and legacy shipper names; verify missing delivered statuses against the unfiltered Sheet view.
      // The DB clock is read before the Sheet so that app writes landing during the fetch are never overwritten by it.
      const fetchStartedAt = await dbClock(sql);
      const pull = await fetchSheetOrdersForShippers({ shippers: shipperNames, limit: 500 });
      const allowedShippers = user.role === "shipper"
        ? new Set(shipperNames.map(name => sheetText(name).toLocaleLowerCase("vi-VN")))
        : null;
      let rows = allowedShippers
        ? pull.rows.filter(row => allowedShippers.has(sheetText(row?.Shipper ?? row?.shipper).toLocaleLowerCase("vi-VN")))
        : pull.rows;
      pages = pull.pages;
      const hasDeliveredOrder = values => values.some(row => sheetText(row?.["Trạng thái giao hàng"] ?? row?.shipping_status) === "Đã giao hàng");
      if (allowedShippers && !hasDeliveredOrder(rows)) {
        const completePull = await fetchSheetOrdersForShippers({ shippers: [""], limit: 500 });
        const completeRows = completePull.rows.filter(row => allowedShippers.has(sheetText(row?.Shipper ?? row?.shipper).toLocaleLowerCase("vi-VN")));
        if (hasDeliveredOrder(completeRows)) rows = completeRows;
        pages += completePull.pages;
      }
      received = rows.length;
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
      stage = "postgres-import";
      // Sheet wins for orders whose app change is already confirmed; orders with an unsent or just-sent change keep the app value.
      count = await importSheetOrders(rows, { sheetAuthoritative: true, fetchStartedAt });
      const owners = user.role === "shipper" ? [user.id] : (await sql`SELECT id FROM mealfit_accounts WHERE role = 'shipper'`).map(row => row.id);
      await repairSessions(owners);
      const sheetCodes = [...new Set(rows.map(row => String(row?.["Mã đơn"] || row?.code || "").trim()).filter(Boolean))];
      if (sheetCodes.length) {
        await sql`UPDATE mealfit_operations operation
          SET result = COALESCE(operation.result, '{}'::jsonb) || '{"conflict":true,"errorCode":"SHEET_SOURCE_WINS"}'::jsonb
          FROM mealfit_upstream_outbox outbox
          WHERE operation.operation_id = outbox.operation_id AND operation.entity_type = 'order'
            AND outbox.order_code = ANY(${sheetCodes}::text[]) AND outbox.status = 'conflict'`;
        const resolved = await sql`UPDATE mealfit_upstream_outbox SET status = 'sent', last_error = NULL, updated_at = now()
          WHERE order_code = ANY(${sheetCodes}::text[]) AND status = 'conflict' RETURNING operation_id`;
        resolvedSheetConflicts = resolved.length;
        await sql`UPDATE mealfit_conflicts SET status = 'resolved-sheet', resolved_by = ${user.id}, resolved_at = now()
          WHERE order_code = ANY(${sheetCodes}::text[]) AND status = 'open'`;
      }
      if (user.role === "shipper") {
        const previousSnapshot = await sql`SELECT value FROM mealfit_sync_meta WHERE key = ${`shipper-order-snapshot:${user.id}`} LIMIT 1`;
        const previousCodes = previousSnapshot[0]?.value?.codes || [];
        const stillOwned = previousCodes.length
          ? (await sql`SELECT code FROM mealfit_orders WHERE code = ANY(${previousCodes}::text[]) AND assigned_user_id = ${user.id}`).map(row => row.code)
          : [];
        const mergedCodes = [...new Set([...stillOwned, ...sheetCodes])];
        await sql`INSERT INTO mealfit_sync_meta (key, value, updated_at)
          VALUES (${`shipper-order-snapshot:${user.id}`}, ${JSON.stringify({ codes: mergedCodes })}::jsonb, now())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
      }
      stage = "sync-checkpoint";
      await markSheetPull(count, syncKey);
      stage = "push-outbox";
      try { await flushUpstream(50, sheetCodes, { forceRetry: true }); }
      catch (error) { upstreamError = error?.code || "OUTBOX_SYNC_FAILED"; }
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
  const currentPending = await sql`SELECT outbox.status, count(*)::int AS count, max(outbox.last_error) AS last_error
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
  upstreamError ||= currentPending.find(row => row.last_error)?.last_error || null;
  req.apiLogDetail = { stage: "complete", received, imported: count, pages, pendingUpstream: pendingCount, conflicts: conflictCount, resolvedSheetConflicts, upstreamError };
  send(res, 200, { ok: true, refreshed: true, imported: count, pendingUpstream: pendingCount, conflicts: conflictCount, resolvedSheetConflicts, upstreamError, message: "Đã cập nhật từ Google Sheet." });
});
