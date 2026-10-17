import { randomUUID } from "node:crypto";
import { withAdvisoryLock, withTransaction, getSql } from "./db.mjs";
import { AppError } from "./core.mjs";
import { toN8nBody } from "./orders.mjs";
import { sheetId, fetchSheetOrder, pushSheetOrder } from "./n8n.mjs";
import { importSheetOrders, sheetOrderMatchesPayload } from "./sync.mjs";

export async function reconcileUpstreamWithSheet(rows) {
  const sheet = new Map(rows.map(row => [String(row?.["Mã đơn"] || row?.code || "").trim(), row]));
  const codes = [...sheet.keys()].filter(Boolean);
  if (!codes.length) return { confirmed: 0, conflicts: 0 };
  return withAdvisoryLock(772_024_101, async client => {
    const pending = await client.query(`SELECT DISTINCT ON (order_code)
        operation_id, order_code, target_revision, request_body
      FROM mealfit_upstream_outbox
      WHERE order_code = ANY($1::text[]) AND status IN ('queued', 'sending', 'failed', 'conflict')
      ORDER BY order_code, target_revision DESC, updated_at DESC`, [codes]);
    let confirmed = 0;
    let conflicts = 0;
    for (const item of pending.rows) {
      const matches = sheetOrderMatchesPayload(sheet.get(item.order_code), { ...item.request_body, code: item.order_code });
      if (matches) {
        const revision = Number(item.request_body.expected_revision) + 1;
        await client.query(`UPDATE mealfit_upstream_outbox SET status = 'sent', last_error = NULL, updated_at = now()
          WHERE order_code = $1 AND status IN ('queued', 'sending', 'failed', 'conflict')`, [item.order_code]);
        if (Number.isSafeInteger(revision)) await client.query(`UPDATE mealfit_orders
          SET source_revision = GREATEST(source_revision, $2), synced_at = now()
          WHERE code = $1`, [item.order_code, revision]);
        confirmed++;
      } else {
        await client.query(`UPDATE mealfit_upstream_outbox SET status = 'conflict', last_error = 'SHEET_STATE_DIVERGED', updated_at = now()
          WHERE order_code = $1 AND status IN ('queued', 'sending', 'failed')`, [item.order_code]);
        const orderRows = await client.query("SELECT * FROM mealfit_orders WHERE code = $1 FOR UPDATE", [item.order_code]);
        const order = orderRows.rows[0];
        if (order) {
          const body = item.request_body;
          const paidAmount = Number(body.total) || 0;
          const paymentStatus = String(body.payment_staus || order.payment_status);
          const appPayload = {
            id: order.code, customer: order.customer, phone: order.phone, address: order.address,
            shipperName: body.shipper || order.shipper_name, total: Number(order.total), paidAmount,
            remainingDue: paymentStatus === "Đã thanh toán" ? 0 : Math.max(0, Number(order.total) - paidAmount),
            paymentStatus, deliveryStatus: body.shipping_status, note: body.note || "",
            mapsLink: order.maps_url || "", sessionId: order.session_id || null,
            payments: order.payments || [], items: order.items || [], assignedUserId: order.assigned_user_id,
            sourceRevision: Number(order.source_revision) || 0
          };
          await client.query(`INSERT INTO mealfit_conflicts
              (conflict_id, order_code, app_revision, sheet_revision, app_payload, sheet_payload)
            SELECT $1, $2, $3, $4, $5::jsonb, $6::jsonb
            WHERE NOT EXISTS (SELECT 1 FROM mealfit_conflicts WHERE order_code = $2 AND status = 'open')
            ON CONFLICT (conflict_id) DO NOTHING`, [
            `outbox-${item.operation_id}`, item.order_code, Number(order.revision) || 0,
            Number(order.source_revision) || 0, JSON.stringify(appPayload), JSON.stringify(sheet.get(item.order_code))
          ]);
        }
        conflicts++;
      }
    }
    return { confirmed, conflicts };
  });
}

export async function queueUpstream(client, operationId, order, revision) {
  await client.query("DELETE FROM mealfit_upstream_outbox WHERE order_code = $1 AND status = 'queued' AND attempts = 0", [order.id]);
  const state = await client.query(`SELECT o.source_revision,
    (SELECT count(*)::int FROM mealfit_upstream_outbox q WHERE q.order_code = o.code AND q.status IN ('queued', 'sending', 'failed')) AS pending
    FROM mealfit_orders o WHERE o.code = $1`, [order.id]);
  const expectedRevision = Number(state.rows[0]?.source_revision || 0) + Number(state.rows[0]?.pending || 0);
  const body = toN8nBody({ ...order, sourceRevision: expectedRevision }, sheetId());
  await client.query(
    "INSERT INTO mealfit_upstream_outbox (operation_id, order_code, target_revision, request_body) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (operation_id) DO NOTHING",
    [operationId || randomUUID(), order.id, revision, JSON.stringify(body)]
  );
}

