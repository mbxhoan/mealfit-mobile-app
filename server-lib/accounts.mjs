import { randomUUID } from "node:crypto";
import { AppError } from "./core.mjs";
import { getSql, withTransaction } from "./db.mjs";

const accountFromRow = row => ({
  id: row.id,
  name: row.name,
  role: row.role,
  aliases: row.aliases || [],
  shipperNames: row.role === "shipper" ? [...new Set([row.name, ...(row.aliases || [])])] : []
});
const nameKey = value => String(value || "").trim().toLocaleLowerCase("vi-VN");

export async function getAccount(id) {
  const rows = await getSql()`SELECT id, name, role, aliases FROM mealfit_accounts WHERE id = ${id} LIMIT 1`;
  return rows[0] ? accountFromRow(rows[0]) : null;
}

export async function listAccounts() {
  const rows = await getSql()`SELECT id, name, role FROM mealfit_accounts ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'user' THEN 1 ELSE 2 END, created_at, id`;
  return rows.map(row => ({ id: row.id, name: row.name, role: row.role }));
}

export function validateAccountDirectory(body, current) {
  if (!Array.isArray(body?.accounts) || body.accounts.length !== current.length) {
    throw new AppError(400, "INVALID_ACCOUNTS", "Danh sách tài khoản đã thay đổi. Tải lại trang rồi thử lại.");
  }
  const submitted = new Map();
  for (const item of body.accounts) {
    const id = String(item?.id || "");
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const existing = current.find(account => account.id === id);
    if (!existing || submitted.has(id) || typeof item?.baseName !== "string" || item.baseName !== existing.name) {
      throw new AppError(409, "ACCOUNT_DIRECTORY_CHANGED", "Danh sách tài khoản vừa được thay đổi. Tải lại trang rồi thử lại.");
    }
    if (!name || name.length > 80) {
      throw new AppError(400, "INVALID_ACCOUNT", "Tên tài khoản phải có từ 1 đến 80 ký tự.");
    }
    submitted.set(id, name);
  }

  const accounts = current.map(account => {
    const name = submitted.get(account.id);
    const aliases = [...(account.aliases || [])];
    if (account.role === "shipper" && name !== account.name && !aliases.includes(account.name)) aliases.push(account.name);
    return { ...account, name, aliases };
  });
  if (body.newShipperName != null && typeof body.newShipperName !== "string") throw new AppError(400, "INVALID_ACCOUNT", "Tên shipper mới không hợp lệ.");
  const newShipperName = String(body.newShipperName || "").trim();
  if (newShipperName.length > 80) throw new AppError(400, "INVALID_ACCOUNT", "Tên shipper mới tối đa 80 ký tự.");

  const currentNames = new Set();
  for (const account of accounts) {
    const key = nameKey(account.name);
    if (currentNames.has(key)) throw new AppError(409, "DUPLICATE_ACCOUNT_NAME", "Mỗi tài khoản cần có một tên riêng.");
    currentNames.add(key);
  }
  if (newShipperName) {
    const key = nameKey(newShipperName);
    if (currentNames.has(key)) throw new AppError(409, "DUPLICATE_ACCOUNT_NAME", "Tên shipper này đã được sử dụng.");
    currentNames.add(key);
  }

  const shipperNames = new Map();
  for (const account of accounts.filter(item => item.role === "shipper")) {
    for (const value of [account.name, ...account.aliases]) {
      const key = nameKey(value);
      if (shipperNames.has(key) && shipperNames.get(key) !== account.id) {
        throw new AppError(409, "DUPLICATE_SHIPPER_ALIAS", "Tên hiện tại hoặc tên cũ của shipper đang trùng với tài khoản khác.");
      }
      shipperNames.set(key, account.id);
    }
  }
  if (newShipperName && shipperNames.has(nameKey(newShipperName))) {
    throw new AppError(409, "DUPLICATE_SHIPPER_ALIAS", "Tên này đã được dùng làm tên cũ của shipper khác.");
  }
  return { accounts, newShipperName };
}

export async function updateAccountDirectory(body, actorId) {
  return withTransaction(async client => {
    await client.query("LOCK TABLE mealfit_accounts IN SHARE ROW EXCLUSIVE MODE");
    const rows = await client.query("SELECT id, name, role, aliases FROM mealfit_accounts ORDER BY created_at, id FOR UPDATE");
    const current = rows.rows.map(accountFromRow);
    const { accounts, newShipperName } = validateAccountDirectory(body, current);
    const currentById = new Map(current.map(account => [account.id, account]));
    for (const account of accounts) {
      const previous = currentById.get(account.id);
      if (previous.name === account.name) continue;
      await client.query("UPDATE mealfit_accounts SET name = $2, aliases = $3::text[], updated_at = now() WHERE id = $1", [account.id, account.name, account.aliases]);
      await client.query("INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, detail) VALUES ($1, 'account', $2, 'rename', $3::jsonb)", [actorId, account.id, JSON.stringify({ oldName: previous.name, name: account.name })]);
    }
    if (newShipperName) {
      const id = `shipper_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      await client.query("INSERT INTO mealfit_accounts (id, name, role) VALUES ($1, $2, 'shipper')", [id, newShipperName]);
      await client.query("INSERT INTO mealfit_audit_log (actor_id, entity_type, entity_id, operation, detail) VALUES ($1, 'account', $2, 'create-shipper', $3::jsonb)", [actorId, id, JSON.stringify({ name: newShipperName })]);
    }
    const result = await client.query("SELECT id, name, role FROM mealfit_accounts ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'user' THEN 1 ELSE 2 END, created_at, id");
    return result.rows.map(row => ({ id: row.id, name: row.name, role: row.role }));
  });
}

