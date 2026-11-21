import { activeDuration } from "../domain.mjs";

// Pure rules that keep one shipper account's orders and delivery sessions consistent. The server runs them before and
// after every command and after every Sheet import, so every device reads the same derived status; clients never derive it.

export const OPEN_SESSION_STATUSES = ["notStarted", "active", "paused"];
export const TERMINAL_DELIVERY_STATUSES = ["Đã giao hàng", "Đã huỷ đơn"];

const isOpen = session => OPEN_SESSION_STATUSES.includes(session.status);
const isTerminal = order => TERMINAL_DELIVERY_STATUSES.includes(order.deliveryStatus);
const clone = value => structuredClone(value);
const rank = session => (session.status === "active" ? 2 : session.status === "paused" ? 1 : 0);

function closeInterval(session, at) {
  const intervals = Array.isArray(session.pauseIntervals) ? session.pauseIntervals : [];
  return session.status === "paused" && session.pausedAt
    ? [...intervals, { startedAt: session.pausedAt, resumedAt: Math.max(at, session.pausedAt) }]
    : intervals;
}

function releaseOrder(order) {
  order.deliveryStatus = "Chưa giao hàng";
  order.sessionId = null;
  order.deliveryMethod = null;
  order.deliveredAt = null;
}

function normalizeSession(session) {
  session.orderIds = Array.isArray(session.orderIds) ? session.orderIds : [];
  session.shifts = session.shifts || {};
  session.legs = session.legs || {};
  session.stopStarts = session.stopStarts || {};
  session.pauseIntervals = Array.isArray(session.pauseIntervals) ? session.pauseIntervals : [];
  session.pausedAt = session.pausedAt ?? null;
  session.completedAt = session.completedAt ?? null;
  return session;
}

function dropMember(session, order, orders) {
  session.orderIds = session.orderIds.filter(id => id !== order.id);
  delete session.shifts[order.id];
  delete session.stopStarts[order.id];
  if (!session.legs[order.id]?.completedAt) delete session.legs[order.id];
  const current = orders.get(order.id);
  if (current && current.sessionId === session.id && !isTerminal(current)) current.sessionId = null;
}

function cancelSession(session, now, orders, keeper) {
  session.pauseIntervals = closeInterval(session, now);
  session.status = "cancelled";
  session.pausedAt = null;
  session.completedAt = session.completedAt ?? now;
  for (const id of session.orderIds) {
    const order = orders.get(id);
    if (!order || isTerminal(order) || keeper?.orderIds.includes(id)) continue;
    if (order.sessionId === session.id || order.deliveryStatus === "Đang giao hàng") releaseOrder(order);
  }
}

