# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Formula Student Korea Service Hub - a microservices-based web application for managing vehicle entry registration, inspection queue, traffic controller data, score aggregation, document submission, and energy meter monitoring for Formula Student Korea events.

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
- `express-setup.mjs` - Express app factory with cookie parsing, JWT auth middleware, process handlers, DB error helper; exports `createJWT`, `ensureDataDir`, and `VALID_ROLES` array
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

### Docker Deployment (Local)

Prerequisites:
1. **Podman machine**: `podman machine init && podman machine start` (first time only)
2. **Git submodules**: `git submodule update --init --recursive` (energymeter is a submodule)
3. **`.env` file**: Copy `.env.example` to `.env` and set at minimum `JWT_SECRET` and `INTERNAL_SECRET` (any non-empty value works for local dev). Docker images set `NODE_ENV=production`, so services will fail-fast without `JWT_SECRET`.

```bash
podman compose --profile local build    # Build all containers
podman compose --profile local up -d    # Start all containers (local dev, port 9000)
podman compose --profile local ps       # Check container status
podman compose --profile local down     # Stop all containers
```

Access at `http://localhost:9000` after starting. The `local` profile uses `caddy-local` which binds port 9000 to the host.

## Authentication

Google OAuth 2.0 with JWT cookie-based sessions. Auth logic is handled by backend middleware in `shared/express-setup.mjs`. Caddy strips `X-Internal-Service` headers from all incoming requests (preventing external spoofing) but performs no auth logic itself.

### Roles (four permission levels, hierarchical)

**Role hierarchy**: `public < student < official < chief < admin`

Role levels are defined in `shared/express-setup.mjs` as `ROLE_LEVELS = { student: 1, official: 2, chief: 3, admin: 4 }`. Auth middleware compares user's role level against the required role level — a user with a higher-level role can access lower-level resources.

Each service's `createApp(deps, authRoleFn)` receives `deps` (`{ express, validateUser? }`) and an `authRoleFn(req)` callback that returns:
- `null` — public (no auth required)
- `"student"` — student or above (student, official, chief, admin)
- `"official"` — official or above (official, chief, admin)
- `"chief"` — chief or above (chief, admin)
- `"admin"` — admin only

**Dev mode:** When `JWT_SECRET` is not set and `NODE_ENV` is not `"production"`, all requests are auto-authenticated as admin. A one-time warning is logged at startup. Only applies when running services directly outside Docker (e.g. `node index.mjs`).

### Inter-service communication

All inter-service API calls use `X-Internal-Service` header (matching `INTERNAL_SECRET` env var), auto-authenticated as admin. Score service subscribes to inspection and traffic SSE endpoints, re-broadcasting events to score clients with `inspection:*` and `traffic:*` prefixes. Auth service aggregates logs from all other services via `LOG_SERVICES` env var.

## Environment Variables

See `.env.example` for all required variables.
