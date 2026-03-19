# CLAUDE.md

Formula Student Korea Service Hub — microservices web app for vehicle entry, inspection queue, traffic control, scoring, document submission, and energy meter monitoring.

## Architecture

11 services behind Caddy reverse proxy (port 9000), deployed via Docker Compose:

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
| files/ | Cloud file storage (FileBrowser, Caddy forward_auth) | 8080 |
| energymeter/ | Energy meter viewer (Git submodule, Vue 3) | 9800 |
| rules/ | Rules file server (Caddy) | 9900 |

All 7 backend services share `Dockerfile.service` (root) with `ARG SERVICE` + `ARG PORT`. Shared modules in `shared/`.

**Service dependencies** (env vars in `compose.yml`):
- entry, inspection, traffic, documents → auth (`AUTH_SERVER`)
- queue → entry (`ENTRY_SERVER`), auth (`AUTH_SERVER`)
- score → entry, inspection, traffic, auth

All non-auth services validate via `AUTH_SERVER` (fail-close: only 200 confirms user).

## Tech Stack

Frontend: Vue 3, Vite, Vue Router, Pinia (traffic/energymeter only) · Backend: Node.js 22, Express.js 5, Better-SQLite3 · Auth: Google OAuth 2.0, JWT (HMAC-SHA256) cookies, RBAC · Real-time: SSE (inspection, queue, score, traffic) · Deploy: Docker Compose + Caddy · Testing: `node:test` + `node:assert`, Playwright (E2E)

## Commands

```bash
# Frontend dev
cd {service}/web && npm run dev|build

# Backend dev — each index.mjs exports create*App(options) factory
cd {service} && node index.mjs

# Docker (Makefile wraps podman compose, auto-prunes)
make deploy                    # Build all + restart (production)
make deploy SVC=traffic        # Single service
make deploy NO_CACHE=1         # No cache
make build / make restart      # Build only / restart only
make deploy PROFILE=local      # Local dev (localhost:9000)
```

Prerequisites: podman machine, `git submodule update --init --recursive`, `.env` from `.env.example` (min: `JWT_SECRET`, `INTERNAL_SECRET`).

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

Tests: `tests/e2e/{service}/*.spec.mjs` · CI: `.github/workflows/e2e.yml` (push to main) · Check: `gh run list` → `gh run view <id> --log-failed`

**Never use `waitForTimeout` for API saves.** Use deterministic waits:

```js
// Set up waitForResponse BEFORE the action, await AFTER
const p = page.waitForResponse(res => res.url().includes("/api/...") && res.status() === 200);
await input.blur();
await p;
```

Patterns: immediate → `waitForResponse` before action | debounced → before `fill()` | SSE → before `goto()` | cleanup (maybe no call) → `Promise.race([resp, timeout(1000)])` | inter-service sync → `expect.poll()` | client-only → Playwright auto-retry assertions.

**Parallel isolation**: never assert exact counts; use `toBeGreaterThanOrEqual`, regex, or isolated test data.

## References

See `API.md` for endpoints, `FLOW.md` for business flows, `.env.example` for env vars.
