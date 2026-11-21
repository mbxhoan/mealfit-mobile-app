import { createHash, randomUUID } from "node:crypto";
import {
  addOrdersToSession, cancelSession, completeSession, createSession, deleteSession, markDelivered, markPaid, pauseSession,
  removeOrderFromSession, reopenDeliveredOrder, reorderOrderInSession, resolveOrphanDelivery, resumeSession, setOrderMapsLink,
  setOrderNote, setSessionOrderShift, startSession, PAYMENT_METHODS, SHIFT_OPTIONS
} from "../domain.mjs";
import { AppError } from "./core.mjs";
import { withTransaction } from "./db.mjs";
import { changedEntities, OPEN_SESSION_STATUSES, reconcileState } from "./invariants.mjs";
import { sheetShipperNames } from "./accounts.mjs";
import { orderFromRow } from "./sync.mjs";
import { queueUpstream } from "./upstream.mjs";

// Every user action is one command. The server loads the account's authoritative state under a per-account lock, runs
// the same pure domain function the UI used to run on the device, repairs the invariants, and commits the result.
// Devices therefore never merge or overwrite each other's state: they only ask the server to do something.

const LOCK_NAMESPACE = 772_024_103;
const CODE = /^[A-Za-z0-9_-]{2,40}$/;
const SESSION_ID = /^PS-[A-Za-z0-9_-]{1,60}$/;
const SHIPPER = ["shipper"];
const STAFF = ["admin", "user"];
const ANY_ROLE = [...SHIPPER, ...STAFF];
const nameKey = value => String(value || "").trim().toLocaleLowerCase("vi-VN");
const clone = value => structuredClone(value);

const invalid = message => new AppError(400, "INVALID_COMMAND", message);
const rejected = message => { const error = new Error(message); error.rejected = true; return error; };

const codeArg = (value, label = "mã đơn") => {
  if (!CODE.test(String(value ?? ""))) throw invalid(`Thiếu hoặc sai ${label}.`);
  return String(value);
};
const sessionArg = value => {
  if (!SESSION_ID.test(String(value ?? ""))) throw invalid("Thiếu hoặc sai mã phiên.");
  return String(value);
};
const codeList = (value, max = 500) => {
  if (!Array.isArray(value) || !value.length || value.length > max) throw invalid("Danh sách đơn hàng không hợp lệ.");
  return [...new Set(value.map(item => codeArg(item)))];
};
const stringMap = (value, limit = 2000) => {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("Dữ liệu ghi chú không hợp lệ.");
  return Object.fromEntries(Object.entries(value).map(([code, text]) => {
    if (!CODE.test(code) || (text != null && typeof text !== "string") || String(text ?? "").length > limit) throw invalid("Dữ liệu ghi chú không hợp lệ.");
    return [code, text ?? ""];
  }));
};
const shiftMap = value => {
  if (typeof value === "string") { if (!SHIFT_OPTIONS.includes(value)) throw invalid("Ca giao hàng không hợp lệ."); return value; }
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw invalid("Ca giao hàng không hợp lệ.");
  return Object.fromEntries(Object.entries(value).map(([code, shift]) => {
    if (!CODE.test(code) || (shift != null && !SHIFT_OPTIONS.includes(shift))) throw invalid("Ca giao hàng không hợp lệ.");
    return [code, shift ?? null];
  }));
};
const shiftArg = value => {
  if (!SHIFT_OPTIONS.includes(value)) throw invalid("Ca giao hàng không hợp lệ.");
  return value;
};
const textArg = (value, label, max = 2000) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) throw invalid(`${label} không hợp lệ.`);
  return value;
};

const sessionOf = (state, id) => state.sessions.find(item => item.id === id);
const openSessionOf = (state, id) => {
  const session = sessionOf(state, id);
  if (!session || !OPEN_SESSION_STATUSES.includes(session.status)) throw rejected("Phiên này đã kết thúc. Bấm Đồng bộ để cập nhật.");
  return session;
};
const orderOf = (state, id) => state.orders.find(item => item.id === id);
const closed = (state, id) => { const session = sessionOf(state, id); return !session || !OPEN_SESSION_STATUSES.includes(session.status); };

