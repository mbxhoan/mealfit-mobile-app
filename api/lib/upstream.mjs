import { randomUUID } from "node:crypto";
import { withTransaction, getSql } from "./db.mjs";
import { toN8nBody } from "./orders.mjs";
import { sheetId, fetchSheetOrder, pushSheetOrder } from "./n8n.mjs";
import { importSheetOrders } from "./sync.mjs";

export async function queueUpstream(client, operationId, order, revision) {
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

export async function flushUpstream(batchSize = 20) {
  let sent = 0;
  for (let pass = 0; pass < 3; pass++) {
    const batch = await withTransaction(async client => {
      const selected = await client.query(`
        SELECT queued.operation_id, queued.order_code, queued.request_body, queued.attempts
        FROM mealfit_upstream_outbox queued
        WHERE queued.status IN ('queued', 'failed') AND queued.next_attempt_at <= now()
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
      `, [batchSize]);
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
}
