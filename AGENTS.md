# Agent Working Agreement

- Report progress and results in Korean; write PR titles, descriptions, and comments
  in English.
- Preserve user changes. Do not commit or create PRs unless requested.

## Required references

Read the applicable references before work:

- Behavior changes and tests: [Testing](CONTRIBUTING.md#testing).
- Domain behavior, boundaries, and ownership: [Architecture](docs/architecture.md).
- Public contracts: [API reference](docs/api.md).
- Network limits: [Venue network](docs/architecture.md#venue-network).
- Roster loading and SSE recovery: [Runtime communication](docs/architecture.md#runtime-communication).
- Deployment, repository paths, or image ownership: [k3s deployment](CONTRIBUTING.md#k3s-deployment).
- Completion: [Handoff](CONTRIBUTING.md#handoff).

## Project invariants

- `/srv/k3s` manages independent test (`lufthafen`) and live (`luftwolke`) clusters;
  scope deployments and verification separately.
- Competition has one runtime and database. `competition_team` is the only team
  source; its `id` is stable.
- Migration sources are immutable. Migration, backup, and restore validation must
  be read-only and fail closed before publishing or replacing artifacts.
- Authentication and integrations fail closed. Only Auth HTTP `200` confirms a user;
  production has no authentication bypass.
- Log mutations and business, database, and integration failures under the
  [logging contract](CONTRIBUTING.md#logging).
