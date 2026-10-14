import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = JSON.parse(readFileSync(new URL("../../docs/api/n8n.json", import.meta.url), "utf8"));

test("n8n webhook export protects all endpoints and supports delta pagination", () => {
  const webhooks = workflow.nodes.filter(node => node.type === "n8n-nodes-base.webhook");
  const names = workflow.nodes.map(node => node.name);
  assert.equal(webhooks.length, 4);
  assert.ok(webhooks.every(node => node.parameters.authentication === "headerAuth"));
  assert.equal(new Set(names).size, names.length);
  for (const connection of Object.values(workflow.connections)) for (const output of connection.main || []) for (const edge of output) assert.ok(names.includes(edge.node), `Missing target node: ${edge.node}`);
  const pager = workflow.nodes.find(node => node.name === "Page orders");
  assert.match(pager.parameters.jsCode, /query\.since/);
  assert.match(pager.parameters.jsCode, /row\.updated_at/);
  assert.match(pager.parameters.jsCode, /nextCursor/);
  const detail = workflow.nodes.find(node => node.name === "get order line items");
  const builder = workflow.nodes.find(node => node.name === "Build order detail");
  assert.equal(detail.parameters.sheetName.value, "=Chi_tiet_don_hang");
  assert.match(builder.parameters.jsCode, /Giá bán\/gói/);
  assert.match(builder.parameters.jsCode, /Thành tiền/);
  assert.equal(workflow.active, false);
});

test("Apps Script writes revisions under a lock and validates full update payload", () => {
  const script = readFileSync(new URL("../../docs/api/AppsScriptRevision.gs", import.meta.url), "utf8");
  assert.match(script, /LockService\.getScriptLock\(\)/);
  assert.match(script, /expected_revision/);
  assert.match(script, /operation_id/);
  assert.match(script, /payment_staus/);
  assert.match(script, /shipping_status/);
  assert.match(script, /Chi_tiet_don_hang/);
  assert.match(script, /Ghi chú bởi shipper/);
});
