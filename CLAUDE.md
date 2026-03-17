# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Formula Student Korea Service Hub - a microservices-based web application for managing vehicle entry registration, inspection queue, traffic controller data, score aggregation, document submission, and energy meter monitoring for Formula Student Korea events.

## Architecture

Eleven independent services deployed via Docker Compose behind a Caddy reverse proxy (port 9000):

- **landing/** - Landing page and reverse proxy gateway (Vue 3 + Caddy)
- **auth/** - Authentication and user management API + web UI (Express + Vue 3, port 9800)
- **entry/** - Vehicle entry registration API + web UI (Express + Vue 3, port 9100)
- **queue/** - Inspection queue management API + web UI (Express + Vue 3, port 9300)
- **inspection/** - Inspection sheet management API + web UI (Express + Vue 3, port 9600)
- **traffic/** - Traffic control, telemetry, and event mode management API + web UI (Express + Vue 3, port 9200)
- **score/** - Score aggregation, penalty/scoring config, and management API + web UI (Express + Vue 3, port 9700)
- **documents/** - Document submission management API + web UI (Express + Vue 3, port 9900)
- **filebrowser/** - Cloud file storage (FileBrowser, proxy auth via Caddy forward_auth, port 8080)
- **energymeter/** - Energy meter data viewer (Git submodule, Vue 3, port 9400)
- **rules/** - Rules file server (Caddy, port 9500)

All 7 backend services (auth, entry, queue, inspection, traffic, score, documents) use a single parameterized `Dockerfile.service` at the repo root, with `ARG SERVICE` and `ARG PORT` passed via `docker-compose.yml` build args.

**Shared modules** in `shared/` are imported directly by other services:
- `vite-config.js` - Vite config factory `createViteConfig(serviceName, servicePort, options)` — handles base path, proxy, aliases; options: `{ entryProxy, server, build, aliases }`
- `styles/base.css` - Common CSS variables, resets, and component styles
- `styles/layout.css` - Common app layout CSS (header, main-content, responsive) — uses `--layout-max-width` CSS variable for per-service width customization
- `constants.js` - Shared constants; exports `ROLE_LEVELS` object (used by express-setup.mjs and officialsStore.js)
- `express-setup.mjs` - Express app factory with cookie parsing, JWT auth middleware, process handlers, DB error helper; exports `createApp`, `createJWT`, `ensureDataDir`, `VALID_ROLES`, `setupProcessHandlers`, `createDbRun`, `isSecureConnection`, `formatCookieOpts`
- `logger.mjs` - SQLite-based semantic logger factory `createLogger(db, serviceName, maxRows)` — structured action logging with auto-cleanup and query endpoint
- `api-base.js` - Frontend API client factory with 401 redirect and entry service helpers
- `NavMenu.vue` - Navigation drawer component used across all frontends
- `nav-config.js` - Service menu configuration (services, officials, admins arrays; items may have `auth` property (e.g. `"student"`, `"chief"`) to restrict visibility by role level)
- `officialsStore.js` - Cookie-based auth state (user, isAuthenticated, showOfficials, isChief, isAdmin)
- `ThemeToggle.vue` - Dark/light theme toggle button component
- `theme-init.js` - Theme initialization (localStorage + prefers-color-scheme)
- `useSSE.js` - Frontend SSE connection factory with auto-reconnect
- `sse.mjs` - Backend SSE manager (broadcast + endpoint handler)
- `format-phone.js` - Phone number formatting utilities; exports `formatPhone(value)` (input formatting) and `displayPhone(phone)` (display formatting)

Service dependencies (via environment variables in `docker-compose.yml`):
- entry → auth (`AUTH_SERVER`)
- inspection → auth (`AUTH_SERVER`)
- traffic → auth (`AUTH_SERVER`)
- queue → entry (`ENTRY_SERVER`), auth (`AUTH_SERVER`)
- score → entry (`ENTRY_SERVER`), inspection (`INSPECTION_SERVER`), traffic (`TRAFFIC_SERVER`), auth (`AUTH_SERVER`)
- documents → auth (`AUTH_SERVER`)

All non-auth services validate users via `AUTH_SERVER` (shared express-setup.mjs middleware). Auth validation uses fail-open: if auth service is temporarily unreachable, JWT is trusted (only explicit 404 invalidates sessions).

## Tech Stack

- **Frontend:** Vue 3, Vite, Vue Router, Pinia (traffic, energymeter only)
- **Backend:** Node.js 22, Express.js 5, Better-SQLite3
- **Auth:** Google OAuth 2.0, JWT (HMAC-SHA256) cookies, role-based access control
- **Real-time:** Server-Sent Events (SSE) for live updates across inspection, queue, score, and traffic services
- **Deployment:** Docker Compose with Caddy reverse proxy
- **Testing:** Node.js built-in test runner (`node:test` + `node:assert`)
- **Logging:** SQLite-based semantic logging (`shared/logger.mjs`)

## Build Commands

### Frontend Development
```bash
cd landing|auth/web|entry/web|queue/web|inspection/web|traffic/web|score/web|documents/web|energymeter/viewer
npm run dev        # Dev server with hot reload
npm run build      # Production build
```

### Backend Development

Each service's `index.mjs` exports a `create*App(options)` factory function for testability. When run directly (`node index.mjs`), the service starts the HTTP server. The factory accepts `{ dbPath }` (and service-specific options like `skipSSESubscriptions` for score, `uploadsDir` for documents) and returns `{ app, db }`.

```bash
cd auth|entry|queue|inspection|traffic|score|documents
node index.mjs     # Run API server directly
```

### Docker Deployment

Prerequisites:
1. **Podman machine**: `podman machine init && podman machine start` (first time only)
2. **Git submodules**: `git submodule update --init --recursive` (energymeter is a submodule)
3. **`.env` file**: Copy `.env.example` to `.env` and set at minimum `JWT_SECRET` and `INTERNAL_SECRET` (any non-empty value works for local dev). Docker images set `NODE_ENV=production`, so services will fail-fast without `JWT_SECRET`.

A `Makefile` wraps common podman compose operations. It auto-prunes dangling images before builds to prevent overlay storage slowdowns. Default profile is `production`.

```bash
make deploy              # Build all + restart (production)
make deploy SVC=traffic  # Build specific service + restart
make deploy NO_CACHE=1   # Build all without cache + restart
make build               # Build only
make build SVC=traffic   # Build specific service only
make restart             # Restart only (no build)
```

For local development, override the profile:
```bash
make deploy PROFILE=local
```

Access at `http://localhost:9000` after starting with `local` profile.

## Authentication

Google OAuth 2.0 with JWT cookie-based sessions. Auth logic is handled by backend middleware in `shared/express-setup.mjs`. Caddy strips `X-Internal-Service` and `Authuser` headers from all incoming requests (preventing external spoofing); the auth service route additionally strips `X-Forwarded-Host`.

Caddy also performs `forward_auth` for the FileBrowser service — see "FileBrowser" section below.

### Roles (four permission levels, hierarchical)

**Role hierarchy**: `public < student < official < chief < admin`

Role levels are defined in `shared/constants.js` as `ROLE_LEVELS = { student: 1, official: 2, chief: 3, admin: 4 }`. Auth middleware compares user's role level against the required role level — a user with a higher-level role can access lower-level resources.

Each service's `createApp(deps, authRoleFn)` receives `deps` (`{ express, validateUser? }`) and an `authRoleFn(req)` callback that returns:
- `null` — public (no auth required)
- `"student"` — student or above (student, official, chief, admin)
- `"official"` — official or above (official, chief, admin)
- `"chief"` — chief or above (chief, admin)
- `"admin"` — admin only

**Dev mode:** When `JWT_SECRET` is not set and `NODE_ENV` is not `"production"`, all requests are auto-authenticated as admin. A one-time warning is logged at startup. Only applies when running services directly outside Docker (e.g. `node index.mjs`).

### Route Permission Matrix

**Public:** `/` (landing), `/auth/login,callback,logout`, `/auth` (SPA), `/queue` + `/queue/api` (except admin), `/entry/api/years` + `/entry/api/entries`, `/energymeter`, `/rules`

**Student:** `/documents/**`

**Official:** `/auth/api/ops-contacts` (GET), `/queue/admin,register,priority,stats`, `/queue/api/admin`, `/inspection/**`

**Chief:** `/documents/admin`, `/documents/api/admin/**`, `/files/**` (FileBrowser)

**Admin:** `/entry/**` (except public API), `/auth/api/ops-contacts` (POST/DELETE), `/inspection/api/sheet/template` (POST/PUT/DELETE), `/traffic/**`, `/score/**`, `/auth/api/users`, `/*/api/logs`, `/auth/api/admin/logs`, `/auth/logs`

### Traffic: Event Mode Management

Event types (가속, 스키드패드, 오토크로스, 짐카나) can be enabled/disabled from the traffic record management page. Disabled modes are hidden from traffic navigation tabs and score service tables. The "내구" (endurance) event is always shown in the score service regardless of event mode settings.

### Score: Scoring System

Penalty settings (per-event cone touch, off-course, start delay penalties in seconds), score settings (per-event total points, completion points, cutoff percentage), auto-calculated scores based on penalty-adjusted best records using the FSK scoring formula. Record/Score toggle switches between viewing penalty-adjusted times and calculated scores. Total score = sum of all event scores + endurance + report + energy.

### Inter-service communication

All inter-service API calls use `X-Internal-Service` header (matching `INTERNAL_SECRET` env var), auto-authenticated as admin. Score service subscribes to inspection and traffic SSE endpoints, re-broadcasting events to score clients with `inspection:*` and `traffic:*` prefixes. Auth service aggregates logs from all other services via `LOG_SERVICES` env var.

### Auth API endpoints for external integration

- `GET /api/session` — public, returns `{ name, role }` for the current JWT session or 401. Used by the landing page to verify cookie state on load (so deactivated users immediately lose menu visibility).
- `GET /api/forward-auth?role=<role>` — internal only (requires `X-Forward-Auth-Key` header matching `INTERNAL_SECRET`, timing-safe comparison). Validates JWT and checks role level, returns 200 with `X-Forwarded-User` header or 401/403. Used by Caddy's `forward_auth` for FileBrowser.

### FileBrowser

Cloud file storage at `/files/`, restricted to chief+ roles. Uses [FileBrowser](https://filebrowser.org/) Docker image with proxy auth mode.

**Auth flow:** Request → Caddy `forward_auth` (sends `X-Forward-Auth-Key` + user's cookies to `auth:9800/api/forward-auth?role=chief`) → auth validates JWT + role → returns `X-Forwarded-User` header with email → Caddy copies header to FileBrowser → FileBrowser auto-creates/authenticates user. Unauthenticated users (401) are redirected to `/auth/api/login?redirect=/files/`.

**Architecture:**
- `filebrowser/init.sh` — entrypoint script; initializes DB with proxy auth config (`--auth.method=proxy --auth.header=X-Forwarded-User`) on first run only (when `/data/filebrowser.db` doesn't exist)
- `filebrowser/data/` — persistent data (DB + uploaded files), gitignored via `data/` pattern
- Caddy overrides `Content-Security-Policy` for `/files/*` to allow FileBrowser's inline scripts/styles and data: fonts
- Caddy container requires `INTERNAL_SECRET` env var (used in `{env.INTERNAL_SECRET}` Caddyfile placeholder for `forward_auth` header)
- `X-Forward-Auth-Key` is a separate header from `X-Internal-Service` to avoid the auth middleware intercepting it and overriding `req.user` with the internal service identity (which would bypass the actual user's JWT validation)

**Important: FileBrowser DB reset** — when deleting `filebrowser/data/filebrowser.db`, the container must be recreated (not just restarted) so `init.sh` runs again to reinitialize proxy auth config. Use `podman rm -f fsk-filebrowser && podman compose --profile production up -d filebrowser`.

## Testing

Backend services and shared modules are tested using Node.js built-in test runner (`node:test`).

### Running Tests
```bash
npm test                          # Run all tests
npm run test:shared               # Shared modules only
npm run test:auth                 # Auth service only
npm run test:entry                # Entry service only
npm run test:queue                # Queue service only
npm run test:inspection           # Inspection service only
npm run test:traffic              # Traffic service only
npm run test:score                # Score service only
npm run test:documents            # Documents service only
```

### Test Architecture
- Each service's `index.mjs` exports a `create*App(options)` factory function for testability
- Tests use in-memory/temp SQLite databases (no external services needed)
- External service dependencies are mocked with lightweight Express servers
- Tests run in CI via GitHub Actions on push to main and PRs

### Writing Tests
- Test files go in `tests/<service>/<service>.test.mjs`
- Shared module tests go in `tests/shared/<module>.test.mjs`
- Use `tests/helpers/test-utils.mjs` for common utilities (JWT, HTTP client, temp DB)

## Environment Variables

See `.env.example` for all required variables.
