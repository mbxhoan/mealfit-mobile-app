import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = JSON.parse(readFileSync(new URL("../../docs/api/n8n.json", import.meta.url), "utf8"));

test("n8n webhook export protects all endpoints and supports delta pagination", () => {
  const webhooks = workflow.nodes.filter(node => node.type === "n8n-nodes-base.webhook");
  const names = workflow.nodes.map(node => node.name);
  assert.equal(webhooks.length, 6);
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

test("n8n log webhook waits for the append and writes only to app_logs", () => {
  const spec = readFileSync(new URL("../../docs/api/n8n.yml", import.meta.url), "utf8");
  const webhook = workflow.nodes.find(node => node.name === "insert /log");
  const append = workflow.nodes.find(node => node.name === "log");
  assert.match(spec, /https:\/\/n8n\.delfi\.vn\/webhook-test\/log/);
  assert.match(spec, /"sheet_name": "app_logs"/);
  assert.equal(webhook.parameters.path, "log");
  assert.equal(webhook.parameters.httpMethod, "POST");
  assert.equal(webhook.parameters.authentication, "headerAuth");
  assert.equal(webhook.parameters.responseMode, "lastNode");
  assert.equal(append.parameters.sheetName.value, "app_logs");
  assert.equal(append.parameters.columns.matchingColumns, undefined);
  assert.equal(append.onError, undefined);
  assert.ok(workflow.connections[webhook.name].main[0].some(edge => edge.node === append.name));
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
