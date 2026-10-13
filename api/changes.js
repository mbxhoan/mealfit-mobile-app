import { handler, requireMethod, send } from "./lib/core.mjs";
import { requireUser } from "./lib/auth.mjs";
import { getSql } from "./lib/db.mjs";
import { orderFromRow } from "./lib/sync.mjs";

export default handler(async (req, res) => {
  requireMethod(req, "GET");
  const user = requireUser(req);
  const url = new URL(req.url, `https://${req.headers.host || "mealfit.local"}`);
  const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 50));
  const rows = await getSql()`
    SELECT a.audit_id, a.entity_type,
      CASE WHEN a.entity_type = 'order' THEN to_jsonb(o)
        ELSE jsonb_build_object('payload', s.payload, 'revision', s.revision) END AS record
    FROM mealfit_audit_log a
    LEFT JOIN mealfit_orders o ON a.entity_type = 'order' AND o.code = a.entity_id
    LEFT JOIN mealfit_sessions s ON a.entity_type = 'session' AND s.session_id = a.entity_id
    WHERE a.audit_id > ${cursor} AND a.entity_type IN ('order', 'session')
      AND (${user.role !== "shipper"} OR
        (a.entity_type = 'order' AND (o.assigned_user_id = ${user.id} OR o.assigned_user_id IS NULL)) OR
        (a.entity_type = 'session' AND s.owner_id = ${user.id}))
    ORDER BY a.audit_id ASC LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const orders = [];
  const sessions = [];
  for (const row of page) {
    if (!row.record) continue;
    if (row.entity_type === "order") {
      const order = orderFromRow(row.record);
      if (order) orders.push(order);
    } else if (row.record.payload) {
      sessions.push({ ...row.record.payload, serverRevision: Number(row.record.revision) });
    }
  }
  send(res, 200, { orders, sessions, nextCursor: page.length ? String(page.at(-1).audit_id) : null, hasMore });
});
