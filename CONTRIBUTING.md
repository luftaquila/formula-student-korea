# Contributing

This is the single source of truth for development, testing, review, and deployment
workflow. Product behavior belongs in the [user guide](docs/user-guide.md), runtime
boundaries in the [architecture](docs/architecture.md), and HTTP contracts in the
[API reference](docs/api.md).

## Repository layout

- `competition/` deploys Teams, Queue, Registration, Inspection, Traffic, Score, and
  Documents as one process and database. Their top-level directories contain module
  factories and web applications, not separate deployments.
- `auth/`, `calendar/`, `course/`, and `email/` are supporting services; `shared/`
  contains common server code and `tests/` mirrors service boundaries.
- Hardware work is documented under `rover/` and `traffic/device/`.

## Local development

Use Node.js 22 and the repository-pinned pnpm version. Enable Corepack if needed,
then install the entire workspace once from the repository root. Service startup
needs `.env` based on `.env.example`; tests inject their own dependencies where
possible.

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

Competition is the deployed owner of its seven domains. Their application factories
remain directly usable by tests, but do not run them as standalone services.

The root `Makefile` and `compose.yml` are not deployment interfaces for the k3s
servers. Do not use `make deploy`, `make restart`, `make backup`, or `make restore`
against the live k3s environment.

For rover work, follow [rover/README.md](rover/README.md).

## Testing

- Add or update deterministic tests for every behavior change.
- For a bug fix, first reproduce the defect and observe the test fail. Then apply the
  fix and observe the same test pass.
- Run the narrowest relevant test first. Run all affected suites before handoff.
- Playwright E2E runs in CI only. Do not run it locally.
- Register API response waits before the action that triggers them. Use Playwright
  assertions or `expect.poll()` for eventual state; never synchronize API or SSE
  behavior with `waitForTimeout` or another fixed sleep.
- Keep parallel tests isolated with unique data. Do not assert a global exact count
  when another shard can add records.

### Test contract and synchronization

- Assert externally observable behavior or an explicitly documented stable
  contract at the lowest layer that can prove it. Reserve E2E tests for deployed
  boundaries and critical user journeys instead of repeating unit or API coverage.
- Do not use source text, function or variable names, CSS classes, internal markup
  order, or implementation-specific copy and pixel values as a substitute for a
  behavior assertion. When a Dockerfile, manifest, or migration is itself a shipped
  contract, parse or execute it and assert its semantics rather than its formatting.
- Exact copy, color, font, and position assertions require a documented public,
  accessibility, or compatibility reason. Otherwise assert that information is
  visible, usable, and not clipped or overflowing, with one representative visual
  flow where it adds coverage.
- Synchronize by registering the response or event waiter before its triggering
  action, or use a web-first assertion, bounded condition poll, or fake clock. Do
  not wait for cosmetic animation or notification disappearance. A bounded absence
  wait is allowed only when absence throughout that exact documented interval is
  the behavior under test.
- A retry-only pass is a failure to fix, not an acceptable CI result. New tests must
  remain deterministic with retries disabled and repeated execution.
- Performance changes must include comparable before/after wall measurements and
  CI run links. Drop an optimization that does not improve its target or that adds
  flakiness or loses required behavior coverage.

CI is defined in [.github/workflows/test.yml](.github/workflows/test.yml). Inspect a
failed run with `gh run view <run-id> --log-failed`.

## Authentication and service calls

- Human roles are `student`, `official`, and `admin`. Officials receive one explicit
  list of service grants. Registration, Queue, Inspection, Documents, and Traffic
  use none/operate/manage access levels; Course and Score use a single full-access
  grant. Management permissions imply the matching operation permission. Admin
  satisfies every human permission.
- Non-auth services revalidate through Auth and fail closed; only HTTP `200` confirms
  a user. Tests may inject `TRUST_JWT` through an application factory. Production
  has no authentication bypass.
- Caddy removes external `X-Internal-Service` and `Authuser` headers. Internal calls
  use `X-Internal-Service` with `INTERNAL_SECRET`; the resulting internal principal
  can access only routes that explicitly require internal authentication.
- Competition modules communicate in-process. Do not add HTTP calls between them or
  split them into separate runtime profiles.

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

Change one or both paths deliberately; do not assume their configuration is
identical. A command run on one host affects only that host's cluster.

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

The script checks out the PR in a separate worktree, maps changed paths to deployed
images, builds `:dev` images into k3s containerd, deploys them, waits for readiness,
and verifies the running image. A Competition-domain change must appear as the
single `competition` image in the script's `Changed services` output; stop if an
expected image is missing. Flux remains suspended so it does not overwrite the
preview.

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

- Review `git diff` and `git diff --check`.
- Report files changed, tests run, deployment actions, and remaining risk.
- Do not claim a behavior or deployment is verified if its check was not run.
