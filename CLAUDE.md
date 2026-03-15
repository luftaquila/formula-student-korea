# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Formula Student Korea Service Hub - a microservices-based web application for managing vehicle entry registration, inspection queue, traffic controller data, score aggregation, and energy meter monitoring for Formula Student Korea events.

## Architecture

Ten independent services deployed via Docker Compose behind a Caddy reverse proxy (port 9000):

- **landing/** - Landing page and reverse proxy gateway (Vue 3 + Caddy)
- **auth/** - Authentication and user management API + web UI (Express + Vue 3, port 9800)
- **entry/** - Vehicle entry registration API + web UI (Express + Vue 3, port 9100)
- **queue/** - Inspection queue management API + web UI (Express + Vue 3, port 9300)
- **inspection/** - Inspection sheet management API + web UI (Express + Vue 3, port 9600)
- **traffic/** - Traffic control, telemetry, and event mode management API + web UI (Express + Vue 3, port 9200)
- **score/** - Score aggregation, penalty/scoring config, and management API + web UI (Express + Vue 3, port 9700)
- **documents/** - Document submission management API + web UI (Express + Vue 3, port 9900)
- **energymeter/** - Energy meter data viewer (Git submodule, Vue 3, port 9400)
- **rules/** - Rules file server (Caddy, port 9500)

All 7 backend services (auth, entry, queue, inspection, traffic, score, documents) use a single parameterized `Dockerfile.service` at the repo root, with `ARG SERVICE` and `ARG PORT` passed via `docker-compose.yml` build args.

**Shared modules** in `shared/` are imported directly by other services:
- `vite-config.js` - Vite config factory `createViteConfig(serviceName, servicePort, options)` — handles base path, proxy, aliases; options: `{ entryProxy, server, build, aliases }`
- `styles/base.css` - Common CSS variables, resets, and component styles
- `styles/layout.css` - Common app layout CSS (header, main-content, responsive) — uses `--layout-max-width` CSS variable for per-service width customization
- `express-setup.mjs` - Express app factory with cookie parsing, JWT auth middleware, process handlers, DB error helper; exports `ROLE_LEVELS` map and `VALID_ROLES` array
- `logger.mjs` - SQLite-based semantic logger factory `createLogger(db, serviceName, maxRows)` — structured action logging with auto-cleanup and query endpoint
- `api-base.js` - Frontend API client factory with 401 redirect and entry service helpers
- `NavMenu.vue` - Navigation drawer component used across all frontends
- `nav-config.js` - Service menu configuration (services, officials, admins arrays; items may have `auth` property (e.g. `"student"`, `"chief"`) to restrict visibility by role level)
- `officialsStore.js` - Cookie-based auth state (user, isAuthenticated, showOfficials, isChief, isAdmin)
- `ThemeToggle.vue` - Dark/light theme toggle button component
- `theme-init.js` - Theme initialization (localStorage + prefers-color-scheme)
- `useSSE.js` - Frontend SSE connection factory with auto-reconnect
- `sse.mjs` - Backend SSE manager (broadcast + endpoint handler)

Service dependencies (via environment variables in `docker-compose.yml`):
- entry → auth (`AUTH_SERVER`)
- traffic → entry (`ENTRY_SERVER`), auth (`AUTH_SERVER`)
- queue → entry (`ENTRY_SERVER`), auth (`AUTH_SERVER`)
- inspection → entry (`ENTRY_SERVER`), auth (`AUTH_SERVER`)
- score → entry (`ENTRY_SERVER`), inspection (`INSPECTION_SERVER`), traffic (`TRAFFIC_SERVER`), auth (`AUTH_SERVER`)
- documents → entry (`ENTRY_SERVER`), auth (`AUTH_SERVER`)

All non-auth services validate users via `AUTH_SERVER` (shared express-setup.mjs middleware). Auth validation uses fail-open: if auth service is temporarily unreachable, JWT is trusted (only explicit 404 invalidates sessions). Score service uses `X-Internal-Service` header for inter-service auth to inspection/traffic APIs.

## Tech Stack

- **Frontend:** Vue 3, Vite, Vue Router, Pinia (traffic, energymeter only)
- **Backend:** Node.js 22, Express.js 5, Better-SQLite3
- **Auth:** Google OAuth 2.0, JWT (HMAC-SHA256) cookies, role-based access control
- **Real-time:** Server-Sent Events (SSE) for live updates across inspection, queue, score, and traffic services
- **Deployment:** Docker Compose with Caddy reverse proxy
- **Logging:** SQLite-based semantic logging (`shared/logger.mjs`)

## Build Commands

### Frontend Development
```bash
cd landing|auth/web|entry/web|queue/web|inspection/web|traffic/web|score/web|documents/web|energymeter/viewer
npm run dev        # Dev server with hot reload
npm run build      # Production build
```

### Backend Development
```bash
cd auth|entry|queue|inspection|traffic|score|documents
node index.mjs     # Run API server directly
```

### Docker Deployment
```bash
podman compose --profile local build    # Build all containers
podman compose --profile local up -d    # Start all containers (local dev)
```

## Key Files

- `Dockerfile.service` - Parameterized Dockerfile for all 7 backend services (uses `ARG SERVICE` and `ARG PORT`); runs as non-root `node` user via `entrypoint.sh` + `su-exec`
- `entrypoint.sh` - Container entrypoint: fixes `data/` ownership then drops to `node` user (works with both root Docker and podman rootless)
- `docker-compose.yml` - Service orchestration (passes build args to `Dockerfile.service`)
- `shared/vite-config.js` - Shared Vite config factory used by all 7 frontend builds
- `shared/styles/layout.css` - Common app layout CSS shared across all frontends
- `shared/express-setup.mjs` - Shared Express app factory with JWT auth middleware
- `shared/logger.mjs` - Shared SQLite semantic logger
- `landing/Caddyfile` - Route configuration for all services (reverse proxy, zstd/gzip compression excluding `text/event-stream`, static asset caching)
- `auth/index.mjs` - Auth service API server (Google OAuth, user management, log aggregation)
- `entry/index.mjs` - Entry service API server
- `queue/index.mjs` - Queue service API server
- `inspection/index.mjs` - Inspection sheet service API server
- `traffic/index.mjs` - Traffic service API server
- `score/index.mjs` - Score aggregation service API server
- `documents/index.mjs` - Document submission service API server
- `rules/Caddyfile` - Rules file server configuration

## Authentication

Google OAuth 2.0 with JWT cookie-based sessions. Auth logic is handled by backend middleware in `shared/express-setup.mjs`. Caddy is a pure reverse proxy with no auth logic.

### Auth Flow
1. Admin registers users (email + role) via `/auth` management page
2. Protected API call → backend middleware verifies JWT cookie → 401 if missing/invalid
3. Frontend `api-base.js` detects 401 → redirects to `/auth/login?redirect=...`
4. Login page → Google OAuth → callback verifies email in DB → sets JWT + display cookies
5. `ADMIN_EMAIL` env var: bootstraps initial admin user on auth service startup

### Cookies
- `fsk_session`: httpOnly JWT (`{ email, name, role, exp }`) — auth verification
- `fsk_user`: non-httpOnly JSON (`{ name, role }`) — frontend display
- Common: `Path=/`, `SameSite=Lax`, `Secure` in production

### Roles (four permission levels, hierarchical)

**Role hierarchy**: `public < student < official < chief < admin`

Role levels are defined in `shared/express-setup.mjs` as `ROLE_LEVELS = { student: 1, official: 2, chief: 3, admin: 4 }`. Auth middleware compares user's role level against the required role level — a user with a higher-level role can access lower-level resources.

Each service's `createApp(deps, authRoleFn)` receives `deps` (`{ express, validateUser? }`) and an `authRoleFn(req)` callback that returns:
- `null` — public (no auth required)
- `"student"` — student or above (student, official, chief, admin)
- `"official"` — official or above (official, chief, admin)
- `"chief"` — chief or above (chief, admin)
- `"admin"` — admin only

**Dev mode:** When `JWT_SECRET` is not set, all requests are auto-authenticated as admin. A one-time warning is logged at startup.

**Security hardening:**
- JWT `verifyJWT()` explicitly validates `alg: "HS256"` header
- Auth middleware rejects tokens with unknown role values (only `student`/`official`/`chief`/`admin` accepted)
- Traffic service validates record names against whitelist regex after sanitization
- OAuth callback returns generic `access_denied` error for both unregistered and deactivated users (prevents account enumeration)
- Containers run Node.js as non-root `node` user (PID 1) via `su-exec` entrypoint

### Per-service auth rules

**entry** — `/api/years` and `/api/entries` public, everything else (SPA + other API) admin
**queue** — `/api/admin` and SPA management pages (`/admin`, `/register`, `/priority`, `/stats`) official, everything else public
**inspection** — `/api/sheet/template` non-GET (POST/PUT/DELETE) admin, all other API/SPA (including GET template) official
**traffic** — everything admin
**score** — everything admin
**documents** — `/api/admin/*` and `/admin/*` SPA pages chief, all other API/SPA student
**auth** — login/callback/logout and SPA public, `/api/admin/*` and `/api/users` (and `/api/users/*`) admin, everything else public

### Inter-service communication
Score service uses `X-Internal-Service` header (matching `INTERNAL_SECRET` env var) when calling inspection/traffic APIs. The middleware auto-authenticates these as admin.

## Environment Variables

See `.env.example` for all required variables:
- `DOMAIN_NAME` — Traefik reverse proxy domain (production only)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Google OAuth credentials
- `JWT_SECRET` — HMAC key for JWT signing (omit for dev auto-auth)
- `INTERNAL_SECRET` — Service-to-service auth token
- `ADMIN_EMAIL` — Bootstrap admin email on first auth service start
- `LOG_SERVICES` — Auth service log aggregation: comma-separated `name:url` pairs (e.g., `entry:http://entry:9100,queue:http://queue:9300,...`)
- `NAVER_CLOUD_ACCESS_KEY`, `NAVER_CLOUD_SECRET_KEY`, `NAVER_CLOUD_SMS_SERVICE_ID`, `PHONE_NUMBER_SMS_SENDER` — Queue SMS API (optional)

## Environment-Aware Builds

Production builds use service-specific base paths (`/auth/`, `/entry/`, `/queue/`, `/inspection/`, `/traffic/`, `/score/`, `/documents/`, `/energymeter/`) configured via `shared/vite-config.js` factory. Each service's `vite.config.js` calls `createViteConfig(serviceName, port, options)` which auto-sets the base path in production mode. Development builds use empty base paths with Vite proxy routing to backend APIs.

## Data Storage

All SQLite databases use WAL mode (`journal_mode=WAL`, `synchronous=NORMAL`). Each `.db` file has accompanying `-wal` and `-shm` files that must be included in backups.

SQLite databases stored in volume-mounted directories:
- `auth/data/` - auth.db
- `entry/data/` - entry.db
- `queue/data/` - queue.db
- `inspection/data/` - sheet.db
- `traffic/data/` - traffic.db
- `score/data/` - score.db
- `documents/data/` - documents.db, uploads/

Each service's database includes a `logs` table for semantic action logging (managed by `shared/logger.mjs`).

## Logging System

SQLite-based semantic logging replaces the previous pino-http NDJSON file logging. Each service uses `shared/logger.mjs` to record structured action logs to a `logs` table in its own database.

### Logger API
`createLogger(db, serviceName, maxRows = 10000)` returns:
- `log(req, action, detail?, target?, actorOverride?)` — info level
- `warn(req, action, detail?, target?, actorOverride?)` — warn level
- `error(req, action, detail?, target?, actorOverride?)` — error level
- `queryHandler` — Express route handler for `GET /api/logs` (admin or internal service only)

Actor is extracted from `req.user`; `actorOverride` is used when `req.user` is unavailable (e.g., OAuth callback). Detail is auto-serialized to JSON if not a string. Auto-cleanup runs hourly, keeping only the newest `maxRows` entries.

### Log Aggregation
Auth service provides `GET /api/admin/logs` which queries all services' `/api/logs` endpoints in parallel (via `LOG_SERVICES` env var) and merges results by timestamp. The admin log viewer UI is at `/auth/logs`.

### Per-service Log Query
Each service exposes `GET /api/logs` with query parameters: `limit`, `offset`, `level`, `action` (prefix match), `actor` (substring), `from`, `to`, `search` (action/target/detail). Requires admin role or `X-Internal-Service` header.

## Traffic Service: Event Modes

Event types (가속, 스키드패드, 오토크로스, 짐카나) are managed via the `event_mode` table in traffic.db. Each mode can be enabled/disabled from the traffic record management page. Disabled modes are hidden from:
- Traffic navigation tabs (NavTabs.vue)
- Score service scoreboard columns
- Score service penalty/scoring settings

The "내구" (endurance) event is always shown in the score service regardless of event mode settings.

## Score Service: Scoring System

### Database Tables
- `score_penalty` — per-event-type penalty config: `cone_penalty`, `oc_penalty`, `start_delay` (seconds)
- `score_setting` — per-event-type scoring config: `total` (max points), `finish` (completion points), `cutoff` (% threshold)
- `score_manual` — manual input scores per team: `report`, `energy`
- `score_endurance` — per-team endurance (내구) detailed records: `status` (DNS/DNF/DSQ/null), per-driver `time`, `start_delay`, `cones`, `oc`, `penalty` (minutes), and `driver_change_time`

### Endurance (내구) Records
Endurance records are managed via a dedicated input page (`/score/endurance`) instead of the traffic service. Each team's endurance record has two drivers with separate times, penalties, and a driver change overtime. The backend computes:
```
result = d1_time + d2_time + change_time + start_delay_penalty + manual_penalty
cones = d1_cones + d2_cones, oc = d1_oc + d2_oc
```
The frontend then applies cone/OC penalties via `getAdjustedResult()` as with other events. Status values: DNS (no record), DNF/DSQ (result=-1), null (normal).

### Score Calculation
Best record per team = lowest penalty-adjusted time (excluding invalidated records):
```
adjusted_time = raw_result + cones × cone_penalty × 1000 + oc × oc_penalty × 1000
```

Dynamic event score formula:
```
score = (total - finish) × ((cutoff × best_time / my_time) - 1) / (cutoff - 1) + finish
```
- `cutoff` is stored as percentage (e.g., 145) and converted to ratio (1.45) for calculation
- Teams exceeding `best_time × cutoff` receive only `finish` points
- DNF teams receive 0 points
- Score is clamped between `finish` and `total`, rounded to 2 decimal places

Total score = sum of all dynamic event scores + endurance score + report + energy

### Display Modes
The scoreboard supports record/score toggle (persisted in localStorage):
- **Record mode**: shows penalty-adjusted best times in MM:SS.mmm format
- **Score mode**: shows calculated scores per event type

### Expandable Detail Rows
Clicking a team row expands a detail row showing all individual runs per event type. The `GET /api/score` response includes `allRuns` array (with `time`, `result`, `cones`, `oc`, `invalidated`) in each team's event record alongside the best record. Detail rows display event type (rowspan-grouped), timestamp, raw time, cone/OC counts, penalty-adjusted time, and status badges (best/invalidated). Supports time-order/score-order sort toggle.