// name -> { roles, validate(args), codes(args), sessions(args), satisfied(state,args,ctx), run(state,args,ctx) }
// `satisfied` makes a command from a stale screen succeed as a no-op when the server is already in the wanted state.
export const COMMANDS = {
  createSession: {
    roles: SHIPPER,
    validate: a => ({ orderIds: codeList(a.orderIds, 500), shifts: shiftMap(a.shifts), notes: stringMap(a.notes), maps: stringMap(a.maps) }),
    codes: a => a.orderIds,
    run: (state, a, ctx) => createSession(state, a.orderIds, a.shifts, ctx.now, a.notes, a.maps)
  },
  startSession: {
    roles: SHIPPER,
    validate: a => ({ sessionId: sessionArg(a.sessionId) }),
    sessions: a => [a.sessionId],
    satisfied: (state, a) => sessionOf(state, a.sessionId)?.status === "active",
    run: (state, a, ctx) => { openSessionOf(state, a.sessionId); return startSession(state, ctx.now); }
  },
  pauseSession: {
    roles: SHIPPER,
    validate: a => ({ sessionId: sessionArg(a.sessionId) }),
    sessions: a => [a.sessionId],
    satisfied: (state, a) => sessionOf(state, a.sessionId)?.status === "paused",
    run: (state, a, ctx) => { openSessionOf(state, a.sessionId); return pauseSession(state, ctx.now); }
  },
  resumeSession: {
    roles: SHIPPER,
    validate: a => ({ sessionId: sessionArg(a.sessionId) }),
    sessions: a => [a.sessionId],
    satisfied: (state, a) => sessionOf(state, a.sessionId)?.status === "active",
    run: (state, a, ctx) => { openSessionOf(state, a.sessionId); return resumeSession(state, ctx.now); }
  },
  cancelSession: {
    roles: SHIPPER,
    validate: a => ({ sessionId: sessionArg(a.sessionId) }),
    sessions: a => [a.sessionId],
    satisfied: (state, a) => closed(state, a.sessionId),
    run: (state, a, ctx) => { openSessionOf(state, a.sessionId); return cancelSession(state, ctx.now); }
  },
  completeSession: {
    roles: SHIPPER,
    validate: a => ({ sessionId: sessionArg(a.sessionId) }),
    sessions: a => [a.sessionId],
    satisfied: (state, a) => sessionOf(state, a.sessionId)?.status === "completed",
    run: (state, a, ctx) => { openSessionOf(state, a.sessionId); return completeSession(state, a.sessionId, ctx.now); }
  },
  deleteSession: {
    roles: [...SHIPPER, "admin"],
    validate: a => ({ sessionId: sessionArg(a.sessionId) }),
    sessions: a => [a.sessionId],
    satisfied: (state, a) => !sessionOf(state, a.sessionId),
    run: (state, a) => deleteSession(state, a.sessionId)
  },
  addOrdersToSession: {
    roles: SHIPPER,
    validate: a => ({ sessionId: sessionArg(a.sessionId), orderIds: codeList(a.orderIds, 500), shift: shiftArg(a.shift), notes: stringMap(a.notes), maps: stringMap(a.maps) }),
    codes: a => a.orderIds,
    sessions: a => [a.sessionId],
    run: (state, a) => { openSessionOf(state, a.sessionId); return addOrdersToSession(state, a.orderIds, a.shift, a.notes, a.maps); }
  },
  removeOrderFromSession: {
    roles: SHIPPER,
    validate: a => ({ sessionId: sessionArg(a.sessionId), orderId: codeArg(a.orderId) }),
    codes: a => [a.orderId],
    sessions: a => [a.sessionId],
    satisfied: (state, a) => !sessionOf(state, a.sessionId)?.orderIds.includes(a.orderId),
    run: (state, a) => { openSessionOf(state, a.sessionId); return removeOrderFromSession(state, a.orderId); }
  },
  setSessionOrderShift: {
    roles: SHIPPER,
    validate: a => ({ sessionId: sessionArg(a.sessionId), orderId: codeArg(a.orderId), shift: shiftArg(a.shift) }),
    codes: a => [a.orderId],
    sessions: a => [a.sessionId],
    run: (state, a) => { openSessionOf(state, a.sessionId); return setSessionOrderShift(state, a.orderId, a.shift); }
  },
  // "Move X to where Y is" instead of "replace the list": a stale screen can never overwrite a newer route.
  reorderOrderInSession: {
    roles: SHIPPER,
    validate: a => ({ sessionId: sessionArg(a.sessionId), orderId: codeArg(a.orderId), targetOrderId: codeArg(a.targetOrderId, "mã đơn đích") }),
    codes: a => [a.orderId],
    sessions: a => [a.sessionId],
    run: (state, a) => {
      const session = openSessionOf(state, a.sessionId);
      const index = session.orderIds.indexOf(a.targetOrderId);
      if (index < 0) throw rejected("Điểm giao đích không còn trong phiên. Bấm Đồng bộ để cập nhật.");
      return reorderOrderInSession(state, a.orderId, index);
    }
  },
  markDelivered: {
    roles: ANY_ROLE,
    validate: a => ({ orderId: codeArg(a.orderId) }),
    codes: a => [a.orderId],
    satisfied: (state, a) => orderOf(state, a.orderId)?.deliveryStatus === "Đã giao hàng",
    run: (state, a, ctx) => markDelivered(state, a.orderId, ctx.now)
  },
  reopenDeliveredOrder: {
    roles: ANY_ROLE,
    validate: a => {
      if (!["Đang giao hàng", "Chưa giao hàng"].includes(a.deliveryStatus)) throw invalid("Trạng thái giao hàng không hợp lệ.");
      return { orderId: codeArg(a.orderId), deliveryStatus: a.deliveryStatus, shift: a.shift == null ? null : shiftArg(a.shift) };
    },
    codes: a => [a.orderId],
    run: (state, a, ctx) => reopenDeliveredOrder(state, a.orderId, a.deliveryStatus, a.shift, ctx.now)
  },
  markPaid: {
    roles: ANY_ROLE,
    validate: a => {
      if (!PAYMENT_METHODS.includes(a.method)) throw invalid("Phương thức thanh toán không hợp lệ.");
      return { orderId: codeArg(a.orderId), method: a.method };
    },
    codes: a => [a.orderId],
    satisfied: (state, a) => orderOf(state, a.orderId)?.paymentStatus === "Đã thanh toán",
    run: (state, a, ctx) => markPaid(state, a.orderId, a.method, ctx.now)
  },
  setOrderNoteAndMaps: {
    roles: ANY_ROLE,
    validate: a => ({ orderId: codeArg(a.orderId), note: textArg(a.note, "Ghi chú"), mapsLink: textArg(a.mapsLink, "Link bản đồ", 500) }),
    codes: a => [a.orderId],
    run: (state, a) => {
      let next = state;
      if (a.note !== undefined) next = setOrderNote(next, a.orderId, a.note);
      if (a.mapsLink !== undefined) next = setOrderMapsLink(next, a.orderId, a.mapsLink);
      return next;
    }
  },
  resolveOrphanDelivery: {
    roles: SHIPPER,
    validate: a => {
      if (!["Chưa giao hàng", "Đã giao hàng", "Đã huỷ đơn"].includes(a.status)) throw invalid("Trạng thái giao hàng không hợp lệ.");
      return { orderId: codeArg(a.orderId), status: a.status };
    },
    codes: a => [a.orderId],
    satisfied: (state, a) => orderOf(state, a.orderId)?.deliveryStatus === a.status,
    run: (state, a, ctx) => resolveOrphanDelivery(state, a.orderId, ctx.user.id, a.status, ctx.now)
  }
};

