# Architecture

## Deployment topology

`/srv/k3s` manages two independent clusters: `lufthafen` serves the test environment
and `luftwolke` serves live. Each cluster reconciles its own
`clusters/<hostname>/apps/fsk/` path and owns its own runtime state. Deployment and
verification happen separately for each environment.

## System boundary

Competition-critical domains run as modules in one `competition` process, one deployment, and one Better-SQLite3 database. Supporting services remain independent.

| Runtime | Responsibility | Port |
|---|---|---|
| `landing` | Landing page and reverse proxy | 9000 |
| `auth` | Google OAuth, users, service grants, kiosk devices, and aggregated logs | 9100 |
| `competition` | Teams, Queue, Registration, Inspection, Traffic, Score, Documents, and seven SPAs | 9200 |
| `energymeter` | Energy meter viewer | 9800 |
| `email` | Email/SMS provider integration | 9900 |
| `course` | Course, rover, RTK GPS, camera, and teleoperation | 10000 |
| `calendar` | Competition schedules | 11000 |
| `files` | FileBrowser storage with Auth forward-auth | 8080 |

Entry, Queue, Registration, Inspection, Traffic, Score, and Documents are not deployable legacy profiles. They have no runtime service URLs, HTTP fan-out, lifecycle outboxes, reconciliation, or copied team lists.

## Teams and years

`competition_team` is the only team source of truth. Its `id` is the stable identity used by operational rows. Team number, university, team name, and vehicle-type name are mutable projections updated transactionally in the shared database.

Competition years are interpreted in `Asia/Seoul`. Reads may select any valid year. Every Competition mutation is allowed only for the current KST year and otherwise fails with `409 YEAR_READ_ONLY`. There is no draft/finalize state, roster version, snapshot, replacement version, or soft-delete inference.

Teams are created individually or imported once into an empty current year. A full import is not a replacement operation. Teams are never deleted through the service; setting `active: false` preserves history and clears only transient Queue/Registration/Traffic state. A team can be edited later without changing its stable ID. Vehicle types are year-scoped and may be created, edited, or deleted in the current year.

Registration queue rows reference only `competition_team.id`. Team number and labels are resolved from the canonical team at read time, so a renumber does not fork registration history. A team has at most one waiting row. Completing, canceling, or deactivating the team preserves its phone and timestamps as audit history while removing it from the active queue.

## Runtime communication

The stable UI locations are `/entry`, `/queue`, `/registration`, `/inspection`, `/traffic`, `/score`, and `/documents`. The only Competition API namespace is `/competition/api/v1`: Teams and vehicle types are flat resources, while the other domains use `/competition/api/v1/{module}/...`. Nested `/{module}/api/...`, standalone module APIs, and internal team lifecycle routes are absent and return `404`.

Modules share one SQLite connection and one authentication validator. Successful Team and vehicle-type mutations emit only a year-scoped `entries` invalidation signal, without roster payloads, copied rosters, or direct live-state propagation. Score invalidates its derived caches; Queue, Registration, Inspection, and Traffic forward the signal over module-local SSE, and their SPAs re-query canonical team data for that year.

Traffic submits the stable `competition_team.id`; the server resolves that ID against the current active team at save time and persists only the canonical number and labels, rejecting stale, historical, inactive, or missing identities.

## Inspection concurrent edits

Inspection answers and memos have no numeric client or database version. A save includes the value last read by the editor as `expectedValue` or `expectedMemo`. If it differs from the current stored value, the server returns `409 INSPECTION_STALE_WRITE` and does not persist the request. The UI discards the stale local edit and tells the operator to refresh and retry. Saves for the same field are serialized in the browser; there is no local-storage draft or conflict-resolution UI.

## Inspection rule references

Inspection items store deterministic rule references in `sheet_template.rule_refs`. An item's stable `field_key` identifies the inspection question, while the rules site's semantic `rule_key` identifies a clause across editions. Clause numbers, citations, hashes, release tags, and final links are never accepted as authoritative client input: Competition resolves them from the schema v2 catalog at `RULES_BASE_URL`, whose manifest names the deployed `site_tag` and each document's immutable `release_tag`. The catalog is bounded, validated, cached for ten minutes, and is not part of service readiness. Mutations that consult the catalog log the site tag and document releases they were judged against.

Only `verified` references expose links. The redirect endpoint resolves the stored key against the item's edition and requires an unchanged clause content hash, so a pure renumber follows the new anchor while a substantive change fails closed until a chief revalidates it. `needs_review` is visible but disabled; `no_direct_rule` is intentionally hidden. Year copying and explicit synchronization match items by `field_key`; no runtime LLM participates in lookup or approval.

## Documents files

The database and Documents upload tree are one consistency unit. Documents rejects symbolic links in every existing component of the configured upload-root path before creating or cleaning directories, then synchronously removes `_tmp` contents, unreferenced files and symlinks, and empty directories before the process becomes ready. Cleanup errors fail startup. Missing database-referenced files and metadata that does not match the runtime path-shape rules are audited and rejected by migration, backup, and restore validation.

The one-shot legacy migrator copies only files referenced by `submission_file` metadata. Files absent from metadata are legacy orphans and are deliberately ignored. There is no background file-delete job.

## Migration, backup, and rollback

The completed cutover used the only migrator that understands the six legacy
databases. It opened sources read-only, verified they did not change, bound data to
stable team IDs, copied referenced uploads, validated the result, and published new
artifacts create-if-absent. Current k3s deployment never reruns this migration.

Competition backup and restore require an exact manifest containing Competition,
Auth, Calendar, Course, and Email. Validation covers complete schemas, SQLite
integrity, foreign keys, canonical team references, and referenced uploads before
publishing or replacing artifacts. FileBrowser's mounted payload may be copied, but
its private database and lifecycle remain outside this coordinated state contract.

Rollback never translates Competition writes into legacy schemas or restarts the
retired writers. Restore a validated coordinated Competition backup and deploy an
application revision compatible with that state.

## Authentication and audit

Human accounts use only `student`, `official`, and `admin`. An Official starts with
no operational access and receives one explicit list of service grants. Registration,
Queue, Inspection, Documents, and Traffic use none/operate/manage access levels.
Course and Score use a single full-access grant; other single-action services use a
single grant. Management permissions imply the matching operation permission; Admin
satisfies every human permission. Queue (`queue.*`) and Inspection (`inspection.*`)
are independent domains, so a grant in one never authorizes the other. Auth exposes
the authoritative effective-permission snapshot and an access revision; services
revalidate it and fail closed, and stale access edits are rejected by revision.
During the schema cutover, retired `staff`, `chief`, and `master` accounts become
Officials with no grants; access must be assigned explicitly after migration.

`X-Internal-Service` creates a distinct internal principal, not an Admin. It is valid
only for routes that explicitly require internal authentication. Caddy removes
externally supplied internal-auth headers.

Registration-only tablets use revocable device principals instead of human roles.
An Admin creates a device with exactly one scope (`kiosk.queue.register` or
`kiosk.registration.register`), and the tablet consumes a short-lived one-time
pairing code to receive a long-lived HttpOnly, SameSite=Strict token. Auth stores only
the token hash. A device can submit only the matching registration POST; it cannot
read an operations board or alter settings. Revocation takes effect on its next request.

All Competition module logs live in the shared database with a module discriminator. Every successful mutation and every business, database, or integration failure records enough before/after context to audit destructive changes.

See the [backup/restore contract](runbooks/backup-restore.md) and
[ADR 0001](adr/0001-competition-modular-monolith.md).
