import { waitUntil } from "@vercel/functions";
import { handler, readJson, requireMethod, send } from "../server-lib/core.mjs";
import { assertSameOrigin, requireUser } from "../server-lib/auth.mjs";
import { executeCommand } from "../server-lib/commands.mjs";
import { flushUpstream } from "../server-lib/upstream.mjs";

// Every user action (deliver, pay, create/close a session, ...) arrives here as one idempotent command. The server owns
// the state: it commits to Postgres first and pushes the Sheet in the background, so a slow or failing n8n never blocks
// or loses an action.
export default handler(async (req, res) => {
  requireMethod(req, "POST");
  assertSameOrigin(req);
  const user = await requireUser(req);
  const body = await readJson(req);
  const result = await executeCommand({ user, commandId: body.commandId, name: body.name, args: body.args });
  if (result.enqueued) {
    waitUntil(flushUpstream(50).catch(error => console.error(JSON.stringify({ code: "OUTBOX_RETRY", message: error.message }))));
  }
  if (result.rejection) {
    send(res, 409, { error: { code: "COMMAND_REJECTED", message: result.rejection }, orders: result.orders, sessions: result.sessions });
    return;
  }
  send(res, 200, { orders: result.orders, sessions: result.sessions, noop: Boolean(result.noop), serverTime: Date.now() });
});
