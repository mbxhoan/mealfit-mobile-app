import { handler, requireMethod, send } from "./lib/core.mjs";

export default handler(async (req, res) => {
  requireMethod(req, "GET", "HEAD");
  send(res, 200, { ok: true, at: Date.now() });
});
