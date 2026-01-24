# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Formula Student Korea Service Hub - a microservices-based web application for managing vehicle entry registration, traffic controller data, and energy meter monitoring for Formula Student Korea events.

## Architecture

Four independent services deployed via Docker Compose behind an Nginx reverse proxy (port 9000):

- **landing/** - Landing page and reverse proxy gateway (Vue 3 + Nginx)
- **entry/** - Vehicle entry registration API + web UI (Express + Vue 3, port 9100)
- **traffic/** - Traffic control and telemetry API + web UI (Express + Vue 3, port 9200)
- **energymeter/** - Energy meter data viewer (Git submodule, Vue 3, port 9400)

The traffic service depends on and communicates with the entry service via `ENTRY_SERVER` environment variable.

## Tech Stack

- **Frontend:** Vue 3, Vite, Pinia (state management), Vue Router
- **Backend:** Node.js 22, Express.js 5, Better-SQLite3
- **Deployment:** Docker Compose with Nginx reverse proxy
- **Logging:** Pino-HTTP

## Build Commands

### Frontend Development (any web service)
```bash
cd landing|entry/web|traffic/web|energymeter/viewer
npm run dev        # Dev server with hot reload
npm run build      # Production build
```

### Docker Deployment
```bash
docker-compose build
docker-compose up -d
```

## Key Files

- `landing/nginx.conf` - Route configuration for all services
- `entry/index.mjs` - Entry service API server
- `traffic/index.mjs` - Traffic service API server
- `docker-compose.yml` - Service orchestration

## Environment-Aware Builds

Production builds use service-specific base paths (`/entry/`, `/traffic/`, `/energymeter/`) configured in each service's `vite.config.js`. Development builds use empty base paths with Vite proxy routing to backend APIs.

## Data Storage

SQLite databases stored in volume-mounted directories:
- `entry/data/` - entry.db, entry.log
- `traffic/data/` - traffic.db, traffic.log
