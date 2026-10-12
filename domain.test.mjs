import test from "node:test";
import assert from "node:assert/strict";
import {
  addOrdersToSession,
  allowedPhotoCount,
  cancelSession,
  createSession,
  dueAmount,
  getSessionStats,
  markDelivered,
  markPaid,
  moveOrderInSession,
  normalizeState,
  pauseSession,
  removeOrderFromSession,
  reopenDeliveredOrder,
  resumeSession,
  setSessionOrderShift,
  startSession,
  startSingleDelivery
} from "./domain.mjs";

const seed = () => ({
  activeSessionId: null,
  sessions: [],
  orders: ["A", "B", "C"].map((id, index) => ({
    id, subtotal: 100_000, shippingFee: 0, total: 100_000, paidAmount: index === 1 ? 20_000 : 0,
    payments: index === 1 ? [{ method: "Tiền mặt", amount: 20_000, paidAt: 500 }] : [],
    deliveryStatus: "Chưa giao hàng", deliveryMethod: null, sessionId: null
  }))
});

const order = (state, id) => state.orders.find(item => item.id === id);
const session = state => state.sessions[0];

test("single delivery validates input and records actual shipping fee", () => {
  const next = startSingleDelivery(seed(), "A", "Grab", 25_000);
  assert.equal(order(next, "A").deliveryStatus, "Đang giao hàng");
  assert.equal(order(next, "A").total, 125_000);
  assert.throws(() => startSingleDelivery(next, "A", "Grab", 0));
  assert.throws(() => startSingleDelivery(seed(), "A", "Grab", -1));
});

test("payment records only the remainder and tags collections made in an active route", () => {
  const state = seed();
  assert.equal(dueAmount(order(state, "B")), 80_000);
  const beforeSession = markPaid(state, "B", "Chuyển khoản", 1000);
  assert.equal(order(beforeSession, "B").payments[1].sessionId, undefined);
  assert.throws(() => markPaid(beforeSession, "B", "Tiền mặt"));

  let route = startSession(createSession(state, ["A", "B"], { A: "Sáng", B: "Chiều" }, 1000), 2000);
  route = markPaid(route, "A", "Tiền mặt", 3000);
  route = markDelivered(route, "A", 4000);
  route = markPaid(route, "B", "Chuyển khoản", 5000);
  assert.equal(dueAmount(order(route, "B")), 0);
  assert.equal(order(route, "B").payments.at(-1).amount, 80_000);
  assert.equal(order(route, "B").payments.at(-1).sessionId, session(route).id);
});

test("new session starts as unstarted, supports per-stop shifts and route edits", () => {
  let state = createSession(seed(), ["A", "B"], { A: "Sáng", B: "Chiều" }, 1000);
  assert.equal(session(state).status, "notStarted");
  assert.equal(order(state, "A").deliveryStatus, "Đang giao hàng");
  state = addOrdersToSession(state, ["C"], "Tối");
  state = moveOrderInSession(state, "C", -1);
  assert.deepEqual(session(state).orderIds, ["A", "C", "B"]);
  assert.equal(session(state).shifts.C, "Tối");
  state = setSessionOrderShift(state, "C", "Chiều");
  assert.equal(session(state).shifts.C, "Chiều");
  state = removeOrderFromSession(state, "B");
  assert.equal(order(state, "B").deliveryStatus, "Chưa giao hàng");
  state = startSession(state, 2000);
  assert.equal(session(state).status, "active");
  assert.throws(() => startSession(state, 3000), /Phiên này đã bắt đầu/);
  assert.throws(() => createSession(state, ["B"], { B: "Sáng" }, 3000), /Đã có một phiên/);
  state = addOrdersToSession(state, ["B"], "Sáng");
  assert.equal(order(state, "B").deliveryStatus, "Đang giao hàng");
});

test("pause locks delivery edits and excludes paused time from route legs", () => {
  let state = startSession(createSession(seed(), ["A", "B"], { A: "Sáng", B: "Sáng" }, 1000), 2000);
  state = pauseSession(state, 12_000);
  assert.equal(session(state).status, "paused");
  assert.throws(() => markPaid(state, "A", "Tiền mặt", 13_000));
  assert.throws(() => addOrdersToSession(state, ["C"], "Sáng"));
  assert.throws(() => markDelivered(state, "A", 13_000));
  state = resumeSession(state, 42_000);
  state = markDelivered(state, "A", 52_000);
  assert.equal(session(state).legs.A.durationMs, 20_000);
  assert.deepEqual(session(state).pauseIntervals, [{ startedAt: 12_000, resumedAt: 42_000 }]);
});

test("cancel returns unfinished orders to pending and keeps completed stops", () => {
  let state = startSession(createSession(seed(), ["A", "B"], { A: "Sáng", B: "Chiều" }, 1000), 2000);
  state = markDelivered(state, "A", 3000);
  state = cancelSession(state, 4000);
  assert.equal(session(state).status, "cancelled");
  assert.equal(state.activeSessionId, null);
  assert.equal(order(state, "A").deliveryStatus, "Đã giao hàng");
  assert.equal(order(state, "B").deliveryStatus, "Chưa giao hàng");
  assert.equal(getSessionStats(state, session(state).id).remainingCount, 0);
});

test("route stats count session cash and transfer collections, route value and completed shifts", () => {
  let state = startSession(createSession(seed(), ["A", "B"], { A: "Sáng", B: "Chiều" }, 1000), 2000);
  state = markPaid(state, "A", "Tiền mặt", 3000);
  state = markDelivered(state, "A", 4000);
  state = markPaid(state, "B", "Chuyển khoản", 5000);
  state = markDelivered(state, "B", 6000);
  const stats = getSessionStats(state, session(state).id);
  assert.equal(stats.cashCollected, 100_000);
  assert.equal(stats.transferCollected, 80_000);
  assert.equal(stats.remainingCount, 0);
  assert.equal(stats.totalValue, 200_000);
  assert.deepEqual(stats.shifts.map(item => item.done), [true, true]);
});

