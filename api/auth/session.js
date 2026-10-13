import { handler, requireMethod, send } from "../lib/core.mjs";
import { getSessionUser } from "../lib/auth.mjs";

export default handler(async (req, res) => {
  requireMethod(req, "GET");
  const user = getSessionUser(req);
  send(res, 200, { user });
});
