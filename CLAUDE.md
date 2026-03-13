# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Formula Student Korea Service Hub - a microservices-based web application for managing vehicle entry registration, inspection queue, traffic controller data, score aggregation, and energy meter monitoring for Formula Student Korea events.

## Architecture

Eight independent services deployed via Docker Compose behind an Nginx reverse proxy (port 9000):

- **landing/** - Landing page and reverse proxy gateway (Vue 3 + Nginx)
- **entry/** - Vehicle entry registration API + web UI (Express + Vue 3, port 9100)
- **queue/** - Inspection queue management API + web UI (Express + Vue 3, port 9300)
- **inspection/** - Inspection sheet management API + web UI (Express + Vue 3, port 9600)
- **traffic/** - Traffic control and telemetry API + web UI (Express + Vue 3, port 9200)
- **score/** - Score aggregation and management API + web UI (Express + Vue 3, port 9700)
- **energymeter/** - Energy meter data viewer (Git submodule, Vue 3, port 9400)
- **rules/** - Rules file server (Caddy, port 9500)

**Shared modules** in `shared/` are imported directly by other services:
- `NavMenu.vue` - Navigation drawer component used across all frontends
- `nav-config.js` - Service menu configuration
- `officialsStore.js` - Shared state for officials-only menu visibility
- `ThemeToggle.vue` - Dark/light theme toggle button component
- `theme-init.js` - Theme initialization (localStorage + prefers-color-scheme)
- `styles/base.css` - Common CSS variables, resets, and component styles
- `useSSE.js` - Frontend SSE connection factory with auto-reconnect
- `sse.mjs` - Backend SSE manager (broadcast + endpoint handler)
- `express-setup.mjs` - Express app factory, process handlers, DB error helper
- `api-base.js` - Frontend API client factory with entry service helpers

Service dependencies (via `ENTRY_SERVER` environment variable):
- traffic → entry
- queue → entry
- inspection → entry
- score → entry, inspection, traffic

## Tech Stack

- **Frontend:** Vue 3, Vite, Pinia (state management), Vue Router
- **Backend:** Node.js 22, Express.js 5, Better-SQLite3
- **Real-time:** Server-Sent Events (SSE) for live updates across inspection, score, and traffic services
- **Deployment:** Docker Compose with Nginx reverse proxy
- **Logging:** Pino-HTTP

## Build Commands

### Frontend Development
```bash
cd landing|entry/web|queue/web|inspection/web|traffic/web|score/web|energymeter/viewer
npm run dev        # Dev server with hot reload
npm run build      # Production build
```

### Backend Development
```bash
cd entry|queue|inspection|traffic|score
node index.mjs     # Run API server directly
```

### Docker Deployment
```bash
podman compose --profile local build    # Build all containers
podman compose --profile local up -d    # Start all containers (local dev)
```

**Important:** Nginx resolves upstream hostnames (e.g., `score:9700`) at startup and caches the IP. When a backend container is recreated (getting a new IP), nginx-local will return 502. Always restart nginx-local after rebuilding a service:
```bash
podman compose --profile local up -d <service> && podman compose --profile local restart nginx-local
```

## Key Files

- `landing/nginx.conf` - Route configuration and authentication rules for all services
- `entry/index.mjs` - Entry service API server
- `queue/index.mjs` - Queue service API server
- `inspection/index.mjs` - Inspection sheet service API server
- `traffic/index.mjs` - Traffic service API server
- `score/index.mjs` - Score aggregation service API server
- `rules/Caddyfile` - Rules file server configuration
- `docker-compose.yml` - Service orchestration

## Authentication

Nginx handles HTTP Basic Auth with two permission levels. See README.md for the full route-permission matrix.

**Admin only** (`.htpasswd.admin`):
- `/entry/*` - Entry management (except `/entry/api` which is public)
- `/inspection/template` - Inspection template editor
- `/inspection/api/sheet/template` - Inspection template API
- `/traffic/api` (non-event, non-record endpoints), `/traffic/*` - Traffic management
- `/score/*` - Score management
- `/score/api/score/events` - Score SSE event stream

**Official** (`.htpasswd.official`):
- `/queue/admin`, `/queue/register`, `/queue/priority`, `/queue/stats` - Queue management routes
- `/queue/api/admin` - Queue admin API
- `/inspection/*` - Inspection sheet service (except template routes above)
- `/inspection/api/sheet/events` - Inspection SSE event stream
- `/traffic/api/events`, `/traffic/api/records/:id` - Traffic SSE and records

Admin users must be added to both `.htpasswd.admin` and `.htpasswd.official`. Official users only need `.htpasswd.official`.

Public routes: `/`, `/queue`, `/queue/api`, `/queue/assets`, `/entry/api`, `/energymeter`, `/rules`

## Environment-Aware Builds

Production builds use service-specific base paths (`/entry/`, `/queue/`, `/inspection/`, `/traffic/`, `/score/`, `/energymeter/`) configured in each service's `vite.config.js`. Development builds use empty base paths with Vite proxy routing to backend APIs.

## Data Storage

SQLite databases stored in volume-mounted directories:
- `entry/data/` - entry.db, entry.log
- `queue/data/` - queue.db, queue.log
- `inspection/data/` - sheet.db, sheet.log
- `traffic/data/` - traffic.db, traffic.log
- `score/data/` - score.db, score.log
