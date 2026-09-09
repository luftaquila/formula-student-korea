# Architecture

## Deployment topology

Test and live are independent clusters with separate state and reconciliation.
Hostnames, manifest paths, and procedures: [k3s deployment](../CONTRIBUTING.md#k3s-deployment).

## Venue network

Venue clients primarily use distinct mobile-carrier IPs, not a shared venue NAT.
Use this topology when assessing per-IP limits unless evidence shows otherwise.

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

Energy Meter, FileBrowser, and mediamtx share the clusters but have independent
image or data ownership.

Competition modules have no separate deployments or HTTP fan-out. Team data stays
in the shared database; no copied rosters, lifecycle outboxes, or reconciliation.

## Public course viewing

Course serves the operational map at `/course` and anonymous read-only map at
`/course/public`. Publication is a private-by-default flag on the existing row.
Public APIs read and expose only published geometry, never memos; the viewer refreshes
manually, without SSE or polling. Operational events, telemetry, snapshots, and
mutations retain their permission gates. Both views share geometry and browser
archive generation; only operational exports include annotations.

Backup validation accepts the current schema and its exact pre-publication
predecessor without modifying either. Restoring an older database adds private
defaults at runtime.

## Teams and years

`competition_team` is the only team source of truth. Its `id` is the stable identity used by operational rows. Team number, university, team name, and vehicle-type name are mutable projections updated transactionally in the shared database.

Competition years use `Asia/Seoul`. Reads accept any valid year; Team, vehicle-type,
and Inspection writes accept the current or next year. Other Competition writes
accept only the current year; violations return `409 YEAR_READ_ONLY`.
There is no draft/finalize state, roster version, snapshot, or soft-delete inference.

Teams are created individually or imported once into an empty current or next year. A full import is not a replacement operation. Teams are never deleted through the service; setting `active: false` preserves history and clears only transient Queue/Registration/Traffic state. A team can be edited later without changing its stable ID. Vehicle types are year-scoped and may be created, edited, or deleted in the current or next year.

Registration references `competition_team.id` and resolves labels at read time.
Each team has at most one waiting row. Phones serve SMS notification, never public
lookup authentication. Completion, cancellation, and deactivation retain phone and
timestamps as history.

## Runtime communication

Competition entries do not change while an event is in progress. Do not require
event-day clients to refresh the entry roster solely to recover from a reconnect.

The participant queue hub is `/queue`, which combines Registration and Inspection position lookup and publishes the visible Inspection queues. `/registration/` redirects to that hub; Registration operations remain at `/registration/manage` and `/registration/register`. The other stable UI locations are `/entry`, `/inspection`, `/traffic`, `/score`, and `/documents`. The only Competition API namespace is `/competition/api/v1`: Teams and vehicle types are flat resources, while the other domains use `/competition/api/v1/{module}/...`. Nested `/{module}/api/...`, standalone module APIs, and internal team lifecycle routes are absent and return `404`.

Modules share one SQLite connection and one authentication validator. Successful Team and vehicle-type mutations emit only a year-scoped `entries` invalidation signal, without roster payloads, copied rosters, or direct live-state propagation. Score invalidates its derived caches; Queue, Registration, Inspection, and Traffic forward the signal over module-local SSE, and their SPAs re-query canonical team data for that year.

Traffic submits the stable `competition_team.id`; the server resolves that ID against the current active team at save time and persists only the canonical number and labels, rejecting stale, historical, inactive, or missing identities.

## Inspection concurrent edits

Inspection saves compare last-read values (`expectedValue` / `expectedMemo`) with
stored values. Mismatches return `409 INSPECTION_STALE_WRITE` without persistence;
the UI discards stale edits and requests a refresh. Browser saves for each field
are serialized. No numeric versions, local-storage drafts, or conflict merging.

## Inspection rule references

`sheet_template.rule_refs` links stable item `field_key` values to cross-edition
`rule_key` values. Competition resolves clause metadata and URLs from the schema-v2
catalog at `RULES_BASE_URL`; client-supplied metadata is not authoritative. The
validated, bounded catalog cache lasts ten minutes and does not gate readiness.
Catalog-dependent mutations log `site_tag` and document `release_tag` values.

Rule-reference edits compare the complete last-read `rule_refs` inside the update
transaction. Mismatches return `409 INSPECTION_STALE_WRITE` without persistence;
there is no numeric version or merge.

Only `verified` links open. Resolution requires the edition's stable key and
unchanged content hash: renumbering follows the new anchor; changed content fails
closed. `needs_review` is disabled and `no_direct_rule` hidden. Year copy/sync
matches `field_key`; verification never uses a runtime LLM.

Inline content uses the same stable-key and content-hash checks. A bounded LRU
caches documents by immutable release tag; each distinct document is parsed once
per request. Resolved `clause_id` fragments are returned as inert JSON, then HTML
and MathML are allowlisted in the browser. Stored clause numbers never drive
resolution, and opening another item does not transfer the full rulebook again.

Rollout, revalidation after a rulebook release, and year rollover steps are in the [rule links runbook](runbooks/inspection-rule-links.md).

## Documents files

The database and Documents upload tree are one consistency unit. Documents rejects symbolic links in every existing component of the configured upload-root path before creating or cleaning directories, then synchronously removes `_tmp` contents, unreferenced files and symlinks, and empty directories before the process becomes ready. Cleanup errors fail startup. Missing database-referenced files and metadata that does not match the runtime path-shape rules are audited and rejected by migration, backup, and restore validation.

The one-shot legacy migrator copies only files referenced by `submission_file` metadata. Files absent from metadata are legacy orphans and are deliberately ignored. There is no background file-delete job.

## Migration, backup, and rollback

Migration opens sources read-only and verifies they remain unchanged. Bind rows to
stable team IDs, copy only referenced uploads, and validate before publishing
create-if-absent artifacts. k3s deployment must never rerun the legacy migration.

Backup and restore validate one coordinated Competition, Auth, Calendar, Course,
and Email state before publishing or replacing artifacts. FileBrowser payload may
be included; its private database and lifecycle are outside this contract. Follow
the [backup/restore gates](runbooks/backup-restore.md).

Rollback never translates Competition writes into legacy schemas or restarts the
retired writers. Restore a validated coordinated Competition backup and deploy an
application revision compatible with that state.

## Authentication and audit

Auth owns roles, effective permissions, real names, and access revisions; services
revalidate against it and reject stale access edits. See [roles and permissions](api.md#human-roles-and-permissions).
Inspection records Auth's real name, not the JWT's Google name. Queue sheet links
and inspector names require `inspection.operate` in addition to `queue.operate`.

Migrating `staff`, `chief`, or `master` accounts must produce Officials with no
grants; assign access explicitly after migration.

`X-Internal-Service` creates a distinct internal principal, not an Admin. It is valid
only for routes that explicitly require internal authentication. Caddy removes
externally supplied internal-auth headers.

Kiosk devices have one revocable scope and use a one-time pairing code to obtain
an HttpOnly, SameSite=Strict token; Auth stores only its hash. Each device can submit
only its scoped registration POST. Revocation applies on the next request.

Competition logs share the database with a module discriminator and follow the
[logging contract](../CONTRIBUTING.md#logging).
