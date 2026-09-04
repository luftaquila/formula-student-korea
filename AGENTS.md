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
- For a bug, reproduce it with a deterministic test, observe the failure, apply the
  fix, and observe the test pass.
- Add or update deterministic tests for every behavior change. Never use fixed
  sleeps for API or SSE synchronization. Playwright E2E runs only in CI.
- Test externally observable behavior or an explicitly documented stable contract
  at the lowest practical layer. Do not lock source text, internal identifiers,
  markup/CSS shape, copy, or pixel values unless that exact representation is a
  documented public, accessibility, or compatibility requirement.
- Do not duplicate the same invariant across unit, API, and E2E tests. Treat a
  retry-only pass as a defect, and measure performance changes with comparable
  before/after wall times.
- Do not create commits or pull requests unless requested. Keep requested commits
  focused and consistent with the repository's commit style.

## Project invariants

- `/srv/k3s` manages independent `lufthafen` test and `luftwolke` live clusters.
  Treat their manifests, deployment actions, and verification as separate scopes.
- When repository paths or deployed-image ownership change, update the CI build map,
  `/srv/k3s` deployment contract and script, and both environment manifests together.
- `competition_team.id` is the stable team identity, and `competition_team` is the
  only team source of truth.
- Interpret competition years in `Asia/Seoul`. Reads may target any valid year;
  mutations are limited to the current KST year. Do not add draft/finalize, roster
  snapshots, numeric roster versions, or soft-delete inference.
- Keep Competition domains in one runtime and database, with
  `/competition/api/v1` as their only API namespace. Do not add standalone legacy
  profiles, compatibility APIs, HTTP fan-out, copied rosters, live roster
  propagation, lifecycle outboxes, reconciliation, or reverse migration.
- Keep Inspection stale-write protection value-based: compare the caller's
  last-read value and reject mismatches without persistence. Do not add numeric
  answer/memo versions or local-storage drafts.
- Clean Documents orphan uploads synchronously before readiness. Do not add a
  background delete job. Legacy migration copies only database-referenced uploads.
- Never mutate migration sources. Migration, backup, and restore validation must be
  read-only and fail closed before publishing or replacing artifacts.
- Authentication and integrations fail closed. Only an Auth HTTP `200` confirms a
  user; never add a runtime authentication bypass.
- Log every successful mutation and every business, database, or integration
  failure with enough context to audit destructive changes.

Read [docs/architecture.md](docs/architecture.md) before changing boundaries or
data ownership, and [docs/api.md](docs/api.md) before changing public contracts.

## Completion

- Run the narrowest relevant tests, then broader affected tests when practical.
- Review the final diff for scope, API, boundary, migration, and logging regressions.
- Report changed files, tests run, and residual risk. If work stops converging, stop
  speculative edits and report the concrete blocker with evidence.
