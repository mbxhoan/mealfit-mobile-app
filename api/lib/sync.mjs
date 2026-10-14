import { getSql } from "./db.mjs";
import { normalizeSheetOrder } from "./orders.mjs";

export function recordBatches(records, size = 100) {
  const batches = [];
  for (let offset = 0; offset < records.length; offset += size) batches.push(records.slice(offset, offset + size));
  return batches;
}

export async function importSheetOrders(rows) {
  const orders = rows.map(row => normalizeSheetOrder(row)).filter(Boolean);
  if (!orders.length) return 0;
  const sql = getSql();
  const records = orders.map(order => ({
    code: order.id,
    raw: order.raw,
    customer: order.customer,
    phone: order.phone,
    address: order.address,
    ordered_at: order.date,
    subtotal: order.subtotal,
    shipping_fee: order.shippingFee,
    total: order.total,
    paid_amount: order.paidAmount,
    remaining_due: order.remainingDue,
    payment_status: order.paymentStatus,
    shipping_status: order.deliveryStatus,
    shipper_name: order.shipperName || "Chưa phân công",
    assigned_user_id: order.assignedUserId,
    note: order.note,
    items: order.items,
    source_revision: order.sourceRevision
  }));
  let changedCount = 0;
  for (const batch of recordBatches(records)) {
    await sql`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS x(
        code text, raw jsonb, customer text, phone text, address text, ordered_at timestamptz,
        subtotal bigint, shipping_fee bigint, total bigint, paid_amount bigint, remaining_due bigint,
        payment_status text, shipping_status text, shipper_name text, assigned_user_id text,
        note text, items jsonb, source_revision bigint
      )
    )
    INSERT INTO mealfit_conflicts (conflict_id, order_code, app_revision, sheet_revision, app_payload, sheet_payload)
    SELECT gen_random_uuid()::text, current.code, current.revision, incoming.source_revision,
      jsonb_build_object('id', current.code, 'customer', current.customer, 'phone', current.phone,
        'address', current.address, 'shipperName', current.shipper_name, 'total', current.total,
        'paidAmount', current.paid_amount, 'remainingDue', current.remaining_due,
        'paymentStatus', current.payment_status, 'deliveryStatus', current.shipping_status,
        'note', current.note, 'mapsLink', current.maps_url, 'sessionId', current.session_id,
        'payments', current.payments, 'items', current.items, 'assignedUserId', current.assigned_user_id,
        'sourceRevision', current.source_revision), incoming.raw
    FROM incoming JOIN mealfit_orders current USING (code)
    WHERE incoming.source_revision > current.source_revision
      AND (incoming.customer IS DISTINCT FROM current.customer OR incoming.phone IS DISTINCT FROM current.phone
        OR incoming.address IS DISTINCT FROM current.address OR incoming.total IS DISTINCT FROM current.total
        OR incoming.paid_amount IS DISTINCT FROM current.paid_amount OR incoming.payment_status IS DISTINCT FROM current.payment_status
        OR incoming.shipping_status IS DISTINCT FROM current.shipping_status OR incoming.shipper_name IS DISTINCT FROM current.shipper_name
        OR incoming.note IS DISTINCT FROM current.note)
      AND NOT EXISTS (SELECT 1 FROM mealfit_conflicts conflict WHERE conflict.order_code = current.code AND conflict.status = 'open')
  `;
    const changed = await sql`
    INSERT INTO mealfit_orders (
      code, row_data, customer, phone, address, ordered_at, subtotal, shipping_fee, total,
      paid_amount, remaining_due, payment_status, shipping_status, shipper_name,
      assigned_user_id, note, items, source_revision
    )
    SELECT code, raw, customer, phone, address, ordered_at, subtotal, shipping_fee, total,
      paid_amount, remaining_due, payment_status, shipping_status, shipper_name,
      assigned_user_id, note, items, source_revision
    FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS x(
      code text, raw jsonb, customer text, phone text, address text, ordered_at timestamptz,
      subtotal bigint, shipping_fee bigint, total bigint, paid_amount bigint, remaining_due bigint,
      payment_status text, shipping_status text, shipper_name text, assigned_user_id text,
      note text, items jsonb, source_revision bigint
    )
    ON CONFLICT (code) DO UPDATE SET
      row_data = EXCLUDED.row_data,
      customer = EXCLUDED.customer,
      phone = EXCLUDED.phone,
      address = EXCLUDED.address,
      ordered_at = EXCLUDED.ordered_at,
      subtotal = EXCLUDED.subtotal,
      shipping_fee = EXCLUDED.shipping_fee,
      total = EXCLUDED.total,
      paid_amount = EXCLUDED.paid_amount,
      remaining_due = EXCLUDED.remaining_due,
      payment_status = EXCLUDED.payment_status,
      shipping_status = EXCLUDED.shipping_status,
      shipper_name = EXCLUDED.shipper_name,
      assigned_user_id = EXCLUDED.assigned_user_id,
      note = EXCLUDED.note,
      items = COALESCE(EXCLUDED.items, mealfit_orders.items),
      source_revision = CASE WHEN EXCLUDED.row_data ? 'revision' OR EXCLUDED.row_data ? 'Revision'
        THEN EXCLUDED.source_revision ELSE mealfit_orders.source_revision END,
      revision = mealfit_orders.revision + 1,
      synced_at = now(),
      updated_at = now()
    -- Legacy n8n rows may omit revisions; never replace an order with a queued app write.
    WHERE (EXCLUDED.source_revision > mealfit_orders.source_revision
      OR (NOT (EXCLUDED.row_data ? 'revision' OR EXCLUDED.row_data ? 'Revision') AND (
        EXCLUDED.customer IS DISTINCT FROM mealfit_orders.customer
        OR EXCLUDED.phone IS DISTINCT FROM mealfit_orders.phone
        OR EXCLUDED.address IS DISTINCT FROM mealfit_orders.address
        OR EXCLUDED.ordered_at IS DISTINCT FROM mealfit_orders.ordered_at
        OR EXCLUDED.subtotal IS DISTINCT FROM mealfit_orders.subtotal
        OR EXCLUDED.shipping_fee IS DISTINCT FROM mealfit_orders.shipping_fee
        OR EXCLUDED.total IS DISTINCT FROM mealfit_orders.total
        OR EXCLUDED.paid_amount IS DISTINCT FROM mealfit_orders.paid_amount
        OR EXCLUDED.remaining_due IS DISTINCT FROM mealfit_orders.remaining_due
        OR EXCLUDED.payment_status IS DISTINCT FROM mealfit_orders.payment_status
        OR EXCLUDED.shipping_status IS DISTINCT FROM mealfit_orders.shipping_status
        OR EXCLUDED.shipper_name IS DISTINCT FROM mealfit_orders.shipper_name
        OR EXCLUDED.assigned_user_id IS DISTINCT FROM mealfit_orders.assigned_user_id
        OR EXCLUDED.note IS DISTINCT FROM mealfit_orders.note
        OR (EXCLUDED.items IS NOT NULL AND mealfit_orders.items IS DISTINCT FROM EXCLUDED.items)
      )))
      AND NOT EXISTS (SELECT 1 FROM mealfit_upstream_outbox queued
        WHERE queued.order_code = mealfit_orders.code AND queued.status IN ('queued', 'sending', 'failed', 'conflict'))
      AND NOT EXISTS (SELECT 1 FROM mealfit_conflicts conflict WHERE conflict.order_code = mealfit_orders.code AND conflict.status = 'open')
    RETURNING code
  `;
    if (changed.length) await sql`
      INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, detail)
      SELECT 'system', 'order', code, 'sheet-import', '{"source":"n8n"}'::jsonb
      FROM unnest(${changed.map(row => row.code)}::text[]) AS code
    `;
    changedCount += changed.length;
  }
  return changedCount;
}

