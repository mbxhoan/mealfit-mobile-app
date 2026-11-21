import assert from "node:assert/strict";
import test from "node:test";
import { closeFinishedSessions } from "./sessions.mjs";

const statuses = entries => new Map(Object.entries(entries));

test("a session whose orders are all delivered or cancelled is served as completed", () => {
  const session = { id: "PS-1", status: "active", orderIds: ["A", "B"], startedAt: 10, legs: { A: { completedAt: 50 } }, pauseIntervals: [] };
  const [closed] = closeFinishedSessions([session], statuses({ A: "Đã giao hàng", B: "Đã huỷ đơn" }));
  assert.equal(closed.status, "completed");
  assert.equal(closed.completedAt, 50);
});

test("sessions with an unfinished or unknown order stay open", () => {
  const session = { id: "PS-1", status: "active", orderIds: ["A", "B"], startedAt: 10 };
  assert.equal(closeFinishedSessions([session], statuses({ A: "Đã giao hàng", B: "Đang giao hàng" }))[0].status, "active");
  assert.equal(closeFinishedSessions([session], statuses({ A: "Đã giao hàng" }))[0].status, "active");
  assert.equal(closeFinishedSessions([{ ...session, status: "cancelled" }], statuses({ A: "Đã giao hàng", B: "Đã giao hàng" }))[0].status, "cancelled");
});
