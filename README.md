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

Google OAuth 2.0 + JWT 쿠키 기반 인증.

### Roles

| Role | Level | Access |
|------|-------|--------|
| Admin | 4 | 모든 서비스 |
| Chief | 3 | 서류 제출 관리, 파일 스토리지 등 |
| Official | 2 | 검차 대기 관리, 인스펙션 시트 등 |
| Student | 1 | 서류 제출 등 |

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

Set `DOMAIN_NAME` in `.env` file.

```bash
make deploy              # 전체 빌드 + 배포
make deploy SVC=traffic  # 특정 서비스만 빌드 + 배포
make deploy NO_CACHE=1   # 캐시 없이 전체 빌드 + 배포
make build               # 빌드만
make build SVC=traffic   # 특정 서비스만 빌드
make restart             # 재시작만 (빌드 없이)
```

#### Local Development

```bash
make deploy PROFILE=local              # 전체 빌드 + 배포
make deploy PROFILE=local SVC=traffic  # 특정 서비스만
```

Available at `http://localhost:9000`. Omit `JWT_SECRET` from `.env` for dev mode (auto-authenticated as admin).
