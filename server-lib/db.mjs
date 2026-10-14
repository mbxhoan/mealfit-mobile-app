import { neon, Pool } from "@neondatabase/serverless";
import { requireEnv } from "./core.mjs";

function databaseUrl() {
  if (process.env.VERCEL_ENV === "preview") return requireEnv("MEALFIT_PREVIEW_DATABASE_URL", "Chưa cấu hình database riêng cho Preview.");
  return process.env.DATABASE_URL || (process.env.VERCEL_ENV === "production" ? process.env.POSTGRES_URL : "") || requireEnv("DATABASE_URL", "Cơ sở dữ liệu chưa được cấu hình.");
}

export function getSql() {
  return neon(databaseUrl());
}

export async function withAdvisoryLock(lockId, callback) {
  return withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [lockId]);
    return callback(client);
  });
}

export async function withTransaction(callback) {
  const pool = new Pool({ connectionString: databaseUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export function json(value) {
  return JSON.stringify(value ?? {});
}
