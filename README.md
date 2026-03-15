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
| energymeter | `/energymeter` | Energy meter data viewer | 9400 |
| documents | `/documents` | Document submission management API + Web UI | 9900 |
| rules | `/rules` | Rules file server (Caddy) | 9500 |

## Authentication

Google OAuth 2.0 + JWT 쿠키 기반 인증. 각 백엔드 서비스의 미들웨어에서 JWT 검증.

### Roles

- **Admin** - 모든 서비스 접근 가능
- **Chief** - 서류 제출 관리 등 접근 가능
- **Official** - 검차 대기 관리, 인스펙션 시트 등 접근 가능
- **Student** - 서류 제출 등 접근 가능

### Route Permission Matrix

#### Public

| Route | Description |
|-------|-------------|
| `/` | Landing page |
| `/auth/login,callback,logout` | Auth login flow |
| `/auth` (SPA) | Auth SPA pages |
| `/auth/api/ops-contacts` (GET) | Ops contacts read API |
| `/queue` | Inspection queue public view |
| `/queue/api` (except `/api/admin`) | Inspection queue public API |
| `/entry/api/years`, `/entry/api/entries` | Entry public API |
| `/energymeter` | Energy meter viewer |
| `/rules` | Rules file server |

#### Student

| Route | Description |
|-------|-------------|
| `/documents/**` | Document submission SPA + API |

#### Official

| Route | Description |
|-------|-------------|
| `/queue/admin,register,priority,stats` | Queue management pages |
| `/queue/api/admin` | Queue admin API |
| `/inspection/**` | Inspection sheet (including GET template) |

#### Chief

| Route | Description |
|-------|-------------|
| `/documents/admin` | Document submission management page |
| `/documents/api/admin/**` | Document submission management API |

#### Admin

| Route | Description |
|-------|-------------|
| `/entry/**` (except public API above) | Entry management |
| `/auth/api/ops-contacts` (POST/DELETE) | Ops contacts modification API |
| `/inspection/api/sheet/template` (POST/PUT/DELETE) | Inspection template modification API |
| `/traffic/**` | Traffic management |
| `/score/**` | Score management |
| `/auth/api/users` | User management API |
| `/auth/api/admin/logs` | Log aggregation API |
| `/auth/logs` | System log viewer |

## Project Structure

```
├── Dockerfile.service       # Parameterized Dockerfile for all 7 backend services
├── docker-compose.yml       # Service orchestration (ARG SERVICE/PORT per service)
├── shared/                  # Shared modules imported by all services
│   ├── vite-config.js       # Vite config factory (createViteConfig)
│   ├── express-setup.mjs    # Express app factory with JWT auth middleware
│   ├── logger.mjs           # SQLite semantic logger factory
│   ├── api-base.js          # Frontend API client factory
│   ├── styles/
│   │   ├── base.css         # CSS variables, resets, component styles
│   │   └── layout.css       # Common app layout (header, main-content, responsive)
│   └── ...                  # NavMenu, ThemeToggle, SSE, etc.
├── landing/                 # Caddy reverse proxy + landing page
├── auth/                    # Auth service (Express + Vue 3)
├── entry/                   # Entry service
├── queue/                   # Queue service
├── inspection/              # Inspection service
├── traffic/                 # Traffic service
├── score/                   # Score service
├── documents/               # Document submission service
├── energymeter/             # Energy meter viewer (Git submodule)
└── rules/                   # Rules file server (Caddy)
```

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

## Traffic: Event Mode Management

Event types (가속, 스키드패드, 오토크로스, 짐카나) can be enabled/disabled from the traffic record management page. Disabled modes are hidden from traffic navigation tabs and score service tables. The "내구" (endurance) event is always shown in the score service regardless of event mode settings.

## Logging

SQLite 기반 시맨틱 로깅 시스템. 각 서비스는 `shared/logger.mjs`를 사용하여 자체 DB의 `logs` 테이블에 구조적 액션 로그를 기록. Auth 서비스가 `GET /api/admin/logs`로 전체 서비스 로그를 집계하며, `/auth/logs`에서 관리자용 로그 뷰어 UI 제공.

## Score: Scoring System

The score service provides:

- **Penalty settings** — per-event cone touch, off-course, and start delay penalties (seconds)
- **Score settings** — per-event total points, completion points, and cutoff percentage
- **Auto-calculated scores** — based on penalty-adjusted best records using the FSK scoring formula
- **Record/Score toggle** — switch between viewing penalty-adjusted times and calculated scores
- **Total score** — sum of all event scores + endurance + report + energy
