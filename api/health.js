import { handler, requireMethod, send } from "./lib/core.mjs";
import { getSql } from "./lib/db.mjs";

export default handler(async (req, res) => {
  requireMethod(req, "GET", "HEAD");
  await getSql()`SELECT 1`;
  send(res, 200, { ok: true, at: Date.now() });
});
