# formula-student-korea

Formula Student Korea Service Hub

## Services

| Service | Path | Description | Port |
|---------|------|-------------|------|
| landing | `/` | Landing page & Nginx reverse proxy | 9000 |
| entry | `/entry` | Vehicle entry registration API + Web UI | 9100 |
| queue | `/queue` | Inspection queue management API + Web UI | 9300 |
| inspection | `/inspection` | Inspection sheet management API + Web UI | 9600 |
| traffic | `/traffic` | Traffic controller & telemetry API + Web UI | 9200 |
| energymeter | `/energymeter` | Energy meter data viewer | 9400 |
| rules | `/rules` | Rules file server (Caddy) | 9500 |

## Route Permission Matrix

Nginx HTTP Basic Auth로 라우트별 접근 권한을 관리합니다.

### Public

| Route | Description |
|-------|-------------|
| `/` | Landing page |
| `/queue` | Inspection queue public view |
| `/queue/api` | Inspection queue public API |
| `/entry/api` | Entry public API (used by queue, sheet, traffic) |
| `/energymeter` | Energy meter viewer |
| `/rules` | Rules file server |

### Official

| Route | Description |
|-------|-------------|
| `/queue/admin` | Queue admin page |
| `/queue/register` | Queue registration page |
| `/queue/priority` | Queue priority management |
| `/queue/stats` | Queue statistics |
| `/queue/api/admin` | Queue admin API |
| `/inspection` | Inspection sheet |
| `/inspection/api` | Inspection sheet API (except template) |
| `/traffic/api/events` | Traffic SSE event stream |
| `/traffic/api/records/:id` | Traffic record query API |

### Admin

Admin users must be registered in both `.htpasswd.admin` and `.htpasswd.official`.

| Route | Description |
|-------|-------------|
| `/entry` | Entry management page |
| `/entry/assets` | Entry static assets |
| `/inspection/template` | Inspection template editor |
| `/inspection/api/sheet/template` | Inspection template API |
| `/traffic` | Traffic management page |
| `/traffic/assets` | Traffic static assets |
| `/traffic/api` | Traffic admin API (except events, records) |

## Getting Started

### Prerequisites

- Podman & Podman Compose (or Docker & Docker Compose)

### Configuration

1. Copy the example environment file and fill in the values:

```bash
cp .env.example .env
```

2. Create authentication files for HTTP Basic Authentication:

```bash
cp .htpasswd.example .htpasswd.admin
cp .htpasswd.example .htpasswd.official
```

Note: Admin users should be added to both files.

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