export async function pendingUpstream(orderCodes) {
  if (!orderCodes?.length) return [];
  const codes = [...new Set(orderCodes.map(String).filter(Boolean))];
  if (!codes.length) return [];
  return getSql()`SELECT order_code, status, next_attempt_at FROM mealfit_upstream_outbox
    WHERE order_code = ANY(${codes}::text[]) AND status IN ('queued', 'sending', 'failed', 'conflict')`;
}

export async function flushUpstream(batchSize = 20, orderCodes = null) {
  const codes = orderCodes?.length ? [...new Set(orderCodes.map(String).filter(Boolean))] : null;
  try {
    return await withAdvisoryLock(772_024_101, async () => {
      await getSql()`UPDATE mealfit_upstream_outbox SET status = 'failed', last_error = 'WORKER_INTERRUPTED', next_attempt_at = now(), updated_at = now()
        WHERE status = 'sending' AND updated_at < now() - interval '2 minutes'
          AND (${codes === null} OR order_code = ANY(${codes || []}::text[]))`;
    let sent = 0;
    for (let pass = 0; pass < 3; pass++) {
      const batch = await withTransaction(async client => {
        const selected = await client.query(`
          SELECT queued.operation_id, queued.order_code, queued.request_body, queued.attempts
          FROM mealfit_upstream_outbox queued
          WHERE queued.status IN ('queued', 'failed') AND queued.next_attempt_at <= now()
            AND ($2::text[] IS NULL OR queued.order_code = ANY($2::text[]))
            AND NOT EXISTS (
              SELECT 1 FROM mealfit_upstream_outbox earlier
              WHERE earlier.order_code = queued.order_code AND earlier.target_revision < queued.target_revision
                AND earlier.status IN ('queued', 'failed', 'sending', 'conflict')
            )
            AND NOT EXISTS (
              SELECT 1 FROM mealfit_upstream_outbox sending
              WHERE sending.order_code = queued.order_code AND sending.status = 'sending'
            )
          ORDER BY queued.created_at LIMIT $1 FOR UPDATE SKIP LOCKED
        `, [batchSize, codes]);
        for (const row of selected.rows) {
          await client.query("UPDATE mealfit_upstream_outbox SET status = 'sending', attempts = attempts + 1, updated_at = now() WHERE operation_id = $1", [row.operation_id]);
        }
        return selected.rows;
      });
      if (!batch.length) break;
      for (const row of batch) {
        try {
          const result = await pushSheetOrder(row.request_body, row.operation_id);
          const sourceRevision = Number(result.revision ?? result.data?.revision);
          if (!Number.isSafeInteger(sourceRevision) || sourceRevision <= Number(row.request_body.expected_revision)) throw new Error("n8n did not confirm the Sheet revision");
          await getSql()`UPDATE mealfit_upstream_outbox SET status = 'sent', last_error = NULL, updated_at = now() WHERE operation_id = ${row.operation_id}`;
          await getSql()`UPDATE mealfit_orders SET source_revision = ${sourceRevision}, row_data = jsonb_set(row_data, '{revision}', to_jsonb(${sourceRevision}::bigint), true), synced_at = now() WHERE code = ${row.order_code}`;
          sent++;
        } catch (error) {
          if (error?.status === 409) {
            await getSql()`UPDATE mealfit_upstream_outbox SET status = 'conflict', last_error = 'SHEET_REVISION_CONFLICT', updated_at = now() WHERE operation_id = ${row.operation_id}`;
            try { await importSheetOrders([await fetchSheetOrder(row.order_code)]); } catch {}
          } else {
            const delaySeconds = Math.min(3600, 30 * (2 ** Math.min(Number(row.attempts) || 0, 7)));
            await getSql()`UPDATE mealfit_upstream_outbox SET status = 'failed', last_error = ${String(error?.code || "UPSTREAM_ERROR")}, next_attempt_at = now() + (${delaySeconds} * interval '1 second'), updated_at = now() WHERE operation_id = ${row.operation_id}`;
          }
        }
      }
    }
    return sent;
    }, 20_000);
  } catch (error) {
    if (error?.code !== "55P03") throw error;
    const busy = new AppError(503, "OUTBOX_SYNC_BUSY", "Đồng bộ đang được xử lý ở thiết bị khác. Dữ liệu vẫn được giữ; vui lòng thử lại sau.");
    busy.retryAfterSeconds = 5;
    throw busy;
  }
}
