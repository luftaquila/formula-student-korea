import fs from "fs";
import crypto from "crypto";

export function ensureDataDir() {
  if (!fs.existsSync("./data")) {
    fs.mkdirSync("./data", { recursive: true });
  }
}

export function createJWT(payload, secret, expiresInSec = 7 * 24 * 3600) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSec };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const bodyB64 = Buffer.from(JSON.stringify(body)).toString("base64url");
  const data = `${headerB64}.${bodyB64}`;
  const signature = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

function verifyJWT(token, secret) {
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64) throw new Error("Invalid token");
  const data = `${headerB64}.${payloadB64}`;
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureB64);
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    throw new Error("Invalid signature");
  }
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  if (!payload.exp || Date.now() / 1000 > payload.exp) throw new Error("Expired");
  return payload;
}

export function createApp(logFile, deps, authRoleFn) {
  const { express, pinoHttp } = deps;
  ensureDataDir();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // 1. Cookie parsing (no external dependency)
  app.use((req, res, next) => {
    req.cookies = {};
    const ch = req.headers.cookie;
    if (ch) {
      ch.split(";").forEach((c) => {
        const [n, ...r] = c.split("=");
        if (n) {
          try { req.cookies[n.trim()] = decodeURIComponent(r.join("=").trim()); }
          catch { /* malformed percent-encoding */ }
        }
      });
    }
    next();
  });

  // 2. JWT user extraction (with dev mode auto-auth)
  // Build validateUser: direct function from deps, or auto HTTP via AUTH_SERVER
  let validateUser = deps.validateUser || null;
  if (!validateUser && process.env.AUTH_SERVER && process.env.INTERNAL_SECRET) {
    validateUser = async (email) => {
      try {
        const res = await fetch(`${process.env.AUTH_SERVER}/api/users/exists/${encodeURIComponent(email)}`, {
          headers: { "X-Internal-Service": process.env.INTERNAL_SECRET },
          signal: AbortSignal.timeout(3000),
        });
        return res.ok;
      } catch {
        return false; // fail closed if auth service unreachable
      }
    };
  }

  // Pre-compute INTERNAL_SECRET hash (immutable for process lifetime)
  const internalSecret = process.env.INTERNAL_SECRET;
  const cachedSecretHash = internalSecret
    ? crypto.createHash("sha256").update(internalSecret).digest()
    : null;

  app.use(async (req, res, next) => {
    // Internal service-to-service auth
    const header = req.headers["x-internal-service"];
    if (cachedSecretHash && header) {
      const headerHash = crypto.createHash("sha256").update(header).digest();
      if (crypto.timingSafeEqual(cachedSecretHash, headerHash)) {
        req.user = { email: "internal", name: "Service", role: "admin" };
        req.headers.authuser = "internal";
        return next();
      }
    }
    const token = req.cookies.fsk_session;
    if (token && process.env.JWT_SECRET) {
      try {
        req.user = verifyJWT(token, process.env.JWT_SECRET);
        req.headers.authuser = req.user.email;
      } catch { /* invalid token */ }
    } else if (!process.env.JWT_SECRET && process.env.NODE_ENV !== "production") {
      // Dev mode: auto admin when JWT_SECRET is not set
      req.user = { email: "dev@local", name: "Developer", role: "admin" };
      req.headers.authuser = "dev@local";
    }

    // Validate user still exists (deleted user rejection)
    if (req.user && validateUser) {
      const valid = await validateUser(req.user.email);
      if (!valid) {
        req.user = null;
        const isSecure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
        const cookieOpts = `Path=/; SameSite=Lax; Max-Age=0${isSecure ? "; Secure" : ""}`;
        res.setHeader("Set-Cookie", [
          `fsk_session=; HttpOnly; ${cookieOpts}`,
          `fsk_user=; ${cookieOpts}`,
        ]);
      }
    }

    next();
  });

  // 3. Auth middleware (when authRoleFn is provided)
  if (authRoleFn) {
    app.use((req, res, next) => {
      const role = authRoleFn(req);
      if (!role) return next(); // public
      if (!req.user) return res.status(401).send("인증이 필요합니다.");
      if (role === "admin" && req.user.role !== "admin") {
        return res.status(403).send("권한이 없습니다.");
      }
      next();
    });
  }

  // 4. Static files (after auth middleware)
  app.use(express.static("./web/dist"));

  // 5. Logging
  app.use(
    pinoHttp({
      stream: fs.createWriteStream(`./data/${logFile}`, { flags: "a" }),
      customProps: (req, res) => {
        if (req.path.includes("/callback") || req.path.includes("/login")) return {};
        return { reqBody: req.body };
      },
    }),
  );

  return app;
}

export function setupProcessHandlers(db) {
  process.on("exit", () => db.close());
  process.on("SIGHUP", () => process.exit(128 + 1));
  process.on("SIGINT", () => process.exit(128 + 2));
  process.on("SIGTERM", () => process.exit(128 + 15));
}

export function createDbRun() {
  return function dbRun(fn) {
    try {
      return { success: true, result: fn() };
    } catch (e) {
      if (e.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        return { success: false, status: 400, error: "이미 존재하는 항목입니다." };
      }
      if (e.status && e.message) {
        return { success: false, status: e.status, error: e.message };
      }
      return { success: false, status: 500, error: `DB 오류: ${e.message || e}` };
    }
  };
}
