import { neon, Pool } from "@neondatabase/serverless";
import { requireEnv } from "./core.mjs";

export function getSql() {
  return neon(requireEnv("DATABASE_URL", "Cơ sở dữ liệu chưa được cấu hình."));
}

export async function withTransaction(callback) {
  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL", "Cơ sở dữ liệu chưa được cấu hình."), max: 1 });
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
