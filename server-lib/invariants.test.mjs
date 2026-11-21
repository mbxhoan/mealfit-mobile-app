import assert from "node:assert/strict";
import test from "node:test";
import { changedEntities, reconcileState } from "./invariants.mjs";

const NOW = 1_000_000;
const order = (id, deliveryStatus, extra = {}) => ({ id, deliveryStatus, paymentStatus: "Chưa thanh toán", assignedUserId: "hoan", sessionId: null, deliveryMethod: null, deliveredAt: null, payments: [], ...extra });
const session = (id, status, orderIds, extra = {}) => ({
  id, status, orderIds, shifts: Object.fromEntries(orderIds.map(code => [code, "Sáng"])), createdAt: 1, startedAt: status === "notStarted" ? null : 10,
  legs: {}, stopStarts: {}, pauseIntervals: [], pausedAt: null, completedAt: null, ...extra
});
const run = (state, extra = {}) => reconcileState({ activeSessionId: null, ...state }, { now: NOW, ownerId: "hoan", ...extra });
const find = (state, id) => state.orders.find(item => item.id === id);

test("a session whose every order is delivered or cancelled completes and gets a leg per stop", () => {
  const result = run({
    orders: [order("A", "Đã giao hàng", { sessionId: "PS-1", deliveredAt: 500 }), order("B", "Đã huỷ đơn", { sessionId: "PS-1" })],
    sessions: [session("PS-1", "active", ["A", "B"])]
  });
  const [closed] = result.sessions;
  assert.equal(closed.status, "completed");
  assert.equal(closed.legs.A.completedAt, 500);
  assert.equal(closed.legs.B.completedAt, NOW);
  assert.equal(closed.completedAt, NOW);
  assert.equal(result.activeSessionId, null);
});

test("a stuck session no longer blocks a new one: completed sessions are not open", () => {
  const stuck = run({ orders: [order("A", "Đã giao hàng", { deliveredAt: 5 })], sessions: [session("PS-1", "paused", ["A"], { pausedAt: 20 })] });
  assert.equal(stuck.sessions[0].status, "completed");
  assert.equal(stuck.sessions[0].pausedAt, null);
  assert.deepEqual(stuck.sessions[0].pauseIntervals, [{ startedAt: 20, resumedAt: 20 }]);
  assert.equal(stuck.activeSessionId, null);
});

test("an open session with no orders left is cancelled", () => {
  const result = run({ orders: [], sessions: [session("PS-1", "notStarted", [])] });
  assert.equal(result.sessions[0].status, "cancelled");
  assert.equal(result.activeSessionId, null);
});

test("a started session keeps unfinished orders in transit and stays open", () => {
  const result = run({
    orders: [order("A", "Đã giao hàng", { deliveredAt: 5 }), order("B", "Đang giao hàng", { sessionId: "PS-1" })],
    sessions: [session("PS-1", "active", ["A", "B"])]
  });
  assert.equal(result.sessions[0].status, "active");
  assert.equal(result.activeSessionId, "PS-1");
  assert.equal(find(result, "B").deliveryStatus, "Đang giao hàng");
});

test("an order reset to Chưa giao hàng on the Sheet leaves a started session instead of hanging in it", () => {
  const result = run({
    orders: [order("A", "Chưa giao hàng", { sessionId: "PS-1" }), order("B", "Đang giao hàng", { sessionId: "PS-1" })],
    sessions: [session("PS-1", "active", ["A", "B"])]
  });
  assert.deepEqual(result.sessions[0].orderIds, ["B"]);
  assert.equal(find(result, "A").sessionId, null);
});

test("duplicate open sessions collapse onto the most advanced one and release the loser's open orders", () => {
  const result = run({
    orders: [order("A", "Đang giao hàng", { sessionId: "PS-1" }), order("B", "Chưa giao hàng"), order("C", "Đang giao hàng", { sessionId: "PS-1" })],
    sessions: [session("PS-2", "notStarted", ["B"], { createdAt: 99 }), session("PS-1", "active", ["A", "C"])]
  });
  assert.equal(result.activeSessionId, "PS-1");
  assert.equal(result.sessions.find(item => item.id === "PS-2").status, "cancelled");
  assert.equal(result.sessions.filter(item => ["notStarted", "active", "paused"].includes(item.status)).length, 1);
  assert.equal(find(result, "A").deliveryStatus, "Đang giao hàng");
});

test("orphans are repaired from session evidence only", () => {
  const result = run({
    orders: [
      order("DONE", "Đang giao hàng", { sessionId: "PS-OLD" }),
      order("GONE", "Đang giao hàng", { sessionId: "PS-CANCELLED" }),
      order("MISSING", "Đang giao hàng", { sessionId: "PS-UNKNOWN" }),
      order("DIRECT", "Đang giao hàng", { sessionId: null })
    ],
    sessions: [
      session("PS-OLD", "completed", ["DONE"], { legs: { DONE: { startedAt: 1, completedAt: 700, durationMs: 699 } }, completedAt: 700 }),
      session("PS-CANCELLED", "cancelled", ["GONE"])
    ]
  });
  assert.equal(find(result, "DONE").deliveryStatus, "Đã giao hàng");
  assert.equal(find(result, "DONE").deliveredAt, 700);
  assert.equal(find(result, "GONE").deliveryStatus, "Chưa giao hàng");
  assert.equal(find(result, "MISSING").deliveryStatus, "Chưa giao hàng");
  assert.equal(find(result, "DIRECT").deliveryStatus, "Đang giao hàng");
});

test("orphan repair only touches the account that is being reconciled", () => {
  const result = run({ orders: [order("X", "Đang giao hàng", { sessionId: "PS-UNKNOWN", assignedUserId: "hieu" })], sessions: [] });
  assert.equal(find(result, "X").deliveryStatus, "Đang giao hàng");
});

test("reconcile never mutates its input and changedEntities reports only real differences", () => {
  const before = {
    activeSessionId: "PS-1",
    orders: [order("A", "Đã giao hàng", { deliveredAt: 5, sessionId: "PS-1" }), order("Z", "Chưa giao hàng")],
    sessions: [session("PS-1", "active", ["A"])]
  };
  const snapshot = structuredClone(before);
  const after = run(before);
  assert.deepEqual(before, snapshot);
  const changes = changedEntities(before, after);
  assert.deepEqual(changes.orders, []);
  assert.deepEqual(changes.sessions.map(item => item.id), ["PS-1"]);
  assert.deepEqual(changedEntities(after, run(after)), { orders: [], sessions: [], removedSessions: [] });
});
