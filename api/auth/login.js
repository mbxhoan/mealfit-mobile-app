import { handler, readJson, requireMethod, send } from "../lib/core.mjs";
import { ACCOUNTS, assertLoginRateLimit, assertSameOrigin, clearLoginRateLimit, sessionCookie, verifyPin } from "../lib/auth.mjs";

export default handler(async (req, res) => {
  requireMethod(req, "POST");
  assertSameOrigin(req);
  const body = await readJson(req);
  const user = ACCOUNTS[String(body.username || "")];
  const ip = await assertLoginRateLimit(req);
  if (!user || !verifyPin(body.pin)) {
    send(res, 401, { error: { code: "INVALID_LOGIN", message: "Tài khoản hoặc PIN chưa đúng." } });
    return;
  }
  await clearLoginRateLimit(ip);
  send(res, 200, { user }, { "set-cookie": sessionCookie(user.id) });
});
