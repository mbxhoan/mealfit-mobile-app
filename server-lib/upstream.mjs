import { randomUUID } from "node:crypto";
import { withAdvisoryLock, withTransaction, getSql } from "./db.mjs";
import { AppError } from "./core.mjs";
import { toN8nBody } from "./orders.mjs";
import { sheetId, fetchSheetOrder, pushSheetOrder, pushSheetOrders } from "./n8n.mjs";

// The Postgres write is the user's action; the Google Sheet is updated afterwards from this outbox. Every row carries the
// complete, absolute Sheet-managed state of one order, so only the newest unsent row per order matters, resending is
// harmless, and there is no "conflict" state: the app's value is what gets pushed until the Sheet has confirmed it.

const FLUSH_LOCK = 772_024_101;
const MAX_BACKOFF_SECONDS = 300;

// Queues the newest state of one order. Older unsent rows of the same order are superseded, not sent.
export async function queueUpstream(client, operationId, order, revision) {
  await client.query(`UPDATE mealfit_upstream_outbox SET status = 'sent', last_error = 'SUPERSEDED', updated_at = now()
    WHERE order_code = $1 AND status IN ('queued', 'failed', 'conflict')`, [order.id]);
  // expected_revision is read when the row is sent, not guessed now.
  const body = toN8nBody({ ...order, sourceRevision: 0 }, sheetId());
  await client.query(
    "INSERT INTO mealfit_upstream_outbox (operation_id, order_code, target_revision, request_body) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (operation_id) DO NOTHING",
    [operationId || randomUUID(), order.id, revision, JSON.stringify(body)]
  );
}

export async function pendingUpstream(orderCodes) {
  if (!orderCodes?.length) return [];
  const codes = [...new Set(orderCodes.map(String).filter(Boolean))];
  if (!codes.length) return [];
  return getSql()`SELECT order_code, status, next_attempt_at, last_error FROM mealfit_upstream_outbox
    WHERE order_code = ANY(${codes}::text[]) AND status IN ('queued', 'sending', 'failed', 'conflict')`;
}

const backoffSeconds = attempts => Math.min(MAX_BACKOFF_SECONDS, 30 * (2 ** Math.min(Number(attempts) || 0, 4)));
const sheetRevisionOf = row => {
  const value = Number(row?.revision ?? row?.Revision);
  return Number.isSafeInteger(value) ? value : null;
};

const realDeps = { lock: withAdvisoryLock, transaction: withTransaction, sql: getSql, push: pushSheetOrder, pushBatch: pushSheetOrders, fetchRow: fetchSheetOrder };

