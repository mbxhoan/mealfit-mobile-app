import test from "node:test";
import assert from "node:assert/strict";
import { sheetOrderBelongsToShipper, sheetShipperNames, validateAccountDirectory } from "./accounts.mjs";

const initial = [
  { id: "admin", name: "Admin", role: "admin", aliases: [] },
  { id: "user", name: "Nhân viên", role: "user", aliases: [] },
  { id: "hieu", name: "Hiếu", role: "shipper", aliases: [] }
];

test("order sync always filters a shipper by current and legacy names", () => {
  assert.deepEqual(sheetShipperNames({ role: "shipper", name: "Hoàn", shipperNames: ["Hoàn", "Hoan"] }), ["Hoàn", "Hoan"]);
  assert.deepEqual(sheetShipperNames({ role: "shipper", name: "Hiếu" }), ["Hiếu"]);
  assert.deepEqual(sheetShipperNames({ role: "admin", name: "Admin" }), [""]);
  assert.throws(() => sheetShipperNames({ role: "shipper", name: " " }), error => error.code === "SHIPPER_NAME_MISSING");
});

test("a shipper's Sheet name or alias repairs a stale Neon assignment", () => {
  const user = { id: "shipper-new", role: "shipper", name: "Anh Hiếu", shipperNames: ["Hiếu"] };
  assert.equal(sheetOrderBelongsToShipper({ assigned_user_id: "shipper-old", shipper_name: "Hiếu" }, user), true);
  assert.equal(sheetOrderBelongsToShipper({ assigned_user_id: "shipper-new", shipper_name: "Tên khác" }, user), true);
  assert.equal(sheetOrderBelongsToShipper({ assigned_user_id: "shipper-other", shipper_name: "Hoàn" }, user), false);
});

test("renaming a shipper preserves the old Sheet name as an alias and keeps the account id", () => {
  const result = validateAccountDirectory({
    accounts: [...initial.map(({ id, name }) => ({ id, baseName: name, name: id === "hieu" ? "Anh Hiếu" : name }))],
    newShipperName: ""
  }, initial);
  assert.deepEqual(result.accounts.find(account => account.id === "hieu").aliases, ["Hiếu"]);
  assert.equal(result.accounts.find(account => account.id === "hieu").name, "Anh Hiếu");
});

test("account directory accepts adding a new shipper and rejects duplicate names", () => {
  const added = validateAccountDirectory({ accounts: initial.map(({ id, name }) => ({ id, baseName: name, name })), newShipperName: "Linh" }, initial);
  assert.equal(added.newShipperName, "Linh");
  assert.throws(() => validateAccountDirectory({
    accounts: initial.map(account => ({ id: account.id, baseName: account.name, name: account.id === "hieu" ? "Admin" : account.name })),
    newShipperName: ""
  }, initial), error => error.code === "DUPLICATE_ACCOUNT_NAME");
});

test("a new shipper cannot reuse another shipper's historical Sheet name", () => {
  const renamed = initial.map(account => account.id === "hieu" ? { ...account, name: "Anh Hiếu", aliases: ["Hiếu"] } : account);
  assert.throws(() => validateAccountDirectory({
    accounts: renamed.map(({ id, name }) => ({ id, baseName: name, name })), newShipperName: "Hiếu"
  }, renamed), error => error.code === "DUPLICATE_SHIPPER_ALIAS");
});

test("a stale admin form cannot overwrite a rename made by another admin", () => {
  assert.throws(() => validateAccountDirectory({
    accounts: initial.map(account => ({ id: account.id, baseName: account.id === "hieu" ? "Hiếu" : account.name, name: account.name })),
    newShipperName: ""
  }, initial.map(account => account.id === "hieu" ? { ...account, name: "Anh Hiếu" } : account)), error => error.code === "ACCOUNT_DIRECTORY_CHANGED");
});
