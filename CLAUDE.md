# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Formula Student Korea Service Hub - a microservices-based web application for managing vehicle entry registration, inspection queue, traffic controller data, score aggregation, document submission, and energy meter monitoring for Formula Student Korea events.

## Architecture

Eleven independent services deployed via Docker Compose behind a Caddy reverse proxy (port 9000):

- **landing/** - Landing page and reverse proxy gateway (Vue 3 + Caddy)
- **auth/** - Authentication and user management API + web UI (Express + Vue 3, port 9100)
- **entry/** - Vehicle entry registration API + web UI (Express + Vue 3, port 9200)
- **queue/** - Inspection queue management API + web UI (Express + Vue 3, port 9300)
- **inspection/** - Inspection sheet management API + web UI (Express + Vue 3, port 9400)
- **traffic/** - Traffic control, telemetry, and event mode management API + web UI (Express + Vue 3, port 9500)
- **score/** - Score aggregation, penalty/scoring config, and management API + web UI (Express + Vue 3, port 9600)
- **documents/** - Document submission management API + web UI (Express + Vue 3, port 9700)
- **files/** - Cloud file storage (FileBrowser, proxy auth via Caddy forward_auth, port 8080)
- **energymeter/** - Energy meter data viewer (Git submodule, Vue 3, port 9800)
- **rules/** - Rules file server (Caddy, port 9900)

All 7 backend services use a single parameterized `Dockerfile.service` at the repo root, with `ARG SERVICE` and `ARG PORT` passed via `compose.yml` build args. **Shared modules** in `shared/` provide common frontend components, backend utilities, styles, and configs — read files directly for details.

Service dependencies (via environment variables in `compose.yml`):
- entry, inspection, traffic, documents → auth (`AUTH_SERVER`)
- queue → entry (`ENTRY_SERVER`), auth (`AUTH_SERVER`)
- score → entry (`ENTRY_SERVER`), inspection (`INSPECTION_SERVER`), traffic (`TRAFFIC_SERVER`), auth (`AUTH_SERVER`)

All non-auth services validate users via `AUTH_SERVER` (shared express-setup.mjs middleware). Auth validation uses **fail-close**: if auth service is unreachable or returns an error, the session is invalidated (only successful 200 responses confirm the user).

## Tech Stack

- **Frontend:** Vue 3, Vite, Vue Router, Pinia (traffic, energymeter only)
- **Backend:** Node.js 22, Express.js 5, Better-SQLite3
- **Auth:** Google OAuth 2.0, JWT (HMAC-SHA256) cookies, role-based access control
- **Real-time:** Server-Sent Events (SSE) for live updates across inspection, queue, score, and traffic services
- **Deployment:** Docker Compose with Caddy reverse proxy
- **Testing:** Node.js built-in test runner (`node:test` + `node:assert`), Playwright (E2E)

## Build Commands

### Frontend Development
```bash
cd landing|auth/web|entry/web|queue/web|inspection/web|traffic/web|score/web|documents/web|energymeter/viewer
npm run dev        # Dev server with hot reload
npm run build      # Production build
```

### Backend Development

Each service's `index.mjs` exports a `create*App(options)` factory function for testability. When run directly (`node index.mjs`), the service starts the HTTP server.

```bash
cd auth|entry|queue|inspection|traffic|score|documents
node index.mjs     # Run API server directly
```

### Docker Deployment

Prerequisites:
1. **Podman machine**: `podman machine init && podman machine start` (first time only)
2. **Git submodules**: `git submodule update --init --recursive` (energymeter is a submodule)
3. **`.env` file**: Copy `.env.example` to `.env` and set at minimum `JWT_SECRET` and `INTERNAL_SECRET`. Docker images set `NODE_ENV=production`, so services will fail-fast without `JWT_SECRET`.

A `Makefile` wraps common podman compose operations. It auto-prunes dangling images before builds. Default profile is `production`.

```bash
make deploy              # Build all + restart (production)
make deploy SVC=traffic  # Build specific service + restart
make deploy NO_CACHE=1   # Build all without cache + restart
make build               # Build only
make build SVC=traffic   # Build specific service only
make restart             # Restart only (no build)
make deploy PROFILE=local  # Local development (access at localhost:9000)
```

## Authentication

Google OAuth 2.0 with JWT cookie-based sessions. Caddy strips `X-Internal-Service` and `Authuser` headers from all incoming requests (preventing external spoofing); the auth service route additionally strips `X-Forwarded-Host`.

**Role hierarchy**: `public < student < official < chief < admin`. Higher roles can access lower-level resources. `authRoleFn(req)` returns: `null` (public), `"student"`, `"official"`, `"chief"`, or `"admin"`. Non-API routes return redirects to `/` instead of 401/403 text.

See `API.md` for the complete API reference with all endpoints, role requirements, and request/response formats.

## Inter-service Communication

All inter-service API calls use `X-Internal-Service` header (matching `INTERNAL_SECRET` env var), auto-authenticated as admin. Score service subscribes to inspection and traffic SSE endpoints, re-broadcasting events to score clients with `inspection:*` and `traffic:*` prefixes. Auth service aggregates logs from all other services via `LOG_SERVICES` env var.

## FileBrowser

Cloud file storage at `/files/`, restricted to chief+ roles via Caddy `forward_auth` to auth service. `X-Forward-Auth-Key` is a separate header from `X-Internal-Service` to avoid the auth middleware overriding `req.user` with the internal service identity (which would bypass the actual user's JWT validation).

**Important: DB reset** — when deleting `filebrowser/data/filebrowser.db`, the container must be recreated (not just restarted) so `init.sh` runs again. Use `podman rm -f fsk-filebrowser && podman compose --profile production up -d filebrowser`.

## Testing

### Unit/Integration Tests

```bash
npm test                    # Run all tests
npm run test:{service}      # Run specific service (auth, entry, queue, inspection, traffic, score, documents)
npm run test:shared         # Shared modules only
```

- Test files: `tests/<service>/<service>.test.mjs`, shared: `tests/shared/<module>.test.mjs`
- Utilities: `tests/helpers/test-utils.mjs` (JWT, HTTP client, temp DB)
- CI runs on push to main and PRs
- **When making code changes, always review whether existing tests adequately cover the changes. Add or update tests as needed — new endpoints, behavior changes, and error handling changes must have test coverage.**

### E2E Tests (Playwright)

**E2E tests run only in GitHub Actions CI. Do NOT run locally.**

- Tests: `tests/e2e/{service}/*.spec.mjs`
- CI workflow: `.github/workflows/e2e.yml`, triggered on push to main
- Check results: `gh run list` → `gh run view <id> --log-failed`

## Business Flows

See `FLOW.md` for the complete documentation of business flows across the 7 services. See `API.md` for the full API endpoint reference.

## Environment Variables

See `.env.example` for all required variables.
