import { handler, requireMethod, send } from "../server-lib/core.mjs";
import { requireUser } from "../server-lib/auth.mjs";
import { getSql } from "../server-lib/db.mjs";

export default handler(async (req, res) => {
  requireMethod(req, "GET");
  const user = await requireUser(req);
  const rows = user.role === "shipper"
    ? await getSql()`SELECT payload, revision FROM mealfit_sessions WHERE owner_id = ${user.id} ORDER BY updated_at DESC LIMIT 100`
    : await getSql()`SELECT payload, revision FROM mealfit_sessions ORDER BY updated_at DESC LIMIT 500`;
  send(res, 200, { data: rows.map(row => ({ ...row.payload, serverRevision: Number(row.revision) })) });
});
