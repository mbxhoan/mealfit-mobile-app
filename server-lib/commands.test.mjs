import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "./core.mjs";
import { runCommand, validateCommand } from "./commands.mjs";

const NOW = 5_000_000;
const hoan = { id: "hoan", name: "Hoàn", role: "shipper", shipperNames: ["Hoàn"] };
const staff = { id: "admin", name: "Admin", role: "admin" };
const ctx = (user = hoan, ownerId = user.id) => ({ user, now: NOW, ownerId });

const order = (id, deliveryStatus = "Chưa giao hàng", extra = {}) => ({
  id, customer: `KH ${id}`, deliveryStatus, paymentStatus: "Chưa thanh toán", total: 100_000, subtotal: 100_000, paidAmount: 0, remainingDue: 100_000,
  payments: [], assignedUserId: "hoan", shipperName: "Hoàn", note: "", mapsLink: "", sessionId: null, deliveryMethod: null, deliveredAt: null, ...extra
});
const session = (id, status, orderIds, extra = {}) => ({
  id, status, orderIds, ownerId: "hoan", shifts: Object.fromEntries(orderIds.map(code => [code, "Sáng"])), createdAt: 1, startedAt: status === "notStarted" ? null : 10,
  legs: {}, stopStarts: {}, pauseIntervals: [], pausedAt: null, completedAt: null, ...extra
});
const state = (orders, sessions = []) => ({ orders, sessions, activeSessionId: sessions.find(item => ["notStarted", "active", "paused"].includes(item.status))?.id ?? null });
const run = (current, name, args, context = ctx()) => runCommand(current, name, args, context);
const find = (result, id) => result.after.orders.find(item => item.id === id);

test("the whole route can be created, started, delivered and completes itself", () => {
  let current = state([order("DA"), order("DB")]);
  let result = run(current, "createSession", { orderIds: ["DA", "DB"], shifts: { DA: "Sáng", DB: "Chiều" } });
  const sessionId = result.after.sessions[0].id;
  assert.equal(result.after.sessions[0].status, "notStarted");
  result = run(result.after, "startSession", { sessionId });
  assert.equal(find(result, "DA").deliveryStatus, "Đang giao hàng");
  result = run(result.after, "markDelivered", { orderId: "DA" });
  assert.equal(result.after.sessions[0].status, "active");
  assert.equal(find(result, "DA").deliveredAt, NOW);
  result = run(result.after, "markDelivered", { orderId: "DB" });
  assert.equal(result.after.sessions[0].status, "completed");
  assert.equal(result.after.activeSessionId, null);
  // The account can immediately start a new session.
  const fresh = run({ ...result.after, orders: [...result.after.orders, order("DC")] }, "createSession", { orderIds: ["DC"], shifts: "Sáng" });
  assert.equal(fresh.rejection, undefined);
  assert.equal(fresh.after.sessions.filter(item => item.status === "notStarted").length, 1);
});

test("a stuck session heals before the command runs, so it never blocks a new session", () => {
  const stuck = state(
    [order("DA", "Đã giao hàng", { sessionId: "PS-1", deliveredAt: 9 }), order("DN")],
    [session("PS-1", "active", ["DA"])]
  );
  const result = run(stuck, "createSession", { orderIds: ["DN"], shifts: "Sáng" });
  assert.equal(result.rejection, undefined);
  assert.equal(result.after.sessions.find(item => item.id === "PS-1").status, "completed");
  assert.equal(result.after.sessions.find(item => item.id !== "PS-1").status, "notStarted");
});

test("an impossible command is rejected with a message but the healed state is still returned", () => {
  const current = state(
    [order("DA", "Đang giao hàng", { sessionId: "PS-1" }), order("DN")],
    [session("PS-1", "active", ["DA"])]
  );
  const result = run(current, "createSession", { orderIds: ["DN"], shifts: "Sáng" });
  assert.match(result.rejection, /phiên giao hàng đang hoạt động/);
  assert.equal(result.after, result.healed);
});

test("a stale device repeating an action that already happened succeeds as a no-op", () => {
  const delivered = state(
    [order("DA", "Đã giao hàng", { sessionId: "PS-1", deliveredAt: 9 }), order("DB", "Đang giao hàng", { sessionId: "PS-1" })],
    [session("PS-1", "active", ["DA", "DB"], { legs: { DA: { startedAt: 10, completedAt: 9, durationMs: 0 } } })]
  );
  assert.equal(run(delivered, "markDelivered", { orderId: "DA" }).noop, true);
  assert.equal(run({ ...delivered, orders: delivered.orders.map(item => ({ ...item, paymentStatus: "Đã thanh toán" })) }, "markPaid", { orderId: "DA", method: "Tiền mặt" }).noop, true);
  assert.equal(run(delivered, "startSession", { sessionId: "PS-1" }).noop, true);
  const paused = state(delivered.orders, [session("PS-1", "paused", ["DA", "DB"], { pausedAt: 30, legs: delivered.sessions[0].legs })]);
  assert.equal(run(paused, "pauseSession", { sessionId: "PS-1" }).noop, true);
});

test("cancelling an already closed session is a no-op and never cancels the account's newer session", () => {
  const current = state(
    [order("DA", "Đang giao hàng", { sessionId: "PS-2" })],
    [session("PS-1", "completed", ["DX"], { completedAt: 3 }), session("PS-2", "active", ["DA"])]
  );
  const result = run(current, "cancelSession", { sessionId: "PS-1" });
  assert.equal(result.noop, true);
  assert.equal(result.after.sessions.find(item => item.id === "PS-2").status, "active");
  assert.equal(find(result, "DA").deliveryStatus, "Đang giao hàng");
});

