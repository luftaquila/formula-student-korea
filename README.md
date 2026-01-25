# formula-student-korea

Formula Student Korea Service Hub

## Services

| Service | Description | Port |
|---------|-------------|------|
| landing | Landing page & Nginx reverse proxy | 9000 |
| entry | Vehicle entry registration API + Web UI | 9100 |
| queue | Inspection queue management API + Web UI | 9300 |
| traffic | Traffic controller & telemetry API + Web UI | 9200 |
| energymeter | Energy meter data viewer | 9400 |

## Getting Started

### Prerequisites

- Docker & Docker Compose

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
docker compose up -d
```

#### Local Development

Use `--profile local` to expose port 9000 directly.

```bash
docker compose --profile local up -d
```

The service will be available at `http://localhost:9000`.
