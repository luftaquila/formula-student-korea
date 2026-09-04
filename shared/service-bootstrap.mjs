import { createDatabase } from "./db-setup.mjs";
import { createApp, createDbRun, ensureDataDir, setupProcessHandlers } from "./express-setup.mjs";
import { createLogger } from "./logger.mjs";
import { servicePort } from "./services.mjs";

// supporting service와 Competition module factory가 공유하는 골격: DB 생성 → logger → createApp →
// /api/logs·/api/health 라우트 → dbRun. authRoleFn(역할 게이트)은 서비스 소유
// 정책이므로 서비스별 함수 그대로 주입받는다 — 골격만 공유한다.
//
// authRoleFn이 db/logger를 참조해야 하면 팩토리 안에서 hoisted `function`으로 선언해
// 넘긴다. 게이트는 요청 시점에 호출되므로 이 함수가 골격 호출 뒤에 선언되어도 안전하다.
export function createServiceSkeleton({
  name, express, Database, options = {}, authRoleFn,
  dbFile, maxLogRows, validateUserCacheTtl,
}) {
  // Competition injects one configured SQLite connection into every module.
  // Independently deployed supporting services own the connection they create.
  const ownsDb = !options.db;
  const db = options.db || createDatabase(Database, options.dbPath || `./data/${dbFile || `${name}.db`}`);
  const logger = createLogger(db, name, maxLogRows, {
    teamSource: options.teamStore ?? options.competitionQueries?.teams,
  });
  const deps = {
    express,
    logger,
    validateUser: options.validateUser,
    validateDevice: options.validateDevice,
    staticRoot: options.staticRoot,
    jsonLimit: options.jsonLimit,
    jsonLimitPaths: options.jsonLimitPaths,
  };
  const requestedCacheTtl = options.validateUserCacheTtl ?? validateUserCacheTtl;
  if (requestedCacheTtl !== undefined) deps.validateUserCacheTtl = requestedCacheTtl;
  if (options.validateDeviceCacheTtl !== undefined) {
    deps.validateDeviceCacheTtl = options.validateDeviceCacheTtl;
  }
  const app = createApp(deps, authRoleFn);
  app.locals.staticRoot = options.staticRoot || "./web/dist";
  app.get("/api/logs", logger.queryHandler);
  app.get("/api/health", (req, res) => res.send("ok"));
  if (options.mutationGuard) {
    app.use((req, res, next) => {
      if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
      try {
        options.mutationGuard(req);
        return next();
      } catch (error) {
        const status = Number(error?.status) || 500;
        logger.warn(req, "competition_year.write_rejected", {
          error: error?.message || String(error),
          code: error?.code,
          year: error?.year,
          method: req.method,
          path: req.path,
        }, error?.year == null ? req.path : String(error.year));
        return res.status(status).json({
          code: error?.code || "MUTATION_GUARD_FAILED",
          message: status >= 500 ? "대회 연도 쓰기 조건을 확인할 수 없습니다." : error.message,
          ...(error?.year ? { year: error.year } : {}),
        });
      }
    });
  }
  return { app, db, logger, dbRun: createDbRun(), ownsDb };
}

// SPA fallback은 모든 서비스 라우트 **뒤에** 등록해야 하므로 골격이 아니라 각 팩토리
// 말미에서 서비스가 직접 호출한다. root override는 테스트 픽스처 격리용.
export function addSpaFallback(app, root = app.locals.staticRoot || "./web/dist") {
  app.get("/{*splat}", (req, res) => res.sendFile("index.html", { root }));
}

// 직접 실행(`node index.mjs`) 부팅 블록. factory는 { app, db, ...extras }를 반환해야
// 하며, postListen은 listen 이후 부가 작업(예: queue의 SMS 설정 로드)용으로 factory
// 반환값 전체를 받는다. 포트는 SERVICE_PORTS 단일 소스에서 온다.
export function runIfDirect(importMeta, name, factory, { postListen } = {}) {
  if (importMeta.filename !== process.argv[1]) return;
  ensureDataDir();
  const created = factory();
  setupProcessHandlers(created.db);
  const port = servicePort(name);
  const label = name[0].toUpperCase() + name.slice(1);
  created.app.listen(port, () => console.log(`${label} service running on port ${port}`));
  postListen?.(created);
}