export function validateCommand(name, rawArgs, user) {
  const definition = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
  if (!definition) throw new AppError(400, "UNKNOWN_COMMAND", "Thao tác không được hỗ trợ.");
  if (!definition.roles.includes(user.role)) throw new AppError(403, "COMMAND_FORBIDDEN", "Tài khoản này không có quyền thực hiện thao tác này.");
  if (rawArgs != null && (typeof rawArgs !== "object" || Array.isArray(rawArgs))) throw invalid("Dữ liệu thao tác không hợp lệ.");
  const args = definition.validate(rawArgs || {});
  return { definition, args, codes: definition.codes?.(args) || [], sessionIds: definition.sessions?.(args) || [] };
}

function authorize(state, codes, ctx) {
  const names = new Set(sheetShipperNames(ctx.user).map(nameKey));
  const mine = order => order.assignedUserId === ctx.user.id || names.has(nameKey(order.shipperName));
  const memberOf = order => state.sessions.some(session => session.ownerId === ctx.user.id && session.orderIds?.includes(order.id));
  for (const code of codes) {
    const order = orderOf(state, code);
    if (!order) throw new AppError(404, "ORDER_NOT_FOUND", `Không tìm thấy đơn ${code}.`);
    if (ctx.user.role === "shipper") {
      if (!mine(order) && !memberOf(order)) throw rejected(`Đơn ${code} chưa được giao cho tài khoản này.`);
      if (order.assignedUserId !== ctx.user.id && mine(order)) order.assignedUserId = ctx.user.id;
    } else if (state.sessions.some(session => OPEN_SESSION_STATUSES.includes(session.status) && session.orderIds?.includes(code))) {
      throw rejected(`Đơn ${code} đang nằm trong phiên giao của shipper.`);
    }
  }
}