// Returns a new state; the input is never mutated. `ownerId` is the shipper whose sessions are being reconciled
// (null for orders that belong to nobody, which only get the per-order rules).
export function reconcileState(input, { now, ownerId = null }) {
  const state = clone(input);
  const orders = new Map(state.orders.map(order => [order.id, order]));
  for (const session of state.sessions) normalizeSession(session);

  // 1. Members of every open session must still belong to it and be consistent with its status.
  for (const session of state.sessions.filter(isOpen)) {
    for (const id of [...session.orderIds]) {
      const order = orders.get(id);
      if (!order) { session.orderIds = session.orderIds.filter(item => item !== id); continue; }
      const elsewhere = ownerId && order.assignedUserId && order.assignedUserId !== ownerId && !isTerminal(order);
      const notStartedMismatch = session.status === "notStarted" && order.deliveryStatus !== "Chưa giao hàng" && order.sessionId !== session.id;
      const startedMismatch = session.status !== "notStarted" && order.deliveryStatus === "Chưa giao hàng";
      if (elsewhere || notStartedMismatch || startedMismatch) dropMember(session, order, orders);
    }
    // A stop whose order was delivered or cancelled (here or directly on the Sheet) is finished; without a leg it would
    // stay a pending stop forever because markDelivered refuses an order that is already done.
    for (const id of session.orderIds) {
      const order = orders.get(id);
      if (!isTerminal(order) || session.legs[id]?.completedAt) continue;
      const done = Object.values(session.legs).map(leg => Number(leg.completedAt) || 0);
      const completedAt = Number(order.deliveredAt) || now;
      const startedAt = session.stopStarts[id] ?? (Math.max(0, ...done) || session.startedAt || completedAt);
      session.legs[id] = { startedAt, completedAt, durationMs: activeDuration(startedAt, completedAt, session.pauseIntervals) };
      delete session.stopStarts[id];
    }
    if (session.status !== "notStarted") {
      for (const id of session.orderIds) {
        const order = orders.get(id);
        if (isTerminal(order)) continue;
        order.deliveryStatus = "Đang giao hàng";
        order.sessionId = session.id;
        order.deliveryMethod = order.deliveryMethod || "Phiên giao hàng";
      }
    }
    if (!session.orderIds.length) {
      cancelSession(session, now, orders, null);
    } else if (session.status !== "notStarted" && session.orderIds.every(id => session.legs[id]?.completedAt)) {
      const completedAt = session.completedAt ?? (Math.max(0, ...session.orderIds.map(id => Number(session.legs[id].completedAt) || 0)) || now);
      session.pauseIntervals = closeInterval(session, completedAt);
      session.status = "completed";
      session.pausedAt = null;
      session.completedAt = completedAt;
    }
  }

  // 2. An owner has at most one open session. Legacy duplicates collapse onto the most advanced, most recent one.
  const open = state.sessions.filter(isOpen)
    .sort((a, b) => rank(b) - rank(a) || (Number(b.startedAt ?? b.createdAt) || 0) - (Number(a.startedAt ?? a.createdAt) || 0));
  for (const loser of open.slice(1)) cancelSession(loser, now, orders, open[0]);
  state.activeSessionId = open[0]?.id ?? null;

  // 3. Orders left "Đang giao hàng" outside any open session are repaired from evidence, never guessed. An order with no
  // session id may be a direct (Grab/Be) delivery dispatched from the Sheet, so it is left for a person to resolve.
  if (ownerId) {
    const members = new Set(open.slice(0, 1).flatMap(session => session.orderIds));
    const sessions = new Map(state.sessions.map(session => [session.id, session]));
    for (const order of state.orders) {
      if (order.assignedUserId !== ownerId || order.deliveryStatus !== "Đang giao hàng" || members.has(order.id) || !order.sessionId) continue;
      const session = sessions.get(order.sessionId);
      const leg = session?.status === "completed" ? session.legs[order.id] : null;
      if (leg?.completedAt) {
        order.deliveryStatus = "Đã giao hàng";
        order.deliveredAt = Number(order.deliveredAt) || Number(leg.completedAt);
      } else {
        releaseOrder(order);
      }
    }
  }
  return state;
}

const ORDER_FIELDS = ["deliveryStatus", "paymentStatus", "paidAmount", "remainingDue", "note", "mapsLink", "sessionId", "payments", "deliveredAt", "deliveryMethod", "shipperName", "assignedUserId"];
const orderKey = order => JSON.stringify(ORDER_FIELDS.map(field => order[field] ?? null));
const sessionKey = session => JSON.stringify({ ...normalizeSession(clone(session)), serverRevision: undefined });

// Entities whose persisted fields differ between two states of the same account.
export function changedEntities(before, after) {
  const oldOrders = new Map(before.orders.map(order => [order.id, orderKey(order)]));
  const oldSessions = new Map(before.sessions.map(session => [session.id, sessionKey(session)]));
  const orders = after.orders.filter(order => oldOrders.get(order.id) !== orderKey(order));
  const sessions = after.sessions.filter(session => oldSessions.get(session.id) !== sessionKey(session));
  const removed = before.sessions.filter(session => !after.sessions.some(item => item.id === session.id));
  return { orders, sessions, removedSessions: removed };
}