test("delivered session orders can re-enter the active route or return to pending", () => {
  let state = startSession(createSession(seed(), ["A"], { A: "Sáng" }, 1000), 2000);
  state = markPaid(state, "A", "Tiền mặt", 3000);
  state = markDelivered(state, "A", 4000);
  let second = startSession(createSession(state, ["B"], { B: "Chiều" }, 5000), 6000);
  second = reopenDeliveredOrder(second, "A", "Đang giao hàng", "Tối", 7000);
  const active = second.sessions.find(item => item.id === second.activeSessionId);
  assert.deepEqual(active.orderIds, ["B", "A"]);
  assert.equal(order(second, "A").sessionId, active.id);
  assert.equal(order(second, "A").paidAmount, 100_000);
  assert.equal(order(second, "A").deliveredAt, null);
  assert.equal(active.shifts.A, "Tối");

  second = markDelivered(second, "B", 8000);
  second = markDelivered(second, "A", 9000);
  assert.equal(order(second, "A").deliveryStatus, "Đã giao hàng");

  const pending = reopenDeliveredOrder(second, "A", "Chưa giao hàng", null, 10_000);
  assert.equal(order(pending, "A").deliveryStatus, "Chưa giao hàng");
  assert.equal(order(pending, "A").sessionId, null);
  assert.equal(order(pending, "A").paidAmount, 100_000);
  assert.equal(pending.sessions.find(item => item.id === active.id).orderIds.includes("A"), false);
});

test("reopening an old stop in a new route keeps its completed history intact", () => {
  let state = startSession(createSession(seed(), ["A"], { A: "Sáng" }, 1000), 2000);
  state = markPaid(state, "A", "Tiền mặt", 3000);
  state = markDelivered(state, "A", 4000);
  const oldSessionId = session(state).id;
  state = startSession(createSession(state, ["B"], { B: "Chiều" }, 5000), 6000);
  state = reopenDeliveredOrder(state, "A", "Đang giao hàng", "Tối", 7000);

  const oldStats = getSessionStats(state, oldSessionId);
  assert.equal(oldStats.remainingCount, 0);
  assert.equal(oldStats.shifts[0].done, true);
  assert.equal(oldStats.cashCollected, 100_000);
});

test("reopening a completed session resumes that route when no route is active", () => {
  let state = startSession(createSession(seed(), ["A"], { A: "Sáng" }, 1000), 2000);
  state = markDelivered(state, "A", 3000);
  state = reopenDeliveredOrder(state, "A", "Đang giao hàng", "Chiều", 4000);
  assert.equal(state.activeSessionId, session(state).id);
  assert.equal(session(state).status, "active");
  assert.equal(session(state).stopStarts.A, 4000);
  state = markDelivered(state, "A", 9000);
  assert.equal(session(state).legs.A.durationMs, 5000);
});

test("removing and readding a reopened stop clears its old timer", () => {
  let state = startSession(createSession(seed(), ["A"], { A: "Sáng" }, 1000), 2000);
  state = markDelivered(state, "A", 3000);
  state = startSession(createSession(state, ["B"], { B: "Chiều" }, 5000), 6000);
  state = reopenDeliveredOrder(state, "A", "Đang giao hàng", "Tối", 7000);
  const active = state.sessions.find(item => item.id === state.activeSessionId);
  assert.equal(active.stopStarts.A, 7000);
  state = removeOrderFromSession(state, "A");
  assert.equal(state.sessions.find(item => item.id === state.activeSessionId).stopStarts.A, undefined);
  state = addOrdersToSession(state, ["A"], "Tối");
  assert.equal(state.sessions.find(item => item.id === state.activeSessionId).stopStarts.A, undefined);
});

test("reopening a standalone delivered order creates a one-stop session", () => {
  let state = seed();
  state = startSingleDelivery(state, "A", "Grab", 10_000);
  state = markDelivered(state, "A", 3000);
  state = reopenDeliveredOrder(state, "A", "Đang giao hàng", "Tối", 4000);
  assert.equal(session(state).status, "notStarted");
  assert.equal(session(state).shifts.A, "Tối");
  assert.equal(order(state, "A").sessionId, session(state).id);
  assert.equal(order(state, "A").deliveryStatus, "Đang giao hàng");
});

test("legacy sessions normalize without discarding orders or route progress", () => {
  const legacy = seed();
  legacy.activeSessionId = "old";
  legacy.sessions = [{ id: "old", status: "active", orderIds: ["A"], startedAt: 1000, legs: {} }];
  const migrated = normalizeState(legacy);
  assert.equal(migrated.activeSessionId, "old");
  assert.deepEqual(migrated.sessions[0].shifts, {});
  assert.deepEqual(migrated.sessions[0].pauseIntervals, []);
  assert.equal(order(migrated, "A").deliveryStatus, "Chưa giao hàng");
  const unstarted = normalizeState({ ...legacy, sessions: [{ id: "old", status: "notStarted", orderIds: ["A"] }] });
  assert.throws(() => startSession(unstarted), /Phân ca cho tất cả đơn/);
  assert.equal(setSessionOrderShift(unstarted, "A", "Sáng").sessions[0].shifts.A, "Sáng");
});

test("photo selection never allows more than five saved photos per order", () => {
  assert.equal(allowedPhotoCount(0, 8), 5);
  assert.equal(allowedPhotoCount(4, 3), 1);
  assert.equal(allowedPhotoCount(5, 1), 0);
});
