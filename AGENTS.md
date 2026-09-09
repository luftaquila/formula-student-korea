# Agent Working Agreement

This file applies to the whole repository. Detailed development and deployment
instructions live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Working method

- Report progress and results to the user in Korean. Write pull request titles,
  descriptions, and comments in English.
- Before editing, inspect `git status`, the relevant implementation, and nearby
  tests. Preserve user changes and report unrelated problems without fixing them.
- Make the smallest coherent change that solves the request. Prefer a small API and
  clear design over the fewest changed lines.
- Follow local code patterns. Put mechanically checkable rules in tooling or tests,
  not this file. Comments should explain only non-obvious reasons or constraints.
- Before changing behavior or writing or running tests, read and follow
  [CONTRIBUTING.md — Testing](CONTRIBUTING.md#testing).
- Do not create commits or pull requests unless requested. Keep requested commits
  focused and consistent with the repository's commit style.

## Project invariants

- `/srv/k3s` manages independent `lufthafen` test and `luftwolke` live clusters.
  Treat their manifests, deployment actions, and verification as separate scopes.
- `competition_team.id` is the stable team identity, and `competition_team` is the
  only team source of truth.
- Keep Competition domains in one runtime and database.
- Never mutate migration sources. Migration, backup, and restore validation must be
  read-only and fail closed before publishing or replacing artifacts.
- Authentication and integrations fail closed. Only an Auth HTTP `200` confirms a
  user; never add a runtime authentication bypass.
- Log every successful mutation and every business, database, or integration
  failure with enough context to audit destructive changes.

## Required references

- Before changing domain behavior, runtime boundaries, or data ownership, read and
  follow the relevant sections of [docs/architecture.md](docs/architecture.md).
- Before changing public contracts, read and follow [docs/api.md](docs/api.md).
- Before assessing network behavior or per-IP limits, read
  [Venue network](docs/architecture.md#venue-network).
- Before changing roster loading or SSE recovery, read
  [Runtime communication](docs/architecture.md#runtime-communication).
- Before deployment work or repository-path or deployed-image ownership changes,
  read and follow [CONTRIBUTING.md — k3s deployment](CONTRIBUTING.md#k3s-deployment),
  including its coordinated deployment contract.

## Completion

- Follow [CONTRIBUTING.md — Handoff](CONTRIBUTING.md#handoff).
- If work stops converging, stop speculative edits and report the concrete blocker
  with evidence.
