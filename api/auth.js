import { handler, readJson, requireMethod, send, AppError } from "../server-lib/core.mjs";
import { ACCOUNTS, assertLoginRateLimit, assertSameOrigin, clearLoginRateLimit, expiredCookie, getSessionUser, sessionCookie, verifyPin } from "../server-lib/auth.mjs";

export default handler(async (req, res) => {
  const action = new URL(req.url, "https://mealfit.local").searchParams.get("action") || req.query?.action;
  if (action === "login") {
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
    return;
  }
  if (action === "logout") {
    requireMethod(req, "POST");
    assertSameOrigin(req);
    send(res, 200, { ok: true }, { "set-cookie": expiredCookie() });
    return;
  }
  if (action === "session") {
    requireMethod(req, "GET");
    send(res, 200, { user: getSessionUser(req) });
    return;
  }
  throw new AppError(404, "AUTH_ROUTE_NOT_FOUND", "Không tìm thấy thao tác xác thực.");
});
