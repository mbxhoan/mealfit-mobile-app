import { handler, requireMethod, send } from "../lib/core.mjs";
import { assertSameOrigin, expiredCookie } from "../lib/auth.mjs";

export default handler(async (req, res) => {
  requireMethod(req, "POST");
  assertSameOrigin(req);
  send(res, 200, { ok: true }, { "set-cookie": expiredCookie() });
});
