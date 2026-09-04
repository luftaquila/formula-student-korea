# ADR 0001: Competition Modular Monolith

- Status: Accepted
- Decision date: 2026-08-10
- Revised: 2026-09-04

## Context

Teams, Queue, Inspection, Traffic, Score, and Documents previously ran as separate services and synchronized mutable team data through HTTP fan-out, retry state, and reconciliation. The resulting architecture had more states and failure modes than the event workflow needs. Teams are normally settled before the event and rarely change afterward, but correcting a team must remain possible without stopping unrelated work.

## Decision

Run Teams, Queue, Registration, Inspection, Traffic, Score, and Documents as modules in one Node.js process with one SQLite connection and one deployment lifecycle. `competition_team` is the sole team source of truth; `competition_team.id` is the stable operational identity. Projection changes and transient-state cleanup occur in the same database transaction as the team update. Registration was added later under this same boundary instead of creating another runtime.

Use `Asia/Seoul` for competition-year decisions. Permit reads for any year and team, vehicle-type, and Inspection writes for the current or next KST year. Keep Queue, Registration, Traffic, Score, and Documents writes limited to the current KST year. Do not model draft/finalize, roster snapshots, roster versions, replacement intent, team soft deletion, or service-level legacy compatibility. Initial import succeeds only when the selected writable year has no teams; subsequent changes use simple per-team CRUD, with deactivation instead of deletion.

Expose one flat versioned Competition API. Remove standalone competition-module deployments, nested legacy API paths, team lifecycle fan-out, outboxes, reconciliation, and reverse migration. Score uses in-process query/event ports.

For Inspection concurrent edits, compare the caller's last-read value to the stored value. Reject stale saves with `409 INSPECTION_STALE_WRITE`; do not persist or provide numeric versions.

Clean unreferenced Documents uploads synchronously at startup. The one-shot migrator copies only database-referenced legacy uploads. Migration reports are audit evidence, not runtime identity.

Keep Auth, Email/SMS, Calendar, Course/Rover, FileBrowser, the reverse proxy, and device infrastructure separate because they have distinct security, scaling, or hardware boundaries.

## Consequences

- The competition core has one failure and deployment boundary.
- Team corrections do not require finalization toggles or cross-service synchronization.
- Historical rows retain stable team identity while display projections can be corrected transactionally.
- Noncurrent years are readable; the next year's team, vehicle-type roster, and Inspection sheets are the only writable exceptions.
- There is no standalone legacy Competition profile, compatibility facade, background file-deletion queue, or reverse migration.
- The Competition database and referenced upload tree must be backed up and restored as one quiesced unit.
