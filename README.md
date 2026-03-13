# formula-student-korea

Formula Student Korea Service Hub

## Services

| Service | Path | Description | Port |
|---------|------|-------------|------|
| landing | `/` | Landing page & Caddy reverse proxy | 9000 |
| auth | `/auth` | Authentication & user management API + Web UI | 9800 |
| entry | `/entry` | Vehicle entry registration API + Web UI | 9100 |
| queue | `/queue` | Inspection queue management API + Web UI | 9300 |
| inspection | `/inspection` | Inspection sheet management API + Web UI | 9600 |
| traffic | `/traffic` | Traffic controller & telemetry API + Web UI | 9200 |
| score | `/score` | Score aggregation & management API + Web UI | 9700 |
| energymeter | `/energymeter` | Energy meter data viewer | 9400 |
| rules | `/rules` | Rules file server (Caddy) | 9500 |

## Authentication

Google OAuth 2.0 + JWT 쿠키 기반 인증. 각 백엔드 서비스의 미들웨어에서 JWT 검증.

### Roles

- **Admin** - 모든 서비스 접근 가능
- **Official** - 검차 대기 관리, 인스펙션 시트 등 접근 가능

### Route Permission Matrix

#### Public

| Route | Description |
|-------|-------------|
| `/` | Landing page |
| `/auth/login` | Login page |
| `/queue` | Inspection queue public view |
| `/queue/api` (except `/api/admin`) | Inspection queue public API |
| `/entry/api` | Entry public API |
| `/energymeter` | Energy meter viewer |
| `/rules` | Rules file server |

#### Official

| Route | Description |
|-------|-------------|
| `/queue/admin,register,priority,stats` | Queue management pages |
| `/queue/api/admin` | Queue admin API |
| `/inspection/**` | Inspection sheet (except template) |
| `/traffic/api/events` | Traffic SSE event stream |
| `/traffic/api/records/:id` | Traffic record query API |

#### Admin

| Route | Description |
|-------|-------------|
| `/entry/**` (SPA) | Entry management |
| `/inspection/api/sheet/template` | Inspection template API |
| `/traffic/**` | Traffic management (except official-level events, records) |
| `/score/**` | Score management |
| `/auth/api/users` | User management API |

## Getting Started

### Prerequisites

- Podman & Podman Compose (or Docker & Docker Compose)
- Google OAuth 2.0 credentials (Client ID & Secret)

### Configuration

1. Copy the example environment file and fill in the values:

```bash
cp .env.example .env
```

2. Configure the required environment variables in `.env`:

```env
# Google OAuth (https://console.cloud.google.com)
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret

# JWT secret for session tokens (any random string)
JWT_SECRET=your-random-secret

# Internal service-to-service auth token (any random string)
INTERNAL_SECRET=your-internal-secret

# Bootstrap admin email (registered as admin on first start)
ADMIN_EMAIL=admin@example.com
```

Note: Google OAuth redirect URI should be set to `https://your-domain/auth/api/callback`.

### Run

#### Production (Traefik)

By default, the service is configured to use Traefik reverse proxy. Set `DOMAIN_NAME` in `.env` file.

```bash
# .env
DOMAIN_NAME=fsk.example.com
```

```bash
podman compose up -d
```

#### Local Development

Use `--profile local` to expose port 9000 directly.

```bash
podman compose --profile local up -d
```

The service will be available at `http://localhost:9000`.

For development without Google OAuth, omit `JWT_SECRET` from `.env` — all requests will be auto-authenticated as admin.
