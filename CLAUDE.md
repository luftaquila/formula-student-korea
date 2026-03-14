# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Formula Student Korea Service Hub - a microservices-based web application for managing vehicle entry registration, inspection queue, traffic controller data, score aggregation, and energy meter monitoring for Formula Student Korea events.

## Architecture

Nine independent services deployed via Docker Compose behind a Caddy reverse proxy (port 9000):

- **landing/** - Landing page and reverse proxy gateway (Vue 3 + Caddy)
- **auth/** - Authentication and user management API + web UI (Express + Vue 3, port 9800)
- **entry/** - Vehicle entry registration API + web UI (Express + Vue 3, port 9100)
- **queue/** - Inspection queue management API + web UI (Express + Vue 3, port 9300)
- **inspection/** - Inspection sheet management API + web UI (Express + Vue 3, port 9600)
- **traffic/** - Traffic control and telemetry API + web UI (Express + Vue 3, port 9200)
- **score/** - Score aggregation and management API + web UI (Express + Vue 3, port 9700)
- **energymeter/** - Energy meter data viewer (Git submodule, Vue 3, port 9400)
- **rules/** - Rules file server (Caddy, port 9500)

All 6 backend services (auth, entry, queue, inspection, traffic, score) use a single parameterized `Dockerfile.service` at the repo root, with `ARG SERVICE` and `ARG PORT` passed via `docker-compose.yml` build args.

**Shared modules** in `shared/` are imported directly by other services:
- `vite-config.js` - Vite config factory `createViteConfig(serviceName, servicePort, options)` — handles base path, proxy, aliases; options: `{ entryProxy, server, build, aliases }`
- `styles/base.css` - Common CSS variables, resets, and component styles
- `styles/layout.css` - Common app layout CSS (header, main-content, responsive) — uses `--layout-max-width` CSS variable for per-service width customization
- `express-setup.mjs` - Express app factory with cookie parsing, JWT auth middleware, process handlers, DB error helper
- `api-base.js` - Frontend API client factory with 401 redirect and entry service helpers
- `NavMenu.vue` - Navigation drawer component used across all frontends
- `nav-config.js` - Service menu configuration (services, officials, admins arrays)
- `officialsStore.js` - Cookie-based auth state (user, showOfficials, isAdmin)
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

All non-auth services validate users via `AUTH_SERVER` (shared express-setup.mjs middleware). Score service uses `X-Internal-Service` header for inter-service auth to inspection/traffic APIs.

## Tech Stack

- **Frontend:** Vue 3, Vite, Vue Router, Pinia (traffic, energymeter only)
- **Backend:** Node.js 22, Express.js 5, Better-SQLite3
- **Auth:** Google OAuth 2.0, JWT (HMAC-SHA256) cookies, role-based access control
- **Real-time:** Server-Sent Events (SSE) for live updates across inspection, queue, score, and traffic services
- **Deployment:** Docker Compose with Caddy reverse proxy
- **Logging:** Pino-HTTP

## Build Commands

### Frontend Development
```bash
cd landing|auth/web|entry/web|queue/web|inspection/web|traffic/web|score/web|energymeter/viewer
npm run dev        # Dev server with hot reload
npm run build      # Production build
```

### Backend Development
```bash
cd auth|entry|queue|inspection|traffic|score
node index.mjs     # Run API server directly
```

### Docker Deployment
```bash
podman compose --profile local build    # Build all containers
podman compose --profile local up -d    # Start all containers (local dev)
```

## Key Files

- `Dockerfile.service` - Parameterized Dockerfile for all 6 backend services (uses `ARG SERVICE` and `ARG PORT`)
- `docker-compose.yml` - Service orchestration (passes build args to `Dockerfile.service`)
- `shared/vite-config.js` - Shared Vite config factory used by all 6 frontend builds
- `shared/styles/layout.css` - Common app layout CSS shared across all frontends
- `shared/express-setup.mjs` - Shared Express app factory with JWT auth middleware
- `landing/Caddyfile` - Route configuration for all services (reverse proxy)
- `auth/index.mjs` - Auth service API server (Google OAuth, user management)
- `entry/index.mjs` - Entry service API server
- `queue/index.mjs` - Queue service API server
- `inspection/index.mjs` - Inspection sheet service API server
- `traffic/index.mjs` - Traffic service API server
- `score/index.mjs` - Score aggregation service API server
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

### Roles (two permission levels)
Each service's `createApp()` receives an `authRoleFn(req)` callback that returns:
- `null` — public (no auth required)
- `"official"` — any authenticated user (official or admin)
- `"admin"` — admin only

**Dev mode:** When `JWT_SECRET` is not set, all requests are auto-authenticated as admin.

### Per-service auth rules

**entry** — API public, SPA admin-only
**queue** — `/api/admin` and SPA management pages (`/admin`, `/register`, `/priority`, `/stats`) official, everything else public
**inspection** — `/api/sheet/template` non-GET (POST/PUT/DELETE) admin, all other API/SPA (including GET template) official
**traffic** — `/api/events` and `/api/records/:id` official, all other API/SPA admin
**score** — everything admin
**auth** — login/callback/logout public, `/api/users` admin

### Inter-service communication
Score service uses `X-Internal-Service` header (matching `INTERNAL_SECRET` env var) when calling inspection/traffic APIs. The middleware auto-authenticates these as admin.

## Environment Variables

See `.env.example` for all required variables:
- `DOMAIN_NAME` — Traefik reverse proxy domain (production only)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Google OAuth credentials
- `JWT_SECRET` — HMAC key for JWT signing (omit for dev auto-auth)
- `INTERNAL_SECRET` — Service-to-service auth token
- `ADMIN_EMAIL` — Bootstrap admin email on first auth service start
- `NAVER_CLOUD_ACCESS_KEY`, `NAVER_CLOUD_SECRET_KEY`, `NAVER_CLOUD_SMS_SERVICE_ID`, `PHONE_NUMBER_SMS_SENDER` — Queue SMS API (optional)

## Environment-Aware Builds

Production builds use service-specific base paths (`/auth/`, `/entry/`, `/queue/`, `/inspection/`, `/traffic/`, `/score/`, `/energymeter/`) configured via `shared/vite-config.js` factory. Each service's `vite.config.js` calls `createViteConfig(serviceName, port, options)` which auto-sets the base path in production mode. Development builds use empty base paths with Vite proxy routing to backend APIs.

## Data Storage

SQLite databases stored in volume-mounted directories:
- `auth/data/` - auth.db, auth.log
- `entry/data/` - entry.db, entry.log
- `queue/data/` - queue.db, queue.log
- `inspection/data/` - sheet.db, sheet.log
- `traffic/data/` - traffic.db, traffic.log
- `score/data/` - score.db, score.log