test("cancelling releases open orders but leaves delivered and cancelled orders alone", () => {
  const current = state(
    [order("DA", "Đang giao hàng", { sessionId: "PS-1" }), order("DD", "Đã giao hàng", { sessionId: "PS-1", deliveredAt: 9 }), order("DX", "Đã huỷ đơn", { sessionId: "PS-1" })],
    [session("PS-1", "active", ["DA", "DD", "DX"])]
  );
  const result = run(current, "cancelSession", { sessionId: "PS-1" });
  assert.equal(result.after.sessions[0].status, "cancelled");
  assert.equal(find(result, "DA").deliveryStatus, "Chưa giao hàng");
  assert.equal(find(result, "DA").sessionId, null);
  assert.equal(find(result, "DD").deliveryStatus, "Đã giao hàng");
  assert.equal(find(result, "DX").deliveryStatus, "Đã huỷ đơn");
});

test("reordering moves an order to where another one is and cannot overwrite a newer route", () => {
  const current = state(
    [order("DA"), order("DB"), order("DC")],
    [session("PS-1", "notStarted", ["DA", "DB", "DC"])]
  );
  let result = run(current, "reorderOrderInSession", { sessionId: "PS-1", orderId: "DC", targetOrderId: "DA" });
  assert.deepEqual(result.after.sessions[0].orderIds, ["DC", "DA", "DB"]);
  // Another device already removed DB: the stale target is rejected instead of guessing.
  const removed = state([order("DA"), order("DC")], [session("PS-1", "notStarted", ["DA", "DC"])]);
  assert.match(run(removed, "reorderOrderInSession", { sessionId: "PS-1", orderId: "DC", targetOrderId: "DB" }).rejection, /không còn trong phiên/);
});

test("a shipper cannot touch another shipper's order, and staff cannot touch an order inside a shipper's route", () => {
  const foreign = state([order("DA", "Chưa giao hàng", { assignedUserId: "hieu", shipperName: "Hiếu" })]);
  assert.match(run(foreign, "createSession", { orderIds: ["DA"], shifts: "Sáng" }).rejection, /chưa được giao cho tài khoản này/);
  const inRoute = state([order("DA", "Đang giao hàng", { sessionId: "PS-1" })], [session("PS-1", "active", ["DA"])]);
  assert.match(run(inRoute, "markPaid", { orderId: "DA", method: "Tiền mặt" }, ctx(staff, "hoan")).rejection, /đang nằm trong phiên/);
  assert.throws(() => run(foreign, "markDelivered", { orderId: "ZZ" }), error => error instanceof AppError && error.status === 404);
});

test("an order matched to the shipper by name is claimed for the account", () => {
  const byName = state([order("DA", "Chưa giao hàng", { assignedUserId: null, shipperName: "Hoàn" })]);
  const result = run(byName, "createSession", { orderIds: ["DA"], shifts: "Sáng" });
  assert.equal(result.rejection, undefined);
  assert.equal(find(result, "DA").assignedUserId, "hoan");
});

test("payment is appended once with server time", () => {
  const current = state(
    [order("DA", "Đang giao hàng", { sessionId: "PS-1" })],
    [session("PS-1", "active", ["DA"])]
  );
  const result = run(current, "markPaid", { orderId: "DA", method: "Chuyển khoản" });
  assert.equal(find(result, "DA").paymentStatus, "Đã thanh toán");
  assert.deepEqual(find(result, "DA").payments, [{ method: "Chuyển khoản", amount: 100_000, paidAt: NOW, sessionId: "PS-1" }]);
  assert.equal(find(result, "DA").remainingDue, 0);
});

test("deleting a session releases its open orders and removes it from the account's state", () => {
  const current = state(
    [order("DA", "Đang giao hàng", { sessionId: "PS-1" })],
    [session("PS-1", "active", ["DA"])]
  );
  const result = run(current, "deleteSession", { sessionId: "PS-1" });
  assert.equal(result.after.sessions.length, 0);
  assert.equal(find(result, "DA").deliveryStatus, "Chưa giao hàng");
});

test("commands are validated and role-checked before touching any state", () => {
  assert.throws(() => validateCommand("nope", {}, hoan), error => error.code === "UNKNOWN_COMMAND");
  assert.throws(() => validateCommand("createSession", { orderIds: ["DA"] }, staff), error => error.status === 403);
  assert.throws(() => validateCommand("markPaid", { orderId: "DA", method: "Bitcoin" }, hoan), error => error.code === "INVALID_COMMAND");
  assert.throws(() => validateCommand("markDelivered", { orderId: "../x" }, hoan), error => error.code === "INVALID_COMMAND");
  assert.throws(() => validateCommand("createSession", { orderIds: [], shifts: "Sáng" }, hoan), error => error.code === "INVALID_COMMAND");
  assert.throws(() => validateCommand("constructor", {}, hoan), error => error.code === "UNKNOWN_COMMAND");
  assert.deepEqual(validateCommand("markDelivered", { orderId: "DA" }, hoan).codes, ["DA"]);
});

test("running a command never mutates the loaded state", () => {
  const current = state([order("DA"), order("DB")]);
  const snapshot = structuredClone(current);
  run(current, "createSession", { orderIds: ["DA", "DB"], shifts: "Sáng" });
  assert.deepEqual(current, snapshot);
});
