import { handler, readJson, requireMethod, send, AppError } from "../server-lib/core.mjs";
import { assertLoginRateLimit, assertSameOrigin, clearLoginRateLimit, expiredCookie, getSessionUser, requireUser, sessionCookie, verifyPin } from "../server-lib/auth.mjs";
import { getAccount, listAccounts, updateAccountDirectory } from "../server-lib/accounts.mjs";

export default handler(async (req, res) => {
  const action = new URL(req.url, "https://mealfit.local").searchParams.get("action") || req.query?.action;
  if (action === "accounts") {
    if (req.method === "GET") {
      send(res, 200, { data: await listAccounts() });
      return;
    }
    requireMethod(req, "POST");
    assertSameOrigin(req);
    const user = await requireUser(req);
    if (user.role !== "admin") throw new AppError(403, "ADMIN_REQUIRED", "Chỉ admin được quản lý tài khoản.");
    const body = await readJson(req);
    const data = await updateAccountDirectory(body, user.id);
    send(res, 200, { data });
    return;
  }
  if (action === "login") {
    requireMethod(req, "POST");
    assertSameOrigin(req);
    const body = await readJson(req);
    const user = await getAccount(String(body.username || ""));
    const ip = await assertLoginRateLimit(req);
    if (!user || !verifyPin(body.pin)) {
      send(res, 401, { error: { code: "INVALID_LOGIN", message: "Tài khoản hoặc PIN chưa đúng." } });
      return;
    }
    await clearLoginRateLimit(ip);
    send(res, 200, { user: { id: user.id, name: user.name, role: user.role } }, { "set-cookie": sessionCookie(user.id) });
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
    const user = await getSessionUser(req);
    send(res, 200, { user: user ? { id: user.id, name: user.name, role: user.role } : null });
    return;
  }
  throw new AppError(404, "AUTH_ROUTE_NOT_FOUND", "Không tìm thấy thao tác xác thực.");
});