// Pure core. `state` is { orders, sessions, activeSessionId } for one account. Never touches the database.
// Returns { healed, after, noop, rejection }: `healed` is the state after repairing the invariants alone (persisted even
// when the command is rejected, so a stuck session heals on the next action), `after` additionally includes the command.
export function runCommand(state, name, rawArgs, ctx) {
  const { definition, args, codes } = validateCommand(name, rawArgs, ctx.user);
  const healed = reconcileState(state, ctx);
  const working = clone(healed);
  try {
    if (definition.satisfied?.(working, args, ctx)) return { healed, after: healed, noop: true };
    if (definition.sessions && ctx.user.role === "shipper") {
      for (const id of definition.sessions(args)) {
        const session = sessionOf(working, id);
        if (session && session.ownerId && session.ownerId !== ctx.user.id) throw rejected("Phiên này thuộc shipper khác.");
      }
    }
    authorize(working, codes, ctx);
    const next = definition.run(working, args, ctx);
    return { healed, after: reconcileState(next, ctx), noop: false };
  } catch (error) {
    // Domain rules throw plain Errors with a Vietnamese message; anything else (TypeError, AppError...) is a real failure.
    if (error?.rejected || error?.constructor === Error) return { healed, after: healed, noop: false, rejection: error.message };
    throw error;
  }
}

// ---- Persistence -------------------------------------------------------------------------------------------------

const hashOf = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SHEET_FIELDS = ["shipperName", "paidAmount", "remainingDue", "paymentStatus", "deliveryStatus", "note"];
const sheetKey = order => JSON.stringify(SHEET_FIELDS.map(field => order[field] ?? null));

async function resolveOwner(client, user, codes, sessionIds) {
  if (user.role === "shipper") return user.id;
  if (sessionIds.length) {
    const rows = await client.query("SELECT owner_id FROM mealfit_sessions WHERE session_id = ANY($1::text[]) LIMIT 1", [sessionIds]);
    if (rows.rows[0]) return rows.rows[0].owner_id;
  }
  if (codes.length) {
    const rows = await client.query("SELECT assigned_user_id FROM mealfit_orders WHERE code = ANY($1::text[]) AND assigned_user_id IS NOT NULL ORDER BY code LIMIT 1", [codes]);
    if (rows.rows[0]) return rows.rows[0].assigned_user_id;
  }
  return null;
}

// The status column is what queries and the unique open-session index see, so it wins over any copy inside the payload.
const sessionFromRow = row => ({ ...row.payload, id: row.payload?.id || row.session_id, status: row.status, ownerId: row.owner_id, serverRevision: Number(row.revision) });

async function loadState(client, { ownerId, codes, sessionIds }) {
  const openRows = ownerId
    ? (await client.query("SELECT * FROM mealfit_sessions WHERE owner_id = $1 AND status = ANY($2::text[]) ORDER BY session_id FOR UPDATE", [ownerId, OPEN_SESSION_STATUSES])).rows
    : [];
  const orphanCodes = ownerId
    ? (await client.query("SELECT code FROM mealfit_orders WHERE assigned_user_id = $1 AND shipping_status = 'Đang giao hàng'", [ownerId])).rows.map(row => row.code)
    : [];
  const members = openRows.flatMap(row => row.payload?.orderIds || []);
  const allCodes = [...new Set([...codes, ...members, ...orphanCodes])].sort();
  const orderRows = allCodes.length
    ? (await client.query("SELECT * FROM mealfit_orders WHERE code = ANY($1::text[]) ORDER BY code FOR UPDATE", [allCodes])).rows
    : [];
  const known = new Set(openRows.map(row => row.session_id));
  const referenced = [...new Set([...sessionIds, ...orderRows.map(row => row.session_id).filter(Boolean)])].filter(id => !known.has(id));
  const referencedRows = referenced.length
    ? (await client.query("SELECT * FROM mealfit_sessions WHERE session_id = ANY($1::text[]) ORDER BY session_id FOR UPDATE", [referenced])).rows
    : [];
  const sessionRows = [...openRows, ...referencedRows];
  return {
    rowsByCode: new Map(orderRows.map(row => [row.code, row])),
    sessionRows: new Map(sessionRows.map(row => [row.session_id, row])),
    state: {
      orders: orderRows.map(orderFromRow).filter(Boolean),
      sessions: sessionRows.filter(row => !row.payload?.deleted).map(sessionFromRow),
      activeSessionId: openRows.find(row => row.payload && !row.payload.deleted)?.session_id ?? null
    }
  };
}