export async function markSheetPull(imported) {
  await getSql()`INSERT INTO mealfit_sync_meta (key, value, updated_at)
    VALUES ('last-sheet-pull', jsonb_build_object('count', ${imported}::integer, 'at', now()), now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export function orderFromRow(row) {
  const raw = row.row_data || {};
  const order = normalizeSheetOrder(raw, {
    mapsLink: row.maps_url,
    sessionId: row.session_id,
    payments: row.payments,
    serverRevision: row.revision,
    deliveredAt: raw.deliveredAt
  });
  if (!order) return null;
  return {
    ...order,
    date: row.ordered_at || order.date,
    customer: row.customer,
    phone: row.phone,
    address: row.address,
    subtotal: Number(row.subtotal),
    shippingFee: Number(row.shipping_fee),
    total: Number(row.total),
    paidAmount: Number(row.paid_amount),
    remainingDue: Number(row.remaining_due),
    paymentStatus: row.payment_status,
    deliveryStatus: row.shipping_status,
    shipperName: row.shipper_name,
    assignedUserId: row.assigned_user_id,
    note: row.note,
    items: Array.isArray(row.items) ? row.items : [],
    mapsLink: row.maps_url,
    sessionId: row.session_id,
    payments: row.payments || [],
    serverRevision: Number(row.revision),
    sourceRevision: Number(row.source_revision)
  };
}
