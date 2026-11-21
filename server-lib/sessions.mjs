import { getSql } from "./db.mjs";

const TERMINAL_STATUSES = ["Đã giao hàng", "Đã huỷ đơn"];
const OPEN = ["active", "paused"];

// A session whose every order is already delivered/cancelled on the server is finished, whatever a device last
// stored. Deriving that here gives every device the same status instead of each one inferring it from its own cache.
export function closeFinishedSessions(sessions, statusByCode) {
  return sessions.map(session => {
    const orderIds = Array.isArray(session.orderIds) ? session.orderIds : [];
    if (session.syncConflict || !OPEN.includes(session.status) || !orderIds.length) return session;
    if (!orderIds.every(code => TERMINAL_STATUSES.includes(statusByCode.get(code)))) return session;
    const legTimes = orderIds.map(code => Number(session.legs?.[code]?.completedAt) || 0);
    const completedAt = session.completedAt ?? (Math.max(0, ...legTimes) || session.startedAt || session.createdAt || null);
    const pauseIntervals = Array.isArray(session.pauseIntervals) ? session.pauseIntervals : [];
    return {
      ...session,
      status: "completed",
      pausedAt: null,
      completedAt,
      pauseIntervals: session.status === "paused" && session.pausedAt
        ? [...pauseIntervals, { startedAt: session.pausedAt, resumedAt: Math.max(Number(completedAt) || 0, session.pausedAt) }]
        : pauseIntervals
    };
  });
}

export async function withFinishedSessionsClosed(sessions) {
  const codes = [...new Set(sessions.filter(session => OPEN.includes(session.status)).flatMap(session => session.orderIds || []).map(String))];
  if (!codes.length) return sessions;
  const rows = await getSql()`SELECT code, shipping_status FROM mealfit_orders WHERE code = ANY(${codes}::text[])`;
  return closeFinishedSessions(sessions, new Map(rows.map(row => [row.code, row.shipping_status])));
}