async function saveOrder(client, row, order, commandId, actorId) {
  const raw = {
    ...(row.row_data || {}),
    "Mã đơn": row.code,
    "Trạng thái giao hàng": order.deliveryStatus,
    "Trạng thái đơn": order.paymentStatus,
    "Đã thanh toán": order.paidAmount,
    "TỔNG THANH TOÁN": order.remainingDue,
    "Ghi chú bởi shipper": order.note,
    Shipper: order.shipperName
  };
  const updated = await client.query(`UPDATE mealfit_orders SET
      row_data = $2::jsonb, shipper_name = $3, assigned_user_id = $4, paid_amount = $5, remaining_due = $6,
      payment_status = $7, shipping_status = $8, note = $9, maps_url = $10, session_id = $11, payments = $12::jsonb,
      delivered_at = CASE WHEN $13::double precision IS NULL THEN NULL ELSE to_timestamp($13::double precision / 1000.0) END,
      delivery_method = $14, revision = revision + 1, updated_at = now()
    WHERE code = $1 RETURNING revision`,
  [row.code, JSON.stringify(raw), order.shipperName || "Chưa phân công", order.assignedUserId ?? null, Math.round(Number(order.paidAmount) || 0), Math.round(Number(order.remainingDue) || 0),
    order.paymentStatus, order.deliveryStatus, order.note || "", order.mapsLink || "", order.sessionId || null, JSON.stringify(order.payments || []),
    order.deliveredAt ? Number(order.deliveredAt) : null, order.deliveryMethod || null]);
  const revision = Number(updated.rows[0].revision);
  const previous = Array.isArray(row.payments) ? row.payments : [];
  for (const [index, payment] of (order.payments || []).slice(previous.length).entries()) {
    await client.query(`INSERT INTO mealfit_payment_events (payment_id, order_code, session_id, actor_id, method, amount, paid_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (payment_id) DO NOTHING`,
    [`${commandId}:${row.code}:${index}`, row.code, payment.sessionId || null, actorId, payment.method, Math.round(Number(payment.amount) || 0), new Date(payment.paidAt || Date.now()).toISOString()]);
  }
  return revision;
}

async function saveSession(client, session, existing, user, ownerId, now, deleted) {
  const revision = Number(existing?.revision || 0) + 1;
  const owner = existing?.owner_id || ownerId || user.id;
  const ownerName = existing?.payload?.ownerName || (owner === user.id ? user.name : undefined);
  const payload = { ...session, ownerId: owner, ...(ownerName ? { ownerName } : {}), serverRevision: revision, ...(deleted ? { deleted: true, deletedAt: now, status: "cancelled", pausedAt: null, completedAt: session.completedAt || now } : {}) };
  await client.query(`INSERT INTO mealfit_sessions (session_id, owner_id, status, payload, revision)
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (session_id) DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload, revision = EXCLUDED.revision, updated_at = now()`,
  [session.id, owner, payload.status, JSON.stringify(payload), revision]);
  return { ...payload };
}

const entitiesFor = async (client, codes, sessionIds) => ({
  orders: codes.length ? (await client.query("SELECT * FROM mealfit_orders WHERE code = ANY($1::text[]) ORDER BY code", [codes])).rows.map(orderFromRow).filter(Boolean) : [],
  sessions: sessionIds.length ? (await client.query("SELECT * FROM mealfit_sessions WHERE session_id = ANY($1::text[]) ORDER BY session_id", [sessionIds])).rows
    .map(row => row.payload?.deleted ? { id: row.session_id, deleted: true, status: "cancelled", serverRevision: Number(row.revision) } : sessionFromRow(row)) : []
});

