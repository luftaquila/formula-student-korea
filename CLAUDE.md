# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Formula Student Korea Service Hub - a microservices-based web application for managing vehicle entry registration, inspection queue, traffic controller data, and energy meter monitoring for Formula Student Korea events.

## Architecture

Five independent services deployed via Docker Compose behind an Nginx reverse proxy (port 9000):

- **landing/** - Landing page and reverse proxy gateway (Vue 3 + Nginx)
- **entry/** - Vehicle entry registration API + web UI (Express + Vue 3, port 9100)
- **queue/** - Inspection queue management API + web UI (Express + Vue 3, port 9300)
- **traffic/** - Traffic control and telemetry API + web UI (Express + Vue 3, port 9200)
- **energymeter/** - Energy meter data viewer (Git submodule, Vue 3, port 9400)

**Shared components** in `shared/` are imported directly by other services:
- `NavMenu.vue` - Navigation drawer component used across all frontends
- `nav-config.js` - Service menu configuration
- `officialsStore.js` - Shared state for officials-only menu visibility

Service dependencies (via `ENTRY_SERVER` environment variable):
- traffic → entry
- queue → entry

## Tech Stack

- **Frontend:** Vue 3, Vite, Pinia (state management), Vue Router
- **Backend:** Node.js 22, Express.js 5, Better-SQLite3
- **Deployment:** Docker Compose with Nginx reverse proxy
- **Logging:** Pino-HTTP

## Build Commands

### Frontend Development
```bash
cd landing|entry/web|queue/web|traffic/web|energymeter/viewer
npm run dev        # Dev server with hot reload
npm run build      # Production build
```

### Backend Development
```bash
cd entry|queue|traffic
node index.mjs     # Run API server directly
```

### Docker Deployment
```bash
docker-compose build
docker-compose up -d
```

## Key Files

- `landing/nginx.conf` - Route configuration and authentication rules for all services
- `entry/index.mjs` - Entry service API server
- `queue/index.mjs` - Queue service API server
- `traffic/index.mjs` - Traffic service API server
- `docker-compose.yml` - Service orchestration

## Authentication

Nginx handles HTTP Basic Auth with two permission levels:

**Admin only** (`.htpasswd.admin`):
- `/entry/*` - Entry management (except `/entry/api` which is public for queue service)
- `/traffic/*` - Traffic management

**Admin + Official** (`.htpasswd.official`):
- `/queue/admin`, `/queue/register`, `/queue/priority` - Queue management routes

Admin users must be added to both files. Official users only need `.htpasswd.official`.

Public routes: `/`, `/queue`, `/energymeter`

## Environment-Aware Builds

Production builds use service-specific base paths (`/entry/`, `/queue/`, `/traffic/`, `/energymeter/`) configured in each service's `vite.config.js`. Development builds use empty base paths with Vite proxy routing to backend APIs.

## Data Storage

SQLite databases stored in volume-mounted directories:
- `entry/data/` - entry.db, entry.log
- `queue/data/` - queue.db, queue.log
- `traffic/data/` - traffic.db, traffic.log
