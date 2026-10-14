import { AppError, handler, requireMethod, send } from "../server-lib/core.mjs";
import { assertSameOrigin, requireUser } from "../server-lib/auth.mjs";
import { getSql } from "../server-lib/db.mjs";
import { fetchSheetOrders } from "../server-lib/n8n.mjs";

export default handler(async (req, res) => {
  requireMethod(req, "GET");
  assertSameOrigin(req);
  const user = requireUser(req);
  const url = new URL(req.url, `https://${req.headers.host || "mealfit.local"}`);
  if (url.searchParams.get("view") === "logs") {
    if (user.role !== "admin") throw new AppError(403, "ADMIN_REQUIRED", "Chỉ admin được xem lịch sử hệ thống.");
    const kind = url.searchParams.get("kind") || "api";
    if (!["api", "activity"].includes(kind)) throw new AppError(400, "INVALID_LOG_FILTER", "Bộ lọc lịch sử không hợp lệ.");
    const cursor = url.searchParams.get("cursor") || "";
    if (cursor && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) throw new AppError(400, "INVALID_CURSOR", "Không thể đọc vị trí trang lịch sử.");
    const limit = Math.floor(Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 50)));
    const rows = await getSql()`SELECT audit_id, actor_id, entity_type, entity_id, operation, operation_id, detail, created_at
      FROM mealfit_audit_log
      WHERE (${kind} = 'api' AND entity_type = 'api' OR ${kind} = 'activity' AND entity_type <> 'api')
        AND (${!cursor} OR audit_id < ${cursor || "0"}::bigint)
      ORDER BY audit_id DESC LIMIT ${limit + 1}`;
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(row => ({
      id: Number(row.audit_id), actorId: row.actor_id, entityType: row.entity_type,
      entityId: row.entity_id, operation: row.operation, operationId: row.operation_id,
      detail: row.detail || {}, createdAt: row.created_at
    }));
    send(res, 200, { data, hasMore, nextCursor: hasMore ? String(rows[limit - 1].audit_id) : null });
    return;
  }

  const databaseStartedAt = Date.now();
  const apiStartedAt = Date.now();
  const [database, ordersApi] = await Promise.all([
    getSql()`SELECT 1`
      .then(() => ({ ok: true, durationMs: Date.now() - databaseStartedAt }))
      .catch(error => ({ ok: false, durationMs: Date.now() - databaseStartedAt, message: "Không kết nối được cơ sở dữ liệu.", errorCode: error?.code || error?.sourceError?.cause?.code || "DATABASE_UNAVAILABLE" })),
    fetchSheetOrders({ limit: 1 })
      .then(result => ({ ok: true, status: 200, durationMs: Date.now() - apiStartedAt, sampleCount: result.rows.length }))
      .catch(error => ({ ok: false, status: error.upstreamStatus || null, code: error.code || "UPSTREAM_ERROR", durationMs: Date.now() - apiStartedAt, message: error.message }))
  ]);

  send(res, 200, { appApi: { ok: true }, database, ordersApi });
});
