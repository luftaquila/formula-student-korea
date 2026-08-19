# formula-student-korea

Formula Student Korea Service Hub

Read the [user guide](docs/user-guide.md) to operate the system.

## Documentation

- [Architecture](docs/architecture.md): runtime boundaries, ownership, and lifecycle invariants
- [API reference](docs/api.md): current versioned and supporting-service HTTP contracts
- [User guide](docs/user-guide.md): competition workflows and roles
- [ADR 0001](docs/adr/0001-competition-modular-monolith.md): why the competition core is a modular monolith
- [Competition cutover](docs/runbooks/competition-cutover.md): one-time migration and deployment gates
- [Backup and restore](docs/runbooks/backup-restore.md): ongoing data-protection procedure
- [Contributing](CONTRIBUTING.md): development, tests, and logging policy

## Services

| Service | Description | Port |
|---------|-------------|------|
| landing | Landing page & Caddy reverse proxy | 9000 |
| auth | Authentication & user management | 9100 |
| competition | Modular monolith: teams, queue, inspection, traffic, score, documents | 9200 |
| energymeter | Energy meter data viewer | 9800 |
| email | Email/SMS management & Brevo integration | 9900 |
| course | Course cone management with RTK GPS rover + WebRTC camera / WebXR VR teleop | 10000 |
| calendar | Competition schedule management | 11000 |
| files | Cloud file storage (chief+ only) | 8080 |
| mediamtx | WebRTC relay for the rover camera (WHIP/WHEP). k3s-only — not in `compose.yml` | 8889 |

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

2. Configure the required environment variables in `.env`
   - Note: Google OAuth redirect URI should be set to `{PUBLIC_URL}/auth/api/callback`.

### Run

#### Production (Traefik + Caddy)

Set `DOMAIN_NAME` in `.env` file.

```bash
make deploy              # Pull images + deploy
make deploy SVC=competition  # Pull Competition + deploy
make build               # Build locally (dev)
make build SVC=competition   # Build Competition locally
make restart             # Restart only (no pull/build)
```

#### Local Development

```bash
make deploy PROFILE=local              # Pull images + deploy
make deploy PROFILE=local SVC=competition  # Pull Competition + deploy
```

Available at `http://localhost:9000`.

## Testing

### Unit / Integration Tests

```bash
npm test                          # Run all tests
npm run test:auth                 # Auth service only (etc.)
```

### E2E Tests (Playwright)

E2E tests run in CI for pushes and pull requests targeting `main`.
