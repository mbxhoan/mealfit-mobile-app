import test from "node:test";
import assert from "node:assert/strict";
import {
  addOrdersToSession,
  allowedPhotoCount,
  cancelSession,
  classifyNetworkSignal,
  createSession,
  deleteSession,
  dueAmount,
  getSessionStats,
  isAssignedPendingOrder,
  isEdgeBackSwipe,
  isOrphanInTransitOrder,
  missingCriticalOrderFields,
  markDelivered,
  markPaid,
  moveOrderInSession,
  normalizeGoogleMapsLink,
  normalizeState,
  paymentsForSession,
  pauseSession,
  reorderOrderInSession,
  removeOrderFromSession,
  reopenDeliveredOrder,
  resolveOrphanDelivery,
  resumeSession,
  setOrderMapsLink,
  setOrderNote,
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

test("shipper route selection only allows assigned, not-yet-delivered orders", () => {
  const assignedPending = { assignedUserId: "hieu", deliveryStatus: "Chưa giao hàng" };
  assert.equal(isAssignedPendingOrder(assignedPending, "hieu"), true);
  assert.equal(isAssignedPendingOrder({ ...assignedPending, assignedUserId: null }, "hieu"), false);
  assert.equal(isAssignedPendingOrder({ ...assignedPending, assignedUserId: "hoan" }, "hieu"), false);
  assert.equal(isAssignedPendingOrder({ ...assignedPending, deliveryStatus: "Đang giao hàng" }, "hieu"), false);
  assert.equal(isAssignedPendingOrder(assignedPending, null), false);
});

test("unpaid status repairs stale paid amounts from a completed route", () => {
  const stale = {
    id: "A", total: 100_000, paidAmount: 100_000, remainingDue: 0,
    paymentStatus: "Chưa thanh toán", deliveryStatus: "Chưa giao hàng"
  };
  const normalized = normalizeState({ orders: [stale], sessions: [], activeSessionId: null });

  assert.equal(dueAmount(order(normalized, "A")), 100_000);
  assert.equal(order(normalized, "A").paidAmount, 0);
  assert.equal(order(normalized, "A").remainingDue, 100_000);
});

test("missing critical order fields warn without blocking route creation", () => {
  const incomplete = {
    id: "DH0001", customer: "Khách A", phone: "", address: "Quận 1", total: 100_000,
    paymentStatus: "Chưa thanh toán", deliveryStatus: "Chưa giao hàng",
    raw: { "Mã đơn": "DH0001", "Tên KH": "Khách A", "Địa chỉ": "Quận 1", "Sau giảm (đ)": 100_000 }
  };
  assert.deepEqual(missingCriticalOrderFields(incomplete), ["SĐT", "trạng thái thanh toán", "trạng thái giao hàng"]);
  assert.deepEqual(missingCriticalOrderFields({ raw: { "Mã đơn": "DH0002" }, total: 0 }), ["tên khách", "SĐT", "địa chỉ", "số tiền", "trạng thái thanh toán", "trạng thái giao hàng"]);
  const created = createSession({ ...seed(), orders: [incomplete] }, ["DH0001"], "Sáng", 1000);
  assert.equal(order(created, "DH0001").deliveryStatus, "Chưa giao hàng");
  const existingSession = createSession({ ...seed(), orders: [...seed().orders, incomplete] }, ["A"], "Sáng", 2000);
  const added = addOrdersToSession(existingSession, ["DH0001"], "Tối");
  assert.ok(session(added).orderIds.includes("DH0001"));
  assert.equal(order(added, "DH0001").deliveryStatus, "Chưa giao hàng");
});

test("network signal maps offline and weak browser readings to semantic states", () => {
  assert.equal(classifyNetworkSignal(false, { effectiveType: "4g" }), "offline");
  assert.equal(classifyNetworkSignal(true, { type: "none" }), "offline");
  assert.equal(classifyNetworkSignal(true, { effectiveType: "2g" }), "weak");
  assert.equal(classifyNetworkSignal(true, { downlink: 1 }), "weak");
  assert.equal(classifyNetworkSignal(true, { rtt: 700 }), "weak");
  assert.equal(classifyNetworkSignal(true, { effectiveType: "4g", downlink: 20, rtt: 40 }), "stable");
  assert.equal(classifyNetworkSignal(true), "stable");
});

test("edge back swipe requires a long inward horizontal gesture", () => {
  assert.equal(isEdgeBackSwipe({ x: 5, y: 100 }, { x: 100, y: 110 }, 390), true);
  assert.equal(isEdgeBackSwipe({ x: 385, y: 100 }, { x: 290, y: 110 }, 390), true);
  assert.equal(isEdgeBackSwipe({ x: 5, y: 100 }, { x: 100, y: 200 }, 390), false);
  assert.equal(isEdgeBackSwipe({ x: 5, y: 100 }, { x: 70, y: 100 }, 390), false);
  assert.equal(isEdgeBackSwipe({ x: 80, y: 100 }, { x: 180, y: 100 }, 390), false);
  assert.equal(isEdgeBackSwipe({ x: 5, y: 100 }, { x: 100, y: 100 }, 390), true);
});

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

test("payment sync records the collected remainder instead of the order value", () => {
  const unpaid = {
    id: "DH0924", total: 658_000, paidAmount: 0, remainingDue: 563_050,
    paymentStatus: "Chưa thanh toán", deliveryStatus: "Đang giao hàng", sessionId: null, payments: []
  };
  const next = markPaid({ orders: [unpaid], sessions: [], activeSessionId: null }, unpaid.id, "Tiền mặt", 1000);

  assert.equal(order(next, unpaid.id).paidAmount, 563_050);
  assert.equal(order(next, unpaid.id).payments[0].amount, 563_050);
});

test("a stale delivery from a completed session can be resolved without changing its payment record", () => {
  const initial = seed();
  const unpaid = initial.orders[0];
  unpaid.paymentStatus = "Chưa thanh toán";
  unpaid.assignedUserId = "hieu";
  let state = startSession(createSession(initial, [unpaid.id], { [unpaid.id]: "Sáng" }, 1000), 2000);
  state = markPaid(state, unpaid.id, "Tiền mặt", 3000);
  assert.equal(isOrphanInTransitOrder(state, order(state, unpaid.id), "hieu"), false);

  const completed = {
    ...state,
    activeSessionId: null,
    sessions: state.sessions.map(item => ({ ...item, status: "completed", completedAt: 4000 }))
  };
  assert.equal(isOrphanInTransitOrder(completed, order(completed, unpaid.id), "hieu"), true);

  const resolved = resolveOrphanDelivery(completed, unpaid.id, "hieu", "Đã giao hàng", 5000);
  assert.equal(order(resolved, unpaid.id).deliveryStatus, "Đã giao hàng");
  assert.deepEqual(order(resolved, unpaid.id).payments, order(completed, unpaid.id).payments);
  assert.equal(session(resolved).legs[unpaid.id].completedAt, 5000);
  assert.deepEqual(
    [getSessionStats(resolved, session(resolved).id).cashCollected, getSessionStats(resolved, session(resolved).id).transferCollected, getSessionStats(resolved, session(resolved).id).remainingCount],
    [100_000, 0, 0]
  );
});

test("an active route can collect and deliver a later stop in another shift", () => {
  let state = startSession(createSession(seed(), ["A", "B"], { A: "Sáng", B: "Tối" }, 1000), 2000);
  state = markPaid(state, "B", "Chuyển khoản", 3000);
  state = markDelivered(state, "B", 7000);
  assert.equal(order(state, "B").deliveryStatus, "Đã giao hàng");
  assert.equal(order(state, "B").payments.at(-1).sessionId, session(state).id);
  assert.equal(session(state).legs.B.durationMs, 5000);

  state = markDelivered(state, "A", 9000);
  assert.equal(order(state, "A").deliveryStatus, "Đã giao hàng");
  assert.equal(session(state).legs.A.startedAt, 7000);
  assert.equal(session(state).legs.A.durationMs, 2000);
  assert.equal(session(state).status, "completed");
});

test("new session groups stops by shift and keeps route edits inside each shift", () => {
  let state = createSession(seed(), ["B", "A"], { A: "Sáng", B: "Chiều" }, 1000);
  assert.equal(session(state).status, "notStarted");
  assert.equal(order(state, "A").deliveryStatus, "Chưa giao hàng");
  assert.equal(order(state, "A").sessionId, null);
  state = addOrdersToSession(state, ["C"], "Tối");
  assert.equal(order(state, "C").deliveryStatus, "Chưa giao hàng");
  state = moveOrderInSession(state, "C", -1);
  assert.deepEqual(session(state).orderIds, ["A", "B", "C"]);
  assert.equal(session(state).shifts.C, "Tối");
  state = setSessionOrderShift(state, "A", "Tối");
  assert.deepEqual(session(state).orderIds, ["B", "C", "A"]);
  state = setSessionOrderShift(state, "C", "Chiều");
  assert.equal(session(state).shifts.C, "Chiều");
  assert.deepEqual(session(state).orderIds, ["B", "C", "A"]);
  assert.throws(() => reorderOrderInSession(state, "C", 2), /cùng một ca/);
  state = removeOrderFromSession(state, "B");
  assert.equal(order(state, "B").deliveryStatus, "Chưa giao hàng");
  state = startSession(state, 2000);
  assert.equal(session(state).status, "active");
  assert.equal(order(state, "A").deliveryStatus, "Đang giao hàng");
  assert.equal(order(state, "A").sessionId, session(state).id);
  assert.equal(order(state, "C").deliveryStatus, "Đang giao hàng");
  assert.throws(() => startSession(state, 3000), /Phiên này đã bắt đầu/);
  assert.throws(() => createSession(state, ["B"], { B: "Sáng" }, 3000), /Đã có một phiên/);
  state = addOrdersToSession(state, ["B"], "Sáng");
  assert.equal(order(state, "B").deliveryStatus, "Đang giao hàng");
  assert.deepEqual(session(state).orderIds, ["B", "C", "A"]);
});

test("session creation and adding orders save, update, and clear delivery notes and map links", () => {
  const initial = seed();
  initial.orders.find(item => item.id === "B").note = "Ghi chú cũ";
  initial.orders.find(item => item.id === "C").note = "Ghi chú cần xóa";
  let state = createSession(initial, ["A"], { A: "Sáng" }, 1000, { A: "Giao trước 10:00" }, { A: "https://maps.app.goo.gl/mealfit-a" });
  assert.equal(order(state, "A").note, "Giao trước 10:00");
  assert.equal(order(state, "A").mapsLink, "https://maps.app.goo.gl/mealfit-a");
  state = addOrdersToSession(state, ["B"], "Chiều", { B: "Gọi trước khi đến" }, { B: "https://www.google.com/maps/search/?api=1&query=10%20Nguyen%20Hue" });
  assert.equal(order(state, "B").note, "Gọi trước khi đến");
  assert.equal(order(state, "B").mapsLink, "https://www.google.com/maps/search/?api=1&query=10%20Nguyen%20Hue");
  state = addOrdersToSession(state, ["C"], "Tối", { C: "" }, { C: "" });
  assert.equal(order(state, "C").note, "");
  assert.equal(order(state, "C").mapsLink, "");
});

test("order notes can be edited and removed from an active order", () => {
  let state = setOrderNote(seed(), "A", "  Gọi trước khi đến  ");
  assert.equal(order(state, "A").note, "Gọi trước khi đến");
  state = setOrderNote(state, "A", "");
  assert.equal(order(state, "A").note, "");
});

test("Google Maps links accept supported destinations and reject unsafe or unrelated URLs", () => {
  assert.equal(normalizeGoogleMapsLink("  https://maps.app.goo.gl/abc  "), "https://maps.app.goo.gl/abc");
  assert.equal(normalizeGoogleMapsLink("https://www.google.com/maps/place/Mealfit"), "https://www.google.com/maps/place/Mealfit");
  assert.equal(normalizeGoogleMapsLink(""), "");
  assert.throws(() => normalizeGoogleMapsLink("javascript:alert(1)"), /Google Maps/);
  assert.throws(() => normalizeGoogleMapsLink("https://example.com/maps"), /Google Maps/);
  assert.throws(() => normalizeGoogleMapsLink("https://google.com:8080/maps"), /Google Maps/);
  assert.throws(() => createSession(seed(), ["A"], { A: "Sáng" }, 1000, {}, { A: "https://example.com/maps" }), /Google Maps/);

  let state = setOrderMapsLink(seed(), "A", "https://maps.app.goo.gl/abc");
  assert.equal(order(state, "A").mapsLink, "https://maps.app.goo.gl/abc");
  state = setOrderMapsLink(state, "A", "");
  assert.equal(order(state, "A").mapsLink, "");
  assert.throws(() => setOrderMapsLink(state, "missing", ""), /Không tìm thấy/);
});

test("route reordering stays within a shift and cannot cross completed stops", () => {
  let state = createSession(seed(), ["A", "B", "C"], { A: "Sáng", B: "Sáng", C: "Sáng" }, 1000);
  state = reorderOrderInSession(state, "C", 0);
  assert.deepEqual(session(state).orderIds, ["C", "A", "B"]);
  state = startSession(state, 2000);
  state = markDelivered(state, "C", 3000);
  const unchanged = reorderOrderInSession(state, "B", 0);
  assert.equal(unchanged, state);
  assert.throws(() => reorderOrderInSession(state, "C", 2), /điểm đã giao/);
  state = reorderOrderInSession(state, "B", 1);
  assert.deepEqual(session(state).orderIds, ["C", "B", "A"]);
});

test("legacy route normalization preserves completed history and sorts the open stops by shift", () => {
  const state = seed();
  state.sessions = [{ id: "old", status: "active", orderIds: ["A", "B", "C"], shifts: { A: "Sáng", B: "Tối", C: "Chiều" }, legs: { A: { completedAt: 1500 } } }];
  state.activeSessionId = "old";
  assert.deepEqual(normalizeState(state).sessions[0].orderIds, ["A", "C", "B"]);
});

test("pause locks delivery edits and excludes paused time from route legs", () => {
  let state = startSession(createSession(seed(), ["A", "B"], { A: "Sáng", B: "Sáng" }, 1000), 2000);
  state = pauseSession(state, 12_000);
  assert.equal(session(state).status, "paused");
  assert.throws(() => markPaid(state, "A", "Tiền mặt", 13_000));
  assert.throws(() => addOrdersToSession(state, ["C"], "Sáng"));
  assert.throws(() => reorderOrderInSession(state, "B", 0));
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

test("deleting a started session removes the route and resets only in-progress orders", () => {
  let state = startSession(createSession(seed(), ["A", "B", "C"], { A: "Sáng", B: "Chiều", C: "Tối" }, 1000), 2000);
  state = markPaid(state, "A", "Tiền mặt", 2500);
  state = markDelivered(state, "A", 3000);
  state = { ...state, orders: state.orders.map(item => item.id === "C" ? { ...item, deliveryStatus: "Đã huỷ đơn" } : item) };
  const sessionId = state.activeSessionId;
  const deleted = deleteSession(state, sessionId);

  assert.equal(deleted.activeSessionId, null);
  assert.equal(deleted.sessions.some(item => item.id === sessionId), false);
  assert.equal(order(deleted, "A").deliveryStatus, "Đã giao hàng");
  assert.equal(order(deleted, "A").paidAmount, 100_000);
  assert.equal(order(deleted, "B").deliveryStatus, "Chưa giao hàng");
  assert.equal(order(deleted, "C").deliveryStatus, "Đã huỷ đơn");
  assert.equal(order(deleted, "A").sessionId, null);
  assert.equal(order(deleted, "B").sessionId, null);
  assert.equal(order(deleted, "C").sessionId, null);
});

test("deleting a session clears stale route fields on every unfinished stop", () => {
  const state = createSession(seed(), ["B"], { B: "Sáng" }, 1000);
  const sessionId = state.activeSessionId;
  const withStaleRouteFields = {
    ...state,
    orders: state.orders.map(item => item.id === "B"
      ? { ...item, deliveryStatus: "Chưa giao hàng", deliveryMethod: "Phiên giao hàng", sessionId, deliveredAt: 2000 }
      : item)
  };

  const deleted = deleteSession(withStaleRouteFields, sessionId);
  assert.equal(order(deleted, "B").deliveryStatus, "Chưa giao hàng");
  assert.equal(order(deleted, "B").deliveryMethod, null);
  assert.equal(order(deleted, "B").sessionId, null);
  assert.equal(order(deleted, "B").deliveredAt, null);
});

test("route stats count session cash and transfer collections, route value and completed shifts", () => {
  let state = createSession(seed(), ["A", "B"], { A: "Sáng", B: "Chiều" }, 1000);
  const beforeStart = getSessionStats(state, session(state).id);
  assert.equal(beforeStart.cashCollected, 0);
  assert.equal(beforeStart.transferCollected, 0);
  assert.equal(beforeStart.amountToCollect, 180_000);
  state = startSession(state, 2000);
  state = markPaid(state, "A", "Tiền mặt", 3000);
  state = markDelivered(state, "A", 4000);
  state = markPaid(state, "B", "Chuyển khoản", 5000);
  state = markDelivered(state, "B", 6000);
  const stats = getSessionStats(state, session(state).id);
  assert.equal(stats.cashCollected, 100_000);
  assert.equal(stats.transferCollected, 80_000);
  assert.equal(stats.remainingCount, 0);
  assert.equal(stats.totalValue, 200_000);
  assert.equal(stats.amountToCollect, 0);
  assert.deepEqual(stats.shifts.map(item => item.done), [true, true]);
});

test("session totals keep recorded collections when an order is removed and exclude pre-session payments", () => {
  let state = startSession(createSession(seed(), ["A", "B"], { A: "Sáng", B: "Chiều" }, 1000), 2000);
  const sessionId = session(state).id;
  state = markPaid(state, "A", "Tiền mặt", 3000);
  state = markPaid(state, "B", "Chuyển khoản", 4000);
  state = removeOrderFromSession(state, "A");

  const stats = getSessionStats(state, sessionId);
  assert.equal(stats.cashCollected, 100_000);
  assert.equal(stats.transferCollected, 80_000);
  assert.equal(paymentsForSession(order(state, "A"), sessionId).length, 1);
  assert.equal(paymentsForSession(order(state, "B"), sessionId).length, 1);
});

test("delivered session orders can re-enter the active route or reopen their completed route", () => {
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

  const reopened = reopenDeliveredOrder(second, "A", "Chưa giao hàng", "Tối", 10_000);
  assert.equal(order(reopened, "A").deliveryStatus, "Đang giao hàng");
  assert.equal(order(reopened, "A").sessionId, active.id);
  assert.equal(order(reopened, "A").paidAmount, 100_000);
  assert.deepEqual(reopened.sessions.find(item => item.id === active.id).orderIds, ["B", "A"]);
  assert.equal(reopened.activeSessionId, active.id);
});

test("returning a delivered order to pending readds it at the end of its shift in the current route", () => {
  let state = startSession(createSession(seed(), ["A", "B", "C"], { A: "Sáng", B: "Sáng", C: "Sáng" }, 1000), 2000);
  state = markDelivered(state, "B", 3000);
  state = reopenDeliveredOrder(state, "B", "Chưa giao hàng", "Sáng", 4000);

  assert.deepEqual(session(state).orderIds, ["A", "C", "B"]);
  assert.equal(order(state, "B").deliveryStatus, "Đang giao hàng");
  assert.equal(order(state, "B").sessionId, session(state).id);
  assert.equal(session(state).legs.B, undefined);
  assert.equal(session(state).stopStarts.B, 4000);
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
  assert.equal(order(state, "A").sessionId, null);
  assert.equal(order(state, "A").deliveryStatus, "Chưa giao hàng");
  state = startSession(state, 5000);
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
