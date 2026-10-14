import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL(".", import.meta.url).pathname;
const apiRoot = join(root, "api");
const config = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
const rewrites = new Map(config.rewrites.map(route => [route.source, route.destination]));

function functionsUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return functionsUnder(path);
    return entry.isFile() && /\.(?:js|mjs|ts)$/.test(entry.name) ? [path] : [];
  });
}

test("Vercel Hobby function count stays under its deployment limit", () => {
  assert.ok(functionsUnder(apiRoot).length <= 12);
});

test("existing API paths rewrite to their consolidated functions", () => {
  const expected = [
    ["/api/auth/login", "/api/auth?action=login"],
    ["/api/auth/logout", "/api/auth?action=logout"],
    ["/api/auth/session", "/api/auth?action=session"],
    ["/api/orders/:code", "/api/orders?code=:code"],
    ["/api/media/:id", "/api/media?id=:id"],
    ["/api/health", "/api/ping?database=1"],
    ["/api/cron/maintenance", "/api/refresh"]
  ];
  for (const [source, destination] of expected) assert.equal(rewrites.get(source), destination, source);
  for (const destination of rewrites.values()) {
    const target = destination.split("?", 1)[0].replace(/^\//, "") + ".js";
    assert.ok(existsSync(join(root, target)), `missing rewrite target: ${target}`);
  }
  assert.equal(config.crons[0].path, "/api/refresh");
  assert.ok(existsSync(join(apiRoot, "refresh.js")));
});
