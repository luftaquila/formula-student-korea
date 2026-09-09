import { serviceUrl } from "../../../shared/server/services.mjs";

export function registerRecipientsRoutes({ app, fetchFn, logger }) {
  /* ============================================
   Recipients (proxy to auth service)
   ============================================ */
  app.get("/api/recipients", async (req, res) => {
    const authServer = serviceUrl("auth");
    try {
      const headers = {};
      if (process.env.INTERNAL_SECRET) headers["X-Internal-Service"] = process.env.INTERNAL_SECRET;
      const resp = await fetchFn(`${authServer}/api/internal/users`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) throw new Error(`Auth API 오류 (${resp.status})`);
      const users = await resp.json();
      const list = users.map(({ email, name, role, realname, active }) => ({
        email,
        name,
        role,
        realname,
        active,
      }));
      res.json(list);
    } catch (e) {
      logger.warn(req, "recipients.fetch", { error: e.message });
      res.status(500).send("수신자 목록을 가져올 수 없습니다.");
    }
  });
}
