import { handler, requireMethod, send } from "../server-lib/core.mjs";
import { getSql } from "../server-lib/db.mjs";

export default handler(async (req, res) => {
  requireMethod(req, "GET", "HEAD");
  if (new URL(req.url, "https://mealfit.local").searchParams.get("database") === "1") await getSql()`SELECT 1`;
  send(res, 200, { ok: true, at: Date.now() });
});
