# Formula Student Korea

Web services and rover software for Formula Student Korea operations.

## Documentation

- [User guide](docs/user-guide.md): operator workflows and roles
- [Architecture](docs/architecture.md): runtime boundaries and data ownership
- [API reference](docs/api.md): public and supporting-service contracts
- [Contributing](CONTRIBUTING.md): development, tests, review, and k3s deployment
- [Backup and restore](docs/runbooks/backup-restore.md): data-safety contract
- [ADR 0001](docs/adr/0001-competition-modular-monolith.md): Competition design
- [Agent instructions](AGENTS.md): repository-specific coding-agent constraints

## Runtime

The separate `/srv/k3s` repository manages two independent deployments of this
application. Both use the `fsk` namespace, Flux, Traefik, and Caddy.

| Environment | Host | URL | GitOps path |
|---|---|---|---|
| Test | `lufthafen` | `https://test.luftaquila.io` | `clusters/lufthafen/apps/fsk/` |
| Live | `luftwolke` | `https://fsk.luftaquila.io` | `clusters/luftwolke/apps/fsk/` |

Each host reconciles only its own path. Application images come from this repository;
environment manifests and Kubernetes secrets belong to `/srv/k3s` and the target
cluster.

| Workload | Responsibility | Port |
|---|---|---:|
| `caddy` | Application gateway | 9000 |
| `auth` | Google OAuth, users, roles, and aggregated logs | 9100 |
| `competition` | Teams, Queue, Registration, Inspection, Traffic, Score, Documents | 9200 |
| `email` | Email and SMS integration | 9900 |
| `course` | Course, rover, RTK GPS, camera, and teleoperation | 10000 |
| `calendar` | Competition schedules | 11000 |

Energy Meter, FileBrowser, and mediamtx share the cluster but have independent image
or data ownership. See the [architecture](docs/architecture.md) for the system
boundary.

## Development

Use Node.js 22 and the repository-pinned pnpm version.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm run test:competition
pnpm --dir entry/web run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for service commands, deterministic test
rules, logging requirements, and the `/srv/k3s` PR-preview and promotion workflow.
The root Compose and Make targets are not used to deploy the k3s environments.