// Runs one command atomically. Returns { orders, sessions, noop, enqueued } or { rejection, orders, sessions } when the
// command is impossible in the current server state (any healing of stuck state is still committed).
export async function executeCommand({ user, commandId, name, args }, { transaction = withTransaction, now = () => Date.now() } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(commandId || ""))) throw invalid("Mã thao tác không hợp lệ.");
  const { codes, sessionIds, args: cleanArgs } = validateCommand(name, args, user);
  const bodyHash = hashOf({ name, args: cleanArgs });
  for (let attempt = 0; ; attempt++) {
    try {
      return await transaction(client => attemptCommand(client, { user, commandId, name, args, bodyHash, codes, sessionIds, now: now() }));
    } catch (error) {
      if (["40P01", "40001"].includes(error?.code) && attempt < 2) continue;
      if (error?.code === "55P03") throw Object.assign(new AppError(503, "COMMAND_BUSY", "Hệ thống đang xử lý thao tác khác của tài khoản này. Vui lòng thử lại."), { retryAfterSeconds: 2 });
      if (error?.code === "23505") throw new AppError(409, "COMMAND_REJECTED", "Tài khoản đã có một phiên giao hàng đang hoạt động. Bấm Đồng bộ để cập nhật.");
      throw error;
    }
  }
}

// Writes the differences between the loaded and the final state: orders, sessions, audit rows, and one Sheet outbox
// row per order whose Sheet-managed fields changed. Shared by commands and by the Sheet-import reconcile pass.
async function persistChanges(client, loaded, final, changes, { user, ownerId, now, commandId, operation }) {
  const orderCodes = [];
  const sessionKeys = [];
  let enqueued = false;
  const beforeOrders = new Map(loaded.state.orders.map(order => [order.id, order]));
  for (const order of changes.orders) {
    const row = loaded.rowsByCode.get(order.id);
    const revision = await saveOrder(client, row, order, commandId, user.id);
    orderCodes.push(order.id);
    await client.query("INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, operation_id, detail) VALUES ($1, 'order', $2, $3, $4, $5::jsonb)", [user.id, order.id, operation, commandId, JSON.stringify({ revision })]);
    if (sheetKey(beforeOrders.get(order.id)) !== sheetKey(order)) {
      const payments = order.payments || [];
      await queueUpstream(client, randomUUID(), { id: order.id, shipperName: order.shipperName, total: order.total, paidAmount: order.paidAmount, remainingDue: order.remainingDue, paymentStatus: order.paymentStatus, deliveryStatus: order.deliveryStatus, note: order.note || "", payments, paymentMethod: payments.at(-1)?.method }, revision);
      enqueued = true;
    }
  }
  const responseSessions = [];
  for (const session of changes.sessions) {
    const saved = await saveSession(client, session, loaded.sessionRows.get(session.id), user, ownerId, now, false);
    sessionKeys.push(session.id);
    responseSessions.push(saved);
    await client.query("INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, operation_id) VALUES ($1, 'session', $2, $3, $4)", [user.id, session.id, operation, commandId]);
  }
  for (const session of changes.removedSessions) {
    const saved = await saveSession(client, session, loaded.sessionRows.get(session.id), user, ownerId, now, true);
    sessionKeys.push(session.id);
    responseSessions.push({ id: session.id, deleted: true, status: "cancelled", serverRevision: saved.serverRevision });
    await client.query("INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, operation_id) VALUES ($1, 'session', $2, 'delete', $3)", [user.id, session.id, commandId]);
  }
  return { orderCodes, sessionKeys, responseSessions, enqueued };
}