// Sends due outbox rows to the Sheet through n8n. `orderCodes` limits the run to some orders, `forceRetry` ignores backoff.
export async function flushUpstream(batchSize = 20, orderCodes = null, { forceRetry = false, deps = realDeps } = {}) {
  const { lock, transaction, sql, push, pushBatch, fetchRow } = { ...realDeps, ...deps };
  const codes = orderCodes?.length ? [...new Set(orderCodes.map(String).filter(Boolean))] : null;
  try {
    return await lock(FLUSH_LOCK, async () => {
      const db = sql();
      await db`UPDATE mealfit_upstream_outbox SET status = 'failed', last_error = 'WORKER_INTERRUPTED', next_attempt_at = now(), updated_at = now()
        WHERE status = 'sending' AND updated_at < now() - interval '2 minutes'
          AND (${codes === null} OR order_code = ANY(${codes || []}::text[]))`;
      if (forceRetry) await db`UPDATE mealfit_upstream_outbox SET next_attempt_at = now(), updated_at = now()
        WHERE status = 'failed' AND next_attempt_at > now()
          AND (${codes === null} OR order_code = ANY(${codes || []}::text[]))`;
      let sent = 0;

      const markSent = async (row, revision) => {
        await db`UPDATE mealfit_upstream_outbox SET status = 'sent', last_error = NULL, updated_at = now() WHERE operation_id = ${row.operation_id}`;
        await db`UPDATE mealfit_upstream_outbox SET status = 'sent', last_error = 'SUPERSEDED', updated_at = now()
          WHERE order_code = ${row.order_code} AND status IN ('queued', 'failed') AND operation_id <> ${row.operation_id}
            AND target_revision <= (SELECT target_revision FROM mealfit_upstream_outbox WHERE operation_id = ${row.operation_id})`;
        await db`UPDATE mealfit_orders SET source_revision = GREATEST(source_revision, ${revision}::bigint),
          row_data = jsonb_set(row_data, '{revision}', to_jsonb(GREATEST(source_revision, ${revision}::bigint)), true), synced_at = now()
          WHERE code = ${row.order_code}`;
        sent++;
      };
      const markFailed = async (row, error, { retryNow = false, delay = backoffSeconds(row.attempts) } = {}) => {
        const reason = String(error?.code || "UPSTREAM_ERROR");
        await db`UPDATE mealfit_upstream_outbox SET status = ${retryNow ? "queued" : "failed"}, last_error = ${reason},
          next_attempt_at = now() + (${retryNow ? 0 : delay} * interval '1 second'), updated_at = now() WHERE operation_id = ${row.operation_id}`;
      };
      // The Sheet rejected our revision (a Sheet that enforces it, or one edited by hand): adopt its revision and send the
      // same absolute values again. The app's value wins; nothing is left in a state that needs a person to resolve it.
      const adoptSheetRevision = async row => {
        const sheetRow = await fetchRow(row.order_code);
        const revision = sheetRevisionOf(sheetRow);
        if (revision == null) return false;
        await db`UPDATE mealfit_orders SET source_revision = ${revision}::bigint WHERE code = ${row.order_code}`;
        return true;
      };

      for (let pass = 0; pass < 3; pass++) {
        const batch = await transaction(async client => {
          const selected = await client.query(`
            SELECT queued.operation_id, queued.order_code, queued.request_body, queued.attempts, orders.source_revision
            FROM mealfit_upstream_outbox queued
            JOIN mealfit_orders orders ON orders.code = queued.order_code
            WHERE queued.status IN ('queued', 'failed') AND queued.next_attempt_at <= now()
              AND ($2::text[] IS NULL OR queued.order_code = ANY($2::text[]))
              AND NOT EXISTS (SELECT 1 FROM mealfit_upstream_outbox sending WHERE sending.order_code = queued.order_code AND sending.status = 'sending')
              AND NOT EXISTS (SELECT 1 FROM mealfit_upstream_outbox newer WHERE newer.order_code = queued.order_code
                AND newer.status IN ('queued', 'failed') AND newer.target_revision > queued.target_revision)
            ORDER BY queued.created_at LIMIT $1 FOR UPDATE OF queued SKIP LOCKED
          `, [Math.min(batchSize, 20), codes]);
          for (const row of selected.rows) {
            await client.query("UPDATE mealfit_upstream_outbox SET status = 'sending', attempts = attempts + 1, updated_at = now() WHERE operation_id = $1", [row.operation_id]);
          }
          return selected.rows.map(row => ({ ...row, request_body: { ...row.request_body, expected_revision: Number(row.source_revision) || 0 } }));
        });
        if (!batch.length) break;

        let results = null;
        if (batch.length > 1) {
          try { results = await pushBatch(batch); }
          catch (error) {
            // The old workflow has no batch route; keep its single-order path during rollout.
            if (error?.upstreamStatus !== 404) results = batch.map(() => ({ error }));
          }
        }
        for (const [index, row] of batch.entries()) {
          try {
            if (results?.[index]?.error) throw results[index].error;
            const result = results ? results[index] : await push(row.request_body, row.operation_id);
            if (result.status === "not-found") { await markFailed(row, { code: "SHEET_ROW_NOT_FOUND" }, { delay: 3600 }); continue; }
            if (result.status === "conflict") throw new AppError(409, "SHEET_REVISION_CONFLICT", "Sheet đã đổi phiên bản.");
            const revision = Number(result.revision ?? result.data?.revision);
            if (!Number.isSafeInteger(revision) || revision <= Number(row.request_body.expected_revision)) throw new Error("n8n did not confirm the Sheet revision");
            await markSent(row, revision);
          } catch (error) {
            if (error?.status === 409 && Number(row.attempts) < 4 && await adoptSheetRevision(row).catch(() => false)) await markFailed(row, error, { retryNow: true });
            else await markFailed(row, error);
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
