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
| traffic | `/traffic` | Traffic controller, telemetry & event mode management API + Web UI | 9200 |
| score | `/score` | Score aggregation, penalty/scoring config & management API + Web UI | 9700 |
| documents | `/documents` | Document submission management API + Web UI | 9900 |
| filebrowser | `/files` | Cloud file storage (chief+ only) | 8080 |
| energymeter | `/energymeter` | Energy meter data viewer | 9400 |
| rules | `/rules` | Rules file server (Caddy) | 9500 |

## Authentication

Google OAuth 2.0 + JWT cookie-based authentication.

### Roles

| Role | Level | Access |
|------|-------|--------|
| Admin | 4 | All services |
| Chief | 3 | Document management, file storage, etc. |
| Official | 2 | Queue management, inspection sheets, etc. |
| Student | 1 | Document submission, etc. |

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
PUBLIC_URL=https://your-domain

# JWT & Security
JWT_SECRET=your-random-secret
INTERNAL_SECRET=your-internal-secret
ADMIN_EMAIL=admin@example.com

# Naver Cloud SMS API (queue service)
NAVER_CLOUD_ACCESS_KEY=your-access-key
NAVER_CLOUD_SECRET_KEY=your-secret-key
NAVER_CLOUD_SMS_SERVICE_ID=your-service-id
PHONE_NUMBER_SMS_SENDER=01012345678
```

Note: Google OAuth redirect URI should be set to `{PUBLIC_URL}/auth/api/callback`.

### Run

#### Production (Traefik + Caddy)

Set `DOMAIN_NAME` in `.env` file.

```bash
make deploy              # Build all + deploy
make deploy SVC=traffic  # Build specific service + deploy
make deploy NO_CACHE=1   # Build all without cache + deploy
make build               # Build only
make build SVC=traffic   # Build specific service only
make restart             # Restart only (no build)
```

#### Local Development

```bash
make deploy PROFILE=local              # Build all + deploy
make deploy PROFILE=local SVC=traffic  # Build specific service only
```

Available at `http://localhost:9000`. Omit `JWT_SECRET` from `.env` for dev mode (auto-authenticated as admin).