// Repairs the invariants for the given shipper accounts (after a Sheet import, on the nightly cron, or from the repair
// script), under the same per-account lock the commands use. With dryRun nothing is written. Returns one report per account.
export async function reconcileAccounts(ownerIds, { transaction = withTransaction, now = () => Date.now(), dryRun = false } = {}) {
  const reports = [];
  for (const ownerId of [...new Set(ownerIds.filter(Boolean))]) {
    reports.push(await transaction(async client => {
      await client.query("SELECT set_config('lock_timeout', '5000ms', true)");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [LOCK_NAMESPACE, ownerId]);
      const loaded = await loadState(client, { ownerId, codes: [], sessionIds: [] });
      const at = now();
      const final = reconcileState(loaded.state, { now: at, ownerId });
      const changes = changedEntities(loaded.state, final);
      const before = new Map(loaded.state.sessions.map(session => [session.id, session.status]));
      const report = {
        ownerId,
        changed: Boolean(changes.orders.length || changes.sessions.length || changes.removedSessions.length),
        orders: changes.orders.map(order => ({ code: order.id, to: order.deliveryStatus })),
        sessions: changes.sessions.map(session => ({ id: session.id, from: before.get(session.id) ?? null, to: session.status }))
      };
      if (report.changed && !dryRun) {
        await persistChanges(client, loaded, final, changes, { user: { id: "system", name: "Hệ thống" }, ownerId, now: at, commandId: randomUUID(), operation: "reconcile" });
      }
      return report;
    }));
  }
  return reports;
}

async function attemptCommand(client, { user, commandId, name, args, bodyHash, codes, sessionIds, now }) {
  await client.query("SELECT set_config('lock_timeout', '5000ms', true)");
  const ownerId = await resolveOwner(client, user, codes, sessionIds);
  await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [LOCK_NAMESPACE, ownerId ?? "-"]);

  // Idempotency is checked after the lock so a retry after a timeout cannot run the command twice.
  const duplicate = await client.query("SELECT actor_id, body_hash, result FROM mealfit_operations WHERE operation_id = $1", [commandId]);
  if (duplicate.rows[0]) {
    if (duplicate.rows[0].actor_id !== user.id || duplicate.rows[0].body_hash !== bodyHash) throw new AppError(409, "IDEMPOTENCY_MISMATCH", "Mã thao tác đã được dùng cho nội dung khác.");
    const stored = duplicate.rows[0].result || {};
    return { ...(await entitiesFor(client, stored.orderCodes || [], stored.sessionIds || [])), noop: true, replayed: true, enqueued: false };
  }

  const loaded = await loadState(client, { ownerId, codes, sessionIds });
  if (user.role !== "shipper" && ownerId) {
    const moved = codes.some(code => loaded.rowsByCode.get(code) && loaded.rowsByCode.get(code).assigned_user_id !== ownerId);
    if (moved) throw new AppError(409, "COMMAND_REJECTED", "Đơn vừa được giao cho người khác. Bấm Đồng bộ để cập nhật.");
  }
  const result = runCommand(loaded.state, name, args, { user, now, ownerId });
  const final = result.after;
  const changes = changedEntities(loaded.state, final);

  const { orderCodes, sessionKeys, responseSessions, enqueued } = await persistChanges(client, loaded, final, changes, { user, ownerId, now, commandId, operation: `command:${name}` });

  // The reply carries what changed plus, for no-ops and rejections, the current truth about what the caller asked for,
  // so a stale screen is corrected by its own action. Orders are only returned to accounts allowed to see them.
  const visible = code => {
    const row = loaded.rowsByCode.get(code);
    return Boolean(row) && (user.role !== "shipper" || row.assigned_user_id === user.id || sheetShipperNames(user).some(item => nameKey(item) === nameKey(row.shipper_name)));
  };
  const requested = (result.noop || result.rejection) ? codes.filter(visible) : [];
  const fresh = await entitiesFor(client, [...new Set([...orderCodes, ...requested])], []);
  const wanted = new Set([...sessionKeys, ...(result.noop || result.rejection ? [...sessionIds, ...final.sessions.filter(item => OPEN_SESSION_STATUSES.includes(item.status)).map(item => item.id)] : [])]);
  const savedById = new Map(responseSessions.map(item => [item.id, item]));
  const sessions = [
    ...responseSessions.filter(item => item.deleted),
    ...final.sessions.filter(item => wanted.has(item.id) && !savedById.get(item.id)?.deleted).map(item => savedById.get(item.id) || item)
  ];
  if (result.rejection) return { rejection: result.rejection, orders: fresh.orders, sessions, enqueued };

  await client.query("INSERT INTO mealfit_operations (operation_id, actor_id, entity_type, entity_id, body_hash, result) VALUES ($1, $2, 'command', $3, $4, $5::jsonb)",
    [commandId, user.id, name, bodyHash, JSON.stringify({ orderCodes: fresh.orders.map(order => order.id), sessionIds: sessionKeys })]);
  return { orders: fresh.orders, sessions, noop: result.noop, enqueued };
}
