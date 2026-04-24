# CLAUDE.md

Formula Student Korea Service Hub — microservices web app for vehicle entry, inspection queue, traffic control, scoring, document submission, course management, and energy meter monitoring.

## Architecture

13 services behind Caddy reverse proxy (port 9000), deployed via Docker Compose:

| Service | Description | Port |
|---------|-------------|------|
| landing/ | Landing page + reverse proxy gateway (Vue 3 + Caddy) | 9000 |
| auth/ | Auth & user management (Express + Vue 3) | 9100 |
| entry/ | Vehicle entry registration (Express + Vue 3) | 9200 |
| queue/ | Inspection queue management (Express + Vue 3) | 9300 |
| inspection/ | Inspection sheet management (Express + Vue 3) | 9400 |
| traffic/ | Traffic control, telemetry, event modes (Express + Vue 3) | 9500 |
| score/ | Score aggregation, penalty/scoring config (Express + Vue 3) | 9600 |
| documents/ | Document submission management (Express + Vue 3) | 9700 |
| course/ | Course cone management with RTK GPS (Express + Vue 3 + Leaflet) | 10000 |
| calendar/ | Competition schedule management (Express + Vue 3 + schedule-x) | 11000 |
| files/ | Cloud file storage (FileBrowser, Caddy forward_auth) | 8080 |
| email/ | Email/SMS management, Brevo integration (Express + Vue 3) | 9900 |
| energymeter/ | Energy meter viewer (external GHCR image, Vue 3 + Caddy) | 9800 |

All 10 backend services share `Dockerfile.service` (root) with `ARG SERVICE` + `ARG PORT`. Shared modules in `shared/`.

**Service dependencies** (env vars in `compose.yml`):
- entry, inspection, traffic, documents, course, email, calendar → auth (`AUTH_SERVER`)
- queue → entry (`ENTRY_SERVER`), auth (`AUTH_SERVER`), email (`EMAIL_SERVER`)
- auth, documents → email (`EMAIL_SERVER`)
- entry → documents (`DOCUMENTS_SERVER`), queue (`QUEUE_SERVER`)
- documents → entry (`ENTRY_SERVER`), email (`EMAIL_SERVER`)
- score → entry, inspection, traffic, auth

All non-auth services validate via `AUTH_SERVER` (fail-close: only 200 confirms user).

## Tech Stack

Frontend: Vue 3, Vite, Vue Router, Pinia (traffic/energymeter only) · Backend: Node.js 22, Express.js 5, Better-SQLite3 · Auth: Google OAuth 2.0, JWT (HMAC-SHA256) cookies, RBAC · Real-time: SSE (inspection, queue, score, traffic, course) · Deploy: Docker Compose + Caddy · Testing: `node:test` + `node:assert`, Playwright (E2E)

## Commands

```bash
# Frontend dev
cd {service}/web && npm run dev|build

# Backend dev — each index.mjs exports create*App(options) factory
cd {service} && node index.mjs

# Docker (Makefile wraps podman compose, auto-prunes)
make deploy                    # Pull images + restart (production)
make deploy SVC=traffic        # Single service
make build                     # Build locally (dev)
make restart                   # Restart only (no pull/build)
make deploy PROFILE=local      # Local dev (localhost:9000)

# Backup / Restore (scripts/ — requires sqlite3 CLI)
make backup                    # → ./backups/fsk-backup-YYYYMMDD-HHMMSS.zip
make backup DEST=/mnt/nas      # Custom destination
make restore ZIP=backups/fsk-backup-20260323-120000.zip

# Rover bring-up after a fresh image flash (reads .env, connects plugs,
# applies snap set, restarts pilot; idempotent)
scripts/provision-rover.sh <rover-ip> [--ntrip-username=<id>]
```

Prerequisites: podman machine, `.env` from `.env.example` (min: `JWT_SECRET`, `INTERNAL_SECRET`).

## Auth & Inter-service

**Roles**: `public < student < official < chief < admin`. `authRoleFn(req)` returns role or null. Non-API routes redirect to `/` on 401/403.

Caddy strips `X-Internal-Service` and `Authuser` from external requests. Inter-service calls use `X-Internal-Service` header (= `INTERNAL_SECRET`), auto-admin. Score subscribes to inspection/traffic SSE, re-broadcasts with `inspection:*`/`traffic:*` prefixes. Auth aggregates logs via `LOG_SERVICES`.

**FileBrowser** (`/files/`, chief+): uses separate `X-Forward-Auth-Key` header. DB reset requires container recreate: `podman rm -f fsk-filebrowser && podman compose --profile production up -d filebrowser`.

## Testing

```bash
npm test                    # All tests
npm run test:{service}      # Specific service
npm run test:shared         # Shared modules
```

Tests: `tests/<service>/<service>.test.mjs`, utils: `tests/helpers/test-utils.mjs`. **Always add/update tests for code changes.**

### E2E (Playwright) — CI only, do NOT run locally

Tests: `tests/e2e/{service}/*.spec.mjs` · CI: `.github/workflows/test.yml` (push to main) · Check: `gh run list` → `gh run view <id> --log-failed`

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

- `action`: dot-separated `resource.operation` (e.g., `entry.create`, `rover.request`)
- `target`: 영향받는 대상 식별자 (e.g., `#123`, `course-name`, `rover`)
- `detail`: 객체면 자동 JSON.stringify, 문자열이면 그대로 저장. null 허용
- `actorOverride`: 다른 사용자 대신 기록 시 `{ email, name, role }` 전달

### 레벨 규칙

| 상황 | 레벨 | 예시 |
|------|------|------|
| 작업 성공 | `logger.log` | `logger.log(req, "entry.create", { year, univ }, "#123")` |
| 작업 실패 (비즈니스 로직, DB 에러) | `logger.warn` | `logger.warn(req, "entry.create", { error: result.error }, "#123")` |
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

2. **같은 액션의 성공/실패는 반드시 레벨로 구분한다.** 같은 action 문자열을 써도 성공은 `logger.log`, 실패는 `logger.warn`. 로그 뷰어에서 레벨 필터링으로 장애를 찾을 수 있어야 한다.

3. **catch 블록에서 `console.error` 대신 `logger.warn`을 쓴다.** 구조화된 로그만 로그 뷰어에 노출되므로, `console.*`으로만 남기면 운영 중 확인 불가. `console.error`는 서버 시작·마이그레이션 등 logger 사용 불가 시점에만 허용.

4. **서비스 간 통신 실패는 반드시 로깅한다.** fetch 실패, 타임아웃 등을 `logger.warn`으로 기록하여 어떤 서비스가 왜 실패했는지 추적 가능하게 한다.

5. **파괴적 작업(cascade 삭제, 내부 API)은 성공·실패 모두 반드시 로깅한다.** internal API를 통한 데이터 삭제도 감사 추적이 필요하다.

6. **detail에는 사람이 이해할 수 있는 충분한 맥락을 누락 없이 포함한다.** 로그만 보고 무슨 일이 있었는지 완전히 파악할 수 있어야 한다. 실패 로그에는 `{ error: "..." }` 형태로 에러 원인을, 성공 로그에는 변경된 값·대상·조건 등 핵심 정보를 담는다. ID만 남기고 이름을 빠뜨리거나, 에러 객체를 그대로 던지는 등 맥락이 불충분한 로그를 남기지 않는다.

## References

See `API.md` for endpoints, `FLOW.md` for business flows, `.env.example` for env vars.
