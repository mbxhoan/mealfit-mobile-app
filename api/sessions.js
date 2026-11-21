import { handler, requireMethod, send } from "../server-lib/core.mjs";
import { requireUser } from "../server-lib/auth.mjs";
import { getSql } from "../server-lib/db.mjs";
import { withFinishedSessionsClosed } from "../server-lib/sessions.mjs";

// Sessions are stored as the server last committed them (commands repair the invariants on write), so every device that
// loads this sees the same status. Deleted sessions are tombstones and never listed.
export default handler(async (req, res) => {
  requireMethod(req, "GET");
  const user = await requireUser(req);
  const rows = user.role === "shipper"
    ? await getSql()`SELECT payload, revision, status, owner_id, session_id FROM mealfit_sessions
        WHERE owner_id = ${user.id} AND COALESCE((payload->>'deleted')::boolean, false) = false ORDER BY updated_at DESC LIMIT 100`
    : await getSql()`SELECT payload, revision, status, owner_id, session_id FROM mealfit_sessions
        WHERE COALESCE((payload->>'deleted')::boolean, false) = false ORDER BY updated_at DESC LIMIT 500`;
  const sessions = rows.map(row => ({ ...row.payload, id: row.payload?.id || row.session_id, status: row.status, ownerId: row.owner_id, serverRevision: Number(row.revision) }));
  // Read-time fallback for sessions that were finished before the server started repairing them on write.
  send(res, 200, { data: await withFinishedSessionsClosed(sessions) });
});
