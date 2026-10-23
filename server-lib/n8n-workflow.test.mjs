import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = JSON.parse(readFileSync(new URL("../../docs/api/n8n.json", import.meta.url), "utf8"));

test("n8n webhook export protects endpoints and returns complete paged shipper orders", () => {
  const webhooks = workflow.nodes.filter(node => node.type === "n8n-nodes-base.webhook");
  const names = workflow.nodes.map(node => node.name);
  assert.equal(webhooks.length, 7);
  assert.ok(webhooks.every(node => node.parameters.authentication === "headerAuth"));
  assert.equal(new Set(names).size, names.length);
  for (const connection of Object.values(workflow.connections)) for (const output of connection.main || []) for (const edge of output) assert.ok(names.includes(edge.node), `Missing target node: ${edge.node}`);
  const pager = workflow.nodes.find(node => node.name === "Page orders");
  assert.match(pager.parameters.jsCode, /query\.since/);
  assert.match(pager.parameters.jsCode, /row\.updated_at/);
  assert.match(pager.parameters.jsCode, /nextCursor/);
  assert.equal(workflow.connections.Sort.main[0][0].node, "Page orders");
  assert.equal(workflow.connections["get orders by shipper"].main[0][0].node, "if orders exist");
  assert.equal(workflow.nodes.find(node => node.name === "get orders").parameters.filtersUI, undefined);
  assert.match(workflow.nodes.find(node => node.name === "if orders exist").parameters.conditions.conditions[0].leftValue, /Mã đơn/);
  const emptyResponse = workflow.nodes.find(node => node.name === "Respond to Webhook1");
  assert.equal(emptyResponse.parameters.respondWith, "json");
  assert.match(emptyResponse.parameters.responseBody, /nextCursor: null/);

  const runPager = Function("$input", "$", pager.parameters.jsCode);
  const rows = [
    { "Mã đơn": "DH0003", "Trạng thái giao hàng": "Đã giao hàng", updated_at: "2026-10-14T10:00:00Z" },
    { "Mã đơn": "DH0002", "Tên KH": "Khách", "Trạng thái giao hàng": "Đang giao hàng", updated_at: "2026-10-14T10:00:00Z" },
    { "Mã đơn": "DH0001", "Trạng thái giao hàng": "Chưa giao hàng", updated_at: "2026-10-14T10:00:00Z" },
    { "Mã đơn": "DH0000", "Trạng thái giao hàng": "Đã huỷ đơn", updated_at: "2026-10-14T10:00:00Z" }
  ];
  const page = query => runPager({ all: () => rows.map(json => ({ json })) }, () => ({ first: () => ({ json: { query } }) }))[0].json;
  const first = page({ limit: 2 });
  assert.deepEqual(first.data.map(row => row["Mã đơn"]), ["DH0003", "DH0002"]);
  assert.equal(first.data[0]["Tên KH"], undefined);
  assert.equal(first.nextCursor, "DH0002");
  const second = page({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.data.map(row => row["Mã đơn"]), ["DH0001", "DH0000"]);
  assert.equal(second.nextCursor, null);
  assert.equal(workflow.active, false);
});

test("n8n writes single updates directly to existing Sheet rows", () => {
  const webhooks = workflow.nodes.find(node => node.name === "upsert /shipping-order");
  const builder = workflow.nodes.find(node => node.name === "Code in JavaScript1");
  const writer = workflow.nodes.find(node => node.name === "shipping");
  const responder = workflow.nodes.find(node => node.name === "Respond to Webhook3");
  assert.equal(workflow.connections[webhooks.name].main[0][0].node, builder.name);
  assert.equal(workflow.connections[builder.name].main[0][0].node, writer.name);
  assert.equal(workflow.connections[writer.name].main[0][0].node, "Build single order response");
  assert.equal(workflow.connections["Build single order response"].main[0][0].node, responder.name);
  assert.equal(writer.parameters.operation, "update");
  assert.deepEqual(writer.parameters.columns.matchingColumns, ["Mã đơn"]);
  assert.match(builder.parameters.jsCode, /payment_staus/);
  assert.match(responder.parameters.responseBody, /JSON\.stringify\(\$json\)/);
  assert.equal(workflow.nodes.some(node => JSON.stringify(node.parameters).includes("APPS_SCRIPT")), false);
});

test("n8n log webhook waits for the append and writes only to app_logs", () => {
  const spec = readFileSync(new URL("../../docs/api/n8n.yml", import.meta.url), "utf8");
  const webhook = workflow.nodes.find(node => node.name === "insert /log");
  const append = workflow.nodes.find(node => node.name === "log");
  assert.match(spec, /https:\/\/n8n\.delfi\.vn\/webhook-test\/log/);
  assert.match(spec, /"sheet_name": "app_logs"/);
  assert.match(spec, /"expected_revision": 0/);
  assert.match(spec, /"operation_id": "00000000-0000-4000-8000-000000000001"/);
  assert.equal(webhook.parameters.path, "log");
  assert.equal(webhook.parameters.httpMethod, "POST");
  assert.equal(webhook.parameters.authentication, "headerAuth");
  assert.equal(webhook.parameters.responseMode, "lastNode");
  assert.equal(append.parameters.sheetName.value, "app_logs");
  assert.equal(append.parameters.columns.matchingColumns, undefined);
  assert.equal(append.onError, undefined);
  assert.ok(workflow.connections[webhook.name].main[0].some(edge => edge.node === append.name));
  assert.match(spec, /Bearer \{\{N8N_API_KEY\}\}/);
  assert.match(spec, /\{\{ZALO_BOT_TOKEN\}\}/);
});

