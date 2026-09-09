# Formula Student Korea

Web services and rover software for Formula Student Korea operations.

## Documentation

- [User guide](docs/user-guide.md): operator workflows and roles
- [Architecture](docs/architecture.md): runtime boundaries and data ownership
- [API reference](docs/api.md): public and supporting-service contracts
- [Contributing](CONTRIBUTING.md): development, tests, review, and k3s deployment
- [Backup and restore](docs/runbooks/backup-restore.md): data-safety contract
- [Agent instructions](AGENTS.md): repository-specific coding-agent constraints

## Development

Use Node.js 22 and the repository-pinned pnpm version.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm run test:competition
pnpm --dir entry/web run build
```
