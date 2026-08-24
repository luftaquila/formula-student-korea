# Contributing

Read [the architecture](docs/architecture.md) before changing service boundaries or Competition data ownership, and [the API reference](docs/api.md) before changing public routes. Changes to competition-year writes, team identity, migration, upload cleanup, backup, or restore must preserve the invariants in the architecture document and include regression tests.

## Tech Stack

Frontend: Vue 3, Vite, Vue Router, Pinia (traffic/energymeter only) · Backend: Node.js 22, Express.js 5, Better-SQLite3 · Auth: Google OAuth 2.0, JWT (HMAC-SHA256) cookies, RBAC · Real-time: SSE (inspection, queue, score, traffic, course) + WebRTC (rover camera — WHIP/WHEP via mediamtx, `aiortc` on the rover, three.js/WebXR in the course `/vr` view) · Deploy: Docker Compose + Caddy · Testing: `node:test` + `node:assert`, Playwright (E2E)

## Commands

```bash
# Frontend dev
cd {service}/web && npm run dev|build

# Backend dev — supporting services export create*App(options)
cd {service} && node index.mjs
# Competition is the deployed owner of teams, queue, registration, inspection,
# traffic, score, and documents. Their factories are composed in-process and used by tests;
# they are not standalone deployment or rollback profiles.

# Docker (Makefile wraps podman compose, auto-prunes)
make deploy                    # Pull images + restart (production)
make deploy SVC=competition    # Competition core
make build                     # Build locally (dev)
make restart                   # Restart only (no pull/build)
make deploy PROFILE=local      # Local dev (localhost:9000)

# Backup / Restore (scripts/ — requires sqlite3 CLI)
make backup                    # → ./backups/fsk-backup-YYYYMMDD-HHMMSS.zip
make backup DEST=/mnt/nas      # Custom destination
make restore ZIP=backups/fsk-backup-20260323-120000.zip

# Rover bring-up after a fresh image flash (reads .env, writes pilot.conf,
# recreates podman secrets, restarts pilot/perception services; idempotent)
scripts/provision-rover.sh <rover-ip> [--ntrip-username=<id>]
```

Prerequisites: podman machine, `.env` from `.env.example` (min: `JWT_SECRET`, `INTERNAL_SECRET`).

## Auth and inter-service calls

**Roles**: `public < student < official < chief < admin`. `authRoleFn(req)` returns role or null. Non-API routes redirect to `/` on 401/403.

Caddy strips `X-Internal-Service` and `Authuser` from external requests. Supporting-service calls use `X-Internal-Service` header (= `INTERNAL_SECRET`), auto-admin.

All non-auth services validate through Auth and fail closed: only HTTP 200 confirms a user. There is no runtime switch that disables this. Tests inject `TRUST_JWT` through the application factory. Environment variables such as `<NAME>_SERVER` override supporting-service integrations; they cannot split the deployed Competition runtime.

Inside Competition, Score consumes module query ports and receives Inspection/Traffic invalidations through an in-process event bridge; it does not loop back through HTTP/SSE. Teams are the sole shared roster source. There is no finalize boundary, standalone Competition-module runtime, lifecycle compatibility API, or reverse migration. Auth aggregates the seven logical module logs through their flat versioned Competition endpoints.

**FileBrowser** (`/files/`, chief+): uses separate `X-Forward-Auth-Key` header. DB reset requires container recreate: `podman rm -f fsk-filebrowser && podman compose --profile production up -d filebrowser`.

## Testing

```bash
npm test                    # All tests
npm run test:{service}      # Specific service
npm run test:shared         # Shared modules
```

Tests: `tests/<service>/<service>.test.mjs`, utils: `tests/helpers/test-utils.mjs`. **Always add/update tests for code changes.**

### E2E (Playwright) — CI only, do NOT run locally

Tests: `tests/e2e/{service}/*.spec.mjs` · CI: `.github/workflows/test.yml` (push/PR to main) · Check: `gh run list` → `gh run view <id> --log-failed`

**Never use `waitForTimeout` for API saves.** Use deterministic waits:

```js
// Set up waitForResponse BEFORE the action, await AFTER
const p = page.waitForResponse(res => res.url().includes("/api/...") && res.status() === 200);
await input.blur();
await p;
```

Patterns: immediate → `waitForResponse` before action | debounced → before `fill()` | SSE → before `goto()` | cleanup (maybe no call) → `Promise.race([resp, timeout(1000)])` | inter-service sync → `expect.poll()` | client-only → Playwright auto-retry assertions.

