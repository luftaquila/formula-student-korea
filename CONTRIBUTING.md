# Contributing

Development and deployment workflow. See [Architecture](docs/architecture.md) for
service ownership, the [API reference](docs/api.md) for contracts, and the
[user guide](docs/user-guide.md) for operations.

Competition module factories support tests but share one deployment. Hardware:
[rover](rover/README.md), [timing devices](traffic/DESIGN.md).

## Local development

Use Node.js 22, the pinned pnpm version, and `.env` based on `.env.example`.
Install from the workspace root:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test                         # all unit and integration tests
pnpm run test:competition        # one service or domain
pnpm run test:shared

pnpm --dir entry/web run dev     # replace entry with the relevant SPA
pnpm --dir entry/web run build
node competition/index.mjs      # replace competition for a supporting service
```

The root `Makefile` and `compose.yml` are not deployment interfaces for the k3s
servers. Do not use `make deploy`, `make restart`, `make backup`, or `make restore`
against the live k3s environment.

## Testing

- Add or update deterministic tests for every behavior change.
- For a bug fix, first reproduce the defect and observe the test fail. Then apply the
  fix and observe the same test pass.
- Run the narrowest relevant test first. Run all affected suites before handoff.
- On shared hosts, run tests through `pnpm test`, `pnpm run test:<domain>`, or
  `node scripts/test.mjs tests/course/course-archive.test.mjs`; never use
  `node --test` directly. The runner requires Linux, cgroup v2, and a systemd user
  manager, and refuses to run without enforced limits. Use CI if unsupported.
  Test limits (not application/build limits):

  | Limit | Shared host | GitHub-hosted CI |
  |---|---|---|
  | Concurrent files / V8 heap per process | 2 / 256 MiB | 2 / 256 MiB |
  | Process tree | 1 GiB RAM, no swap, 256 tasks | Dedicated VM |
  | Timeout | 10 min + 5 s kill grace | 15 min unit job |

- Compare binary results using `Buffer.compare()` or `Buffer.equals()` and assert
  the scalar result. Do not pass large binaries to deep-equality assertions:
  formatting a failing diff can consume far more memory than the input.
- Playwright E2E runs in CI only. Do not run it locally.
- Isolate parallel tests; global counts must not depend on other shards.

### Test contract and synchronization

- Test behavior or documented contracts at the lowest practical layer. Reserve E2E
  for deployed boundaries and critical journeys; avoid duplicate coverage.
- Exact source, markup, copy, and visual assertions need a documented public,
  accessibility, or compatibility requirement. Parse or execute shipped contracts
  such as manifests instead of matching their formatting.
- Register response/event waits before triggering actions. Use assertions, bounded
  polls, or fake clocks; no fixed sleeps or cosmetic waits. Absence waits require
  a documented interval.
- Tests must pass without retries. Performance changes require comparable before/after
  wall times and CI links; discard changes that fail to improve the target or lose
  reliability or coverage.

CI is defined in [.github/workflows/test.yml](.github/workflows/test.yml). Inspect a
failed run with `gh run view <run-id> --log-failed`.

## Authentication and service calls

- Follow the [roles and permissions contract](docs/api.md#human-roles-and-permissions)
  when changing access checks.
- Non-auth services revalidate through Auth; only HTTP `200` confirms a user.
  Tests may inject `TRUST_JWT` through an application factory; production has no bypass.
- Caddy strips external `X-Internal-Service` and `Authuser` headers. Internal calls
  use `X-Internal-Service` with `INTERNAL_SECRET`; the distinct internal principal
  can access only explicitly internal routes.
- Competition modules communicate in-process, without HTTP calls or separate profiles.

## Logging

Backends use `createLogger(db, serviceName)` from `shared/logger.mjs`.

```js
logger.log(req, "team.create", { before, after }, target);
logger.warn(req, "team.create", { error, input }, target);
```

- Log every successful mutation with the affected target and meaningful change.
- Log business, database, authentication, and integration failures before returning
  the error. Simple input-shape `400` responses may omit a log.
- Use dot-separated actions such as `team.create`. Put identifiers in `target` and
  auditable before/after or failure context in `detail`.
- Use `logger.warn`, not `console.*`, when the structured logger is trustworthy.
  Console logging is limited to startup/migration code or failure of the logger's
  own storage path; explain that exception in a comment.
- Competition logs that mention a team number must retain its year and canonical
  `competition_team` context because numbers can be reused.

## k3s deployment

The separate `/srv/k3s` repository manages two independent k3s environments. Each
host runs its own Flux reconciliation against its own manifest path.

| Host | Environment | URL | Manifest path |
|---|---|---|---|
| `lufthafen` | Test | `https://test.luftaquila.io` | `clusters/lufthafen/apps/fsk/` |
| `luftwolke` | Live | `https://fsk.luftaquila.io` | `clusters/luftwolke/apps/fsk/` |

Repository structure is part of the deployment contract. When a top-level service
or module path, shared-code boundary, Dockerfile, or image owner changes, update and
test all of these in the same coordinated change:

- `.github/workflows/build.yml`
- the affected application Dockerfile
- `/srv/k3s/scripts/fsk-contract.sh` and `fsk-redeploy.sh`
- both `clusters/{lufthafen,luftwolke}/apps/fsk/` manifest sets when applicable

Do not preview or promote a change when the deployment script's `Changed services`
output omits an image affected by the diff.

Use an explicit kubeconfig on the server:

```bash
kubectl --kubeconfig /home/luftaquila/.kube/config get nodes
flux get kustomizations
```

### Preview a pull request on test

Run PR previews on `lufthafen` unless the user explicitly authorizes a live preview.
The command mutates the current host's cluster and suspends that host's Flux:

```bash
cd /srv/k3s
./scripts/fsk-redeploy.sh <pull-request-number>
```

The script builds `:dev` images from an isolated PR worktree, deploys them, and
verifies readiness and running images. Competition changes must map to the single
`competition` image. Flux stays suspended until promotion or restoration.

### Promote or restore main

1. Merge the application pull request and wait for the `Build Images` workflow.
2. Merge any required manifest change in `/srv/k3s`.
3. With operator approval, deploy and verify main on `lufthafen`:

   ```bash
   cd /srv/k3s
   ./scripts/fsk-redeploy.sh
   ```

4. With separate explicit approval, run the same command on `luftwolke` and verify
   the live environment.

The script validates the current Competition data before resuming Flux, reconciles
the GitOps state, restarts the declared application deployments, checks readiness,
and verifies that running GHCR digests match `:latest`. It does not create or
remigrate Competition data. Use `./scripts/fsk-redeploy.sh --check` to validate
deployment without a Flux resume or workload rollout; it still creates a temporary
validation pod.

Secrets are imperative Kubernetes Secrets and never belong in Git. Follow
`/srv/k3s/README.md` for per-cluster bootstrap, secrets, infrastructure, and recovery
operations instead of copying those procedures here.

## Handoff

- Review `git diff` for scope, API, boundary, migration, and logging regressions;
  run `git diff --check`.
- Report files changed, tests run, deployment actions, and remaining risk.