**Parallel isolation**: never assert exact counts; use `toBeGreaterThanOrEqual`, regex, or isolated test data.

## Logging Policy

All backend services use `createLogger(db, serviceName)` from `shared/logger.mjs`. Logs are stored per-service in SQLite `logs` table and aggregated by auth service (`GET /api/admin/logs`).

### API

```js
logger.log(req, action, detail, target, actorOverride)   // level: info (성공)
logger.warn(req, action, detail, target, actorOverride)   // level: warn (실패·경고)
```

- `action`: dot-separated `resource.operation` (e.g., `team.create`, `rover.request`)
- `target`: 영향받는 대상 식별자 (e.g., `#123`, `course-name`, `rover`)
- `detail`: 객체면 자동 JSON.stringify, 문자열이면 그대로 저장. null 허용
- `actorOverride`: 다른 사용자 대신 기록 시 `{ email, name, role }` 전달

### 레벨 규칙

| 상황 | 레벨 | 예시 |
|------|------|------|
| 작업 성공 | `logger.log` | `logger.log(req, "team.create", { year, university }, "123")` |
| 작업 실패 (비즈니스 로직, DB 에러) | `logger.warn` | `logger.warn(req, "team.create", { error: result.error }, "123")` |
| 보안 이벤트 (인증 실패, 권한 거부) | `logger.warn` | `logger.warn(req, "auth.forward_auth_denied", ...)` |

### 필수 로깅 원칙

1. **모든 쓰기 작업(CUD)의 실패는 반드시 로깅한다.** dbRun 실패 시 에러 응답 전에 `logger.warn`을 호출한다:
   ```js
   const result = dbRun(() => { ... });
   if (!result.success) {
     logger.warn(req, "resource.operation", { error: result.error }, target);
     return res.status(result.status).send(result.error);
   }
   ```
   단, 핸들러 진입부의 **단순 입력 검증 400**(형식/누락 등 비즈니스 로직 도달 전 조기 반환)의 로깅은 선택이다 — DB·비즈니스 로직·서비스 간 통신 실패가 필수 대상이다.

2. **같은 액션의 성공/실패는 반드시 레벨로 구분한다.** 같은 action 문자열을 써도 성공은 `logger.log`, 실패는 `logger.warn`. 로그 뷰어에서 레벨 필터링으로 장애를 찾을 수 있어야 한다.

3. **catch 블록에서 `console.error` 대신 `logger.warn`을 쓴다.** 구조화된 로그만 로그 뷰어에 노출되므로, `console.*`으로만 남기면 운영 중 확인 불가. `console.error`는 서버 시작·마이그레이션 등 logger 사용 불가 시점에만 허용.

   예외 하나 더 — **로거의 저장소 자체가 실패 대상인 경로.** `shared/express-setup.mjs`의 인증 재검증 실패 분기가 이에 해당한다. `createLogger(db)`는 검증기가 조회하던 바로 그 DB에 `INSERT` 하고 로그 뷰어도 같은 DB를 읽으므로, 이 분기를 타게 만드는 대표 원인(auth의 `SQLITE_BUSY`/`IOERR`)에서는 DB 로깅이 무용하다. 이런 경로에서만 `console.warn`이 옳으며, 이유를 주석에 남긴다. "logger를 쓸 수 없어서"가 아니라 "logger가 못 미더운 상황이라서"가 기준이다.

4. **서비스 간 통신 실패는 반드시 로깅한다.** fetch 실패, 타임아웃 등을 `logger.warn`으로 기록하여 어떤 서비스가 왜 실패했는지 추적 가능하게 한다.

5. **파괴적 작업(cascade 삭제, 파일 정리)은 성공·실패 모두 반드시 로깅한다.** 감사 로그만으로 대상과 결과를 확인할 수 있어야 한다.

6. **detail에는 사람이 이해할 수 있는 충분한 맥락을 누락 없이 포함한다.** 로그만 보고 무슨 일이 있었는지 완전히 파악할 수 있어야 한다. 실패 로그에는 `{ error: "..." }` 형태로 에러 원인을, 성공 로그에는 변경된 값·대상·조건 등 핵심 정보를 담는다. ID만 남기고 이름을 빠뜨리거나, 에러 객체를 그대로 던지는 등 맥락이 불충분한 로그를 남기지 않는다.

## References

See `docs/api.md` for endpoints, `docs/architecture.md` for runtime design, `docs/user-guide.md` for operator behavior, and `.env.example` for environment variables.
