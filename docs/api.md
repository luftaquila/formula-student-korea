# API Reference

HTTP contracts for supporting services and Competition (port 9200). Supporting-service
paths are service-relative. Competition API/SSE paths use these prefixes:

| Module | External prefix |
|---|---|
| Teams (Entry UI) | `/competition/api/v1/teams` |
| Queue | `/competition/api/v1/queue` |
| Registration | `/competition/api/v1/registration` |
| Inspection | `/competition/api/v1/inspection` |
| Traffic | `/competition/api/v1/traffic` |
| Score | `/competition/api/v1/score` |
| Documents | `/competition/api/v1/documents` |

Teams, vehicle types, and meta use paths relative to `/competition/api/v1`;
other module tables use the prefix above (Queue `/health` means
`/competition/api/v1/queue/health`). UI paths are documented under
[Runtime communication](architecture.md#runtime-communication).

Former standalone, nested `/{module}/api/*`, lifecycle, finalize, snapshot, and version routes are not compatibility APIs and return `404`.

Competition years use `Asia/Seoul`. Reads may select any valid year. Team, vehicle-type, and Inspection mutations may select the current or next KST year; Queue, Registration, Traffic, Score, and Documents mutations remain limited to the current KST year. A year outside the applicable write window returns `409 YEAR_READ_ONLY`. There is no draft/finalize state.

Competition process health is separate from module compatibility health:

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/health/live` | public | Process liveness |
| GET | `/health/ready` | public | Shared database readiness |

Mutation logging follows [CONTRIBUTING.md](../CONTRIBUTING.md#logging).

## Common Infrastructure

### Authentication

- **Human session**: `fsk_session` is an HttpOnly HMAC-SHA256 JWT with `{ email, name, role, accessRevision }`. Each service revalidates the user's role and effective permissions through Auth.
- **Device session**: `fsk_device` is an HttpOnly, SameSite=Strict opaque token for exactly one kiosk scope. Auth stores only its SHA-256 hash.
- **Internal service**: `X-Internal-Service` matching `INTERNAL_SECRET` creates a distinct internal principal. It is not an Admin and is accepted only by explicitly internal routes.
- **Forward auth**: `X-Forward-Auth-Key` matching `INTERNAL_SECRET` plus `?permission=<key>` is used by Caddy `forward_auth`.

### Human roles and permissions

Human roles are `student`, `official`, and `admin`. Officials have no service access
until an Admin assigns one explicit list of service grants. Registration, Queue,
Inspection, Documents, and Traffic use none/operate/manage access levels. Course and
Score use a single full-access grant; other single-action services use one grant.
Admin satisfies all human permissions. A `*.manage` permission implies the matching
`*.operate` permission, but permissions from different services never imply one another.

`registration.operate`, `registration.manage`, `queue.operate`, `queue.manage`,
`inspection.operate`, `inspection.manage`, `documents.operate`, `documents.manage`,
`files.access`, `calendar.manage`, `course.operate`, `course.manage`, `rover.operate`,
`traffic.operate`, `traffic.manage`, `score.operate`, and `score.manage`.

Entry, Email/SMS, logs, and Account & Access are Admin-only; they have no grant key.

### Rate Limiting

- **Auth**: OAuth login/callback — 20 requests/minute per IP
- **Queue**: Public entry state (`GET /state/:num`) — 30 requests/minute per IP
- **Registration**: Public entry lookup (`GET /lookup/:num`) — 60 requests/minute per IP
- **Kiosk registration**: 30 submissions/minute per device and IP
- **Kiosk pairing**: 10 attempts/minute per IP

### Common module endpoints

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/health` | public | Module health check, returns `"ok"` |
| GET | `/logs` | admin or internal | Module-scoped structured logs from the shared Competition DB |

---

## Auth Service (port 9100)

### OAuth & Session

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/login` | public | `?redirect=<path>` | 302 → Google OAuth | Initiates Google OAuth flow with CSRF nonce |
| GET | `/api/callback` | public | `?code=<code>&state=<state>` | 302 → redirect URL | OAuth callback; exchanges code for token, sets JWT cookies |
| POST | `/api/logout` | public | — | 200 | Clears the human and device session cookies regardless of the current principal state |
| GET | `/api/session` | public | — | `{ name, picture, role, permissions, accessRevision }` or 401 | Validates the current human session; `picture` is the Google profile image URL (empty when unavailable) |
| GET | `/api/device/session` | public | — | `{ id, name, scope, startPath }` or 401 | Validates the current device session |
| GET | `/api/forward-auth` | internal key | `?permission=<permission>`, `X-Forward-Auth-Key` header | 200 + `X-Forwarded-User` header, or 400/401/403 | Caddy forward_auth for an exact human permission |

### User Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/access/catalog` | admin | — | `{ roles, permissions, accessControls }` | List permissions and their tiered or single-toggle controls |
| GET | `/api/users` | admin | — | `[{ ..., grants, permissions, accessRevision, protected }]` | List users, configured grants, and effective permissions |
| POST | `/api/users` | admin | `{ email, role }` | `{ id, email, role }` | Create user |
| POST | `/api/users/bulk` | admin | `{ users: [{ email, role, realname, phone, affiliation, grants? }] }` | `{ added, skipped, errors }` | Bulk create users; grants apply only to newly created Officials |
| PATCH | `/api/users/bulk` | admin | `{ ids: [int], active: bool }` | `{ updated }` | Bulk activate/deactivate users |
| DELETE | `/api/users/bulk` | admin | `{ ids: [int] }` | `{ deleted }` | Bulk delete users (protects last admin) |
| PATCH | `/api/users/:id` | admin | `{ role?, realname?, phone?, active? }` | 200 | Update user role/realname/phone/active status |
| DELETE | `/api/users/:id` | admin | — | 200 | Delete single user (protects last admin, ADMIN_EMAIL) |
| PUT | `/api/users/:id/access` | admin | `{ expectedRevision, grants }` | `{ grants, permissions, accessRevision }` | Replace an Official's grants; stale revision returns `409 ACCESS_STALE_WRITE` |
| PUT | `/api/users/bulk/access` | admin | `{ users: [{ id, expectedRevision }], grants }` | `{ updated, users: [{ id, email, grants, permissions, accessRevision }] }` | Replace several Officials' grants with one list in a single transaction; any stale target returns `409 ACCESS_STALE_WRITE` with `stale`, a non-Official target `409 OFFICIAL_ACCESS_ONLY`, and nothing is written |

### Internal User Lookup

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/users/exists/:email` | internal | — | 200 or 404 | Check if user exists and is active |
| GET | `/api/users/access/:email` | internal | — | `{ id, role, realname, permissions, accessRevision }` or 404 | Authoritative access and real-name snapshot used by services |
| GET | `/api/internal/users` | internal | — | `[{ id, email, name, role, realname, phone, active }]` | List minimal user profiles for trusted Documents and Email consumers without opening the Admin API |

### Kiosk devices

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/devices` | admin | — | Device list without tokens or pairing-code hashes | List device status and last-seen data |
| POST | `/api/devices` | admin | `{ name, scope }` | `201 { id, name, scope, pairingCode, pairingCodeExpiresAt }` | Create a one-scope device and issue a 10-minute code |
| POST | `/api/devices/:id/pairing-code` | admin | — | `{ pairingCode, pairingCodeExpiresAt }` | Revoke any current token and issue a new code |
| POST | `/api/devices/:id/revoke` | admin | — | 200 | Revoke token/code immediately |
| POST | `/api/device/pair` | public | `{ code }` | `{ id, name, scope, startPath }` + `fsk_device` cookie | Consume a one-time pairing code |
| POST | `/api/devices/validate` | internal | `X-Device-Token` header | `{ id, name, scope }` or 404 | Validate an opaque device token |

### Operations Contacts

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/ops-contacts` | official/admin | — | `[{ id, email, name, realname, phone, description, sort_order }]` | List users displayed in sidebar, ordered by `sort_order` |
| POST | `/api/ops-contacts` | admin | `{ user_id }` | 201 | Add an Official/Admin to the display |
| POST | `/api/ops-contacts/reorder` | admin | `{ user_ids: [...] }` | 200 | Replace the display order |
| PATCH | `/api/ops-contacts/:userId` | admin | `{ description }` | `{ description }` | Update the short description (max 30 characters) |
| DELETE | `/api/ops-contacts/:userId` | admin | — | 200 | Remove a user from the display |

### Account Applications (계정 신청)

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/apply/config` | public | — | `{ open: bool }` | 신청 접수 가능 여부 |
| GET | `/api/apply/me` | public | — | `{ registered: true, email, name }`(로그인됨) 또는 `{ registered: false, email, name, application, applicationsOpen }`(신청자) 또는 401 | 내 세션/신청 상태 (`fsk_applicant` 쿠키 또는 세션 검증) |
| POST | `/api/apply` | public | `{ realname, phone, affiliation }` | 201 | 계정 신청 접수 (`fsk_applicant` 쿠키 검증, 세 필드 모두 필수, 접수 열림 필요) |
| PATCH | `/api/apply` | public | `{ realname, phone, affiliation }` | 200 | 신청 내용 수정 (`fsk_applicant` 쿠키 검증, 세 필드 모두 필수, 접수 닫혀도 허용) |
| GET | `/api/applications` | admin | — | `[{ id, email, name, realname, phone, affiliation, ... }]` | 신청 목록 |
| PATCH | `/api/applications/config` | admin | `{ open: bool }` | 200 | 신청 접수 열기/닫기 |
| POST | `/api/applications/approve` | admin | `{ ids: [int], role }` | 200 | 신청 승인 |
| DELETE | `/api/applications` | admin | `{ ids: [int] }` | `{ deleted }` | 신청 삭제(거절/정리, 계정 추가 없음) |

### Log Aggregation

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/admin/logs` | admin | `?service=&limit=&offset=&level=&action=&actor=&from=&to=&search=` | `{ logs, total, services }` | Aggregated logs from all services (local auth + remote via the shared service registry) |

---

## Teams module (Competition port 9200)

### Team management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/meta` | public | — | `{ currentYear, years }` | KST current year and readable stored years in descending order; clients use `currentYear` as their default selection |
| GET | `/teams` | public / admin | `?year=&includeInactive=true` | `[{ id, year, number, university, name, vehicleTypeId, vehicleType, active }]` | Public reads active teams; admin may include inactive teams |
| GET | `/teams/:id` | admin | — | Team | Read one team by stable ID |
| GET | `/teams/export` | admin | `?year=` | `{ year, teams }` download | Export a readable year; vehicle types are represented by name on each team |
| POST | `/teams/import` | admin | `{ teams }?year=` | `201 [Team]` | Initial import; current or next year only and only while it has no teams; referenced type names must already exist |
| POST | `/teams` | admin | `{ number, university, name, vehicleTypeId? }?year=` | `201 Team` | Create a current- or next-year team with a stable ID |
| PATCH | `/teams/:id` | admin | `{ number?, university?, name?, vehicleTypeId?, active? }` | Team | Update projections or deactivate without changing the stable ID |

There is no team delete or roster replacement endpoint. Deactivation preserves historical rows and clears only transient operational state.

### Vehicle Types

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/vehicle-types` | public | `?year=` | `[{ id, year, name, sortOrder, color }]` | List yearly vehicle types |
| POST | `/vehicle-types` | admin | `{ name, color?, sortOrder? }?year=` | Vehicle type | Create a current- or next-year vehicle type |
| PATCH | `/vehicle-types/:id` | admin | `{ name?, color?, sortOrder? }` | Vehicle type | Update type and affected team projections transactionally |
| DELETE | `/vehicle-types/:id` | admin | — | 204 | Delete an unused current- or next-year vehicle type |

---

## Queue module (Competition port 9200)

### SSE

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/events` | public | — | SSE stream | Real-time queue/booth/penalty invalidation updates; initial data: `{ activeInspections, allBooths }`. The `penalties` event contains no protected penalty details. |

### Public Endpoints

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/active` | public | — | `[{ type, name, length, active, ... }]` | Active inspection types |
| GET | `/state/:num` | public | — | `{ year, queues: [{ type, name, isReinspection, rank, total, groupRank, groupTotal }] }` | Check every inspection wait for one entry number; ranks include the full queue and the initial/reinspection cohort |
| GET | `/public/queues` | public | — | `{ year, queues: [{ type, name, total, firstInspectionTotal, reinspectionTotal, entries: [{ teamId, number, university, name, isReinspection, rank, groupRank, groupTotal }] }] }` | Full team lists for active inspection types visible on the public Queue screen; never includes phone, priority, or timestamps |
| GET | `/booths/all` | public | — | `{ type: [{ booth_num, active, occupied_by, entered_at, timer_paused_at, timer_paused_ms }] }` | All booth statuses |
| GET | `/booths/:type` | public | — | `[{ booth_num, active, occupied_by, entered_at, timer_paused_at, timer_paused_ms }]` | Booth status for inspection type |

### Inspection Type Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/all` | `queue.operate` | — | `[{ type, name, length, active, ignore_priority, sms, sms_rank, cancel_penalty, ... }]` | All inspection types and their per-inspection settings (including inactive types) |
| GET | `/admin/inspection/:type` | `queue.operate` | — | `[{ num, phone, timestamp, is_reinspection, priority, rank, total, group_rank, group_total }]` | Queue listing with full-queue and initial/reinspection cohort ranks (sorted) |
| PATCH | `/admin/inspection/:type` | `queue.manage` | `{ active: bool }` | 200 | Toggle inspection active status |
| PATCH | `/admin/inspection/:type/visibility` | `queue.manage` | `{ hidden: bool }` | 200 | Toggle inspection visibility on the public Queue screen and register page |
| PUT | `/admin/inspection/:type/ignore` | `queue.manage` | `{ field, value }` | 200 | Set ignore_priority or ignore_reinspection |

### Queue Registration

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| POST | `/admin/register/:type` | `queue.manage` or `kiosk.queue.register` | `{ num, phone }` | 201 | Register team in queue (validates entry, penalty, concurrent rules) |
| POST | `/admin/cancel/:type` | `queue.operate` | `{ num }` | 200 | Cancel registration (applies time penalty) |
| POST | `/admin/inspection/:type/:num/last-call` | `queue.operate` | — | 200 | Send the queued phone an immediate-entry last-call SMS; returns 503 when SMS configuration is unavailable and 502 when delivery fails |

Last-call SMS requires a waiting team and usable SENS configuration, regardless of
the automatic notification toggle.

### Active Cancel Penalties

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/penalties` | `queue.operate` | — | `[{ num, inspection, inspection_name, until, can_restore }]` | List active cancel penalties for the current year |
| DELETE | `/admin/penalties/:type/:num` | `queue.operate` | — | 200 | Clear an active cancel penalty |
| POST | `/admin/penalties/:type/:num/restore` | `queue.operate` | — | 200 | Clear a penalty and restore the canceled queue entry at its original timestamp |

### Priority Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/priority/:type` | `queue.manage` | — | `[{ num, inspection, priority }]` | List priorities for inspection type |
| POST | `/admin/priority/:type` | `queue.manage` | `{ num, priority }` | 201 | Set/update team priority |
| DELETE | `/admin/priority/:type` | `queue.manage` | `{ num }` | 200 | Remove team priority |
| DELETE | `/admin/priority/:type/all` | `queue.manage` | — | 200 | Clear all priorities for inspection type |

### History

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/history/status` | `queue.operate` | — | `{ type: [num, ...] }` | 검차별 재검 이력 보유 팀 목록 (현재 연도) |
| DELETE | `/admin/history/:type` | `queue.manage` | — | 200 | Clear inspection history + booth occupancy for type |

### Booth Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/booths/:type` | `queue.operate` | — | `[{ booth_num, active, occupied_by, entered_at, timer_paused_at, timer_paused_ms }]` | Booth list for type |
| PATCH | `/admin/booths/:type/config` | `queue.manage` | `{ count }` | 200 | Change booth count (1-100) |
| PATCH | `/admin/booths/:type/:boothNum` | `queue.operate` | `{ active: bool }` | 200 | Toggle booth active/inactive |
| POST | `/admin/booths/:type/:boothNum/enter` | `queue.operate` | `{ num }` | 200 | Move team from queue to booth |
| PATCH | `/admin/booths/:type/:boothNum/timer` | `queue.operate` | `{ paused: bool }` | Booth status | Pause or resume only the displayed inspection timer |
| POST | `/admin/booths/:type/:boothNum/exit` | `queue.operate` | — | 200 | Complete inspection, record history |

### Statistics

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/stats/timerange` | `queue.operate` | `?year=` | `{ from, to }` | Log time range for year |
| GET | `/admin/stats` | `queue.operate` | `?from=&to=&inspection=` | `[{ num, registrations, cancellations, entries, totalOccupyTime }]` | All teams stats |
| GET | `/admin/stats/:num` | `queue.operate` | `?from=&to=&inspection=` | `{ summary, timeline }` | Single team stats with event timeline |

### Settings

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/settings/:type` | `queue.operate` | — | `{ sms: bool, smsRank: int, cancelPenalty: int }` | Read SMS and cancel-penalty settings for one inspection |
| PATCH | `/admin/settings/:type` | `queue.manage` | `{ sms?: bool, smsRank?: int, cancelPenalty?: int }` | `{ sms, smsRank, cancelPenalty }` | Update one inspection's settings (`smsRank`: 1–10, `cancelPenalty`: 0–60) |

## Registration module (Competition port 9200)

Registration rows use `competition_team.id` as their only team identity. Number and team labels below are canonical values resolved from that team. `waiting` is the operational state; `done` and `canceled` remain stored with the submitted phone and timestamps as audit history.

### Public status and lookup

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/events` | public | `?year=` | SSE stream | `init` and `registration`: `{ year, open, waiting }`; `entries`: year-scoped canonical-roster invalidation |
| GET | `/status` | public | `?year=` | `{ year, open, waiting }` | Public queue summary without other teams' call state |
| GET | `/lookup/:num` | public | `?year=` | `{ year, teamId, number, university, name, status, position, waitingTotal }` | Active registration-queue lookup by entry number; notification phone and registration timestamp are never returned |

### Kiosk and operations

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/queue` | `registration.operate` | `?year=` | `{ waiting, today, settings }` | Operational board; active rows include phone numbers |
| POST | `/queue` | `registration.manage` or `kiosk.registration.register` | `{ teamId, phone }` | `201 { id, teamId, number, position, waitingTotal, ... }` | Add one current-year active team while reception is open |
| POST | `/queue/:id/done` | `registration.operate` | — | `{ id, status: "done" }` | Complete a waiting registration |
| POST | `/queue/:id/cancel` | `registration.operate` | — | `{ id, status: "canceled" }` | Cancel a waiting registration |
| GET | `/settings` | `registration.operate` | `?year=` | `{ year, open, sms, notifyRank, smsAvailable, ... }` | Read year-scoped reception and SMS settings |
| PATCH | `/settings` | `registration.manage` | `{ year, open?, sms?, notifyRank? }` | Settings | Atomically update current-year settings (`notifyRank`: 1–10) |

Advance SMS delivery follows Queue behavior: when an active row is completed or canceled, the newly changed team at the exact configured rank receives one notification. Registration, settings, and team-deactivation changes do not send a message. A failed attempt releases its database claim without rolling back the queue mutation. The SMS provider configuration remains owned by the Email service.

## Inspection module (Competition port 9200)

### SSE

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/sheet/events` | `inspection.operate` | — | SSE stream | Real-time answer/memo/result/inspector updates |

### Template Management

`RULES_BASE_URL` in both clusters' configmaps is the catalog directory URL,
for example `https://luftaquila.github.io/fsk-rules/`. The client appends
`rules-manifest.json` to fetch the schema-v2 manifest; do not include that filename
in the setting. Fetch limits: 3 s, 5 MB, ten-minute cache.
`deployment.site_tag` must match `site-YYYYMMDD-vN`; document `release_tag`
must match `formula-<document>-YYYY-vN`. Invalid/unavailable catalogs fail
dependent endpoints with `503 RULE_CATALOG_UNAVAILABLE`, without failing readiness.
Retired stable keys remain declared in the catalog's `retired_rule_keys`.

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/sheet/template` | `inspection.operate` | `?year=` | Tree: `[{ id, name, excluded_types, subcategories: [{ groups: [{ items: [{ ..., field_key, rule_refs }] }] }] }]` | Template tree for year; `rule_refs.status` is `verified`, `needs_review`, or `no_direct_rule` |
| POST | `/sheet/template` | `inspection.manage` | `{ year, level, parent_id?, name, sort_order?, answer_type?, remarks?, unit?, pdf_include?, excluded_types? }` | `{ id }` | Create template node |
| PUT | `/sheet/template/:id` | `inspection.manage` | `{ name?, sort_order?, answer_type?, remarks?, unit?, pdf_include?, excluded_types? }` | 200 | Update template node |
| DELETE | `/sheet/template/:id` | `inspection.manage` | — | 200 | Delete template node (CASCADE, blocks past years) |
| POST | `/sheet/template/reorder` | `inspection.manage` | `{ items: [{ id, sort_order }] }` | 200 | Reorder sibling nodes |
| POST | `/sheet/template/copy` | `inspection.manage` | `{ from_year, to_year }` | 201 `{ statuses, reasons, catalog_required, catalog_available }` | Copy template across years and carry verified references only when stable keys and content hashes match; the catalog is consulted only when a source item carries references |
| POST | `/sheet/template/import` | `inspection.manage` | `{ year, template: [...] }` | 201 | Destructively import a full template from JSON; verified references follow their stable keys into the target catalog and stay `verified` only when the clause content is unchanged, including same-edition revisions |
| GET | `/sheet/rules/search` | `inspection.operate` | `?year=&document?=&q?=` | `{ year, rules: [{ edition, document, rule_key, clause_id, citation, text, content_hash, release_tag }] }` | Search stable-keyed catalog clauses; maximum 100 results |
| GET | `/sheet/rule-content/:itemId` | `inspection.operate` | — | `{ rules: [{ ..., reference_index, content_html }] }` | Resolve and hash-check every stored reference, load each distinct rule document through a bounded release-keyed cache (2 MiB source limit), extract only the resolved clauses, and return those fragments as inert JSON for client-side allowlisting |
| PUT | `/sheet/template/:id/rule-refs` | `inspection.manage` | `{ expected_rule_refs, status, rule_keys: [...] }` | `rule_refs` | Replace one item's references using the caller's last-read `rule_refs`; a mismatch returns `409 INSPECTION_STALE_WRITE` without persistence. Only `verified` accepts non-empty keys. Each stored reference carries `edition`, `document`, `rule_key`, `clause_id`, `citation`, `source_hash`, and the catalog `release_tag` it was resolved against |
| POST | `/sheet/template/rule-refs/import` | `inspection.manage` | `{ year, template: [...] }` | `{ year, counts }` | Import only rule references from the normal template export; requires an exact transactional `field_key` set, rechecks verified content hashes including same-edition revisions, and does not replace template rows or answers |
| POST | `/sheet/template/rule-refs/sync` | `inspection.manage` | `{ from_year, to_year }` | `{ counts, reasons }` | Fill target `needs_review` items by matching `field_key`; verified target decisions are preserved |
| POST | `/sheet/template/rule-refs/revalidate` | `inspection.manage` | `{ year }` | `{ year, counts }` | Refresh catalog metadata; changed or missing verified clauses become `needs_review` and are never auto-promoted |
| GET | `/sheet/rule-link/:itemId/:referenceIndex` | `inspection.operate` | — | 302 | Resolve a verified, hash-matching stable key to the current safe Pages anchor for that edition |

After catalog releases, revalidate affected years and inspect audit
`counts.changed`, `counts.missing`, `catalog_site_tag`, and `catalog_releases`.
Changed/missing references require explicit review; never auto-promote them.
If a target edition was unavailable during year copy, sync after publication.
Preserve reviewed template exports in Git for recovery.

| Failure | Recovery |
|---|---|
| `503 RULE_CATALOG_UNAVAILABLE` | Check `RULES_BASE_URL`, catalog deployment/schema, and `phase: rule_catalog` logs from `rule_refs.search` / `rule_link.resolve` |
| `409 INSPECTION_STALE_WRITE` | Reload current references before retrying |
| `409 RULE_REFERENCE_CHANGED` / `RULE_REFERENCE_MISSING` | Revalidate the year, then explicitly review affected items |
| `500 INVALID_STORED_RULE_REFS` | Restore references from the last template export; do not hand-edit clause IDs or hashes |

`excluded_types` contains up to 50 vehicle type **names** (entry's
`vehicle_types_<year>`) excluded from a category. Default `[]` admits every type,
including new types. Non-arrays return 400. Copy and JSON export/import preserve
it; non-category levels always return `[]`.

### Sheet Data

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/sheet/summary` | `inspection.operate` | `?year=` | `{ categories: [{ id, name, excluded_types }], teams }` | All teams' category-level results and automatic inspector-name arrays |
| GET | `/sheet/bulk-answers` | `inspection.operate` | `?year=&item_ids=1,2,3` | `{ team_num: { item_id: value } }` | Bulk answer values for specific items |
| GET | `/sheet/data/:year/:num` | `inspection.operate` | — | `{ answers, results, inspectors }` | Full sheet data; `inspectors[category_id]` is an array of real names and each answer has independent answer/memo update metadata |
| PUT | `/sheet/answer` | `inspection.operate` | `{ year, team_num, item_id, value, expectedValue }` | `{ value, updated_at, updated_by }` | Save only if the stored answer still equals the caller's last-read value; `passfail` items accept `PASS`, `FAIL`, `N/A`, or an empty value |
| PUT | `/sheet/memo` | `inspection.operate` | `{ year, team_num, item_id, memo, expectedMemo }` | `{ memo, updated_at, updated_by }` | Save only if the stored memo still equals the caller's last-read memo |
| PUT | `/sheet/category-result` | `inspection.operate` | `{ year, team_num, category_id, result }` | 200 | Upsert category PASS/FAIL (broadcasts SSE); PASS returns 409 until every response item is complete, while FAIL and clearing remain available |

There are no answer or memo version numbers. If `expectedValue` or `expectedMemo` differs from the stored value, the server returns `409 { code: "INSPECTION_STALE_WRITE", current }` and persists nothing. The browser discards the stale local value and instructs the operator to refresh and retry.

Answer/memo mutations require an authenticated real name and append it to the
category's inspector history; no-op saves do not. There is no manual inspector
mutation endpoint. `answer_updated_by`, `answer_updated_at`, `memo_updated_by`, and
`memo_updated_at` track the two fields independently.

## Traffic module (Competition port 9200)

### SSE

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/events` | `traffic.operate` | — | SSE stream | Real-time record/event-mode + live-attempt + wireless updates. init: `{ recordFiles, eventModes, recordVisibility, liveAttempts, wireless: { light, mapping, telemetry, bridge, sessions, qualityFaults, lastEventId } }`. A `live-attempt` event shares the start/stop state published by wired and manual timing clients. `qualityFaults` contains the latest active automatic-stop reason per event. Wireless event names: `wireless:event`, `wireless:telemetry`, `wireless:light`, `wireless:mapping`, `wireless:bridge`, `wireless:session`, `wireless:command`, `wireless:quality-fault`. A quality-fault payload is `{ fault_id, event_type, run_id, kind, occurred_at, reasons }`; a successful subsequent START or late confirmation of the completed pre-fault interval emits `{ event_type, cleared: true }`. |

### Live Attempts

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| POST | `/live-attempts` | `traffic.operate` | `{ action: start, event_type, attempt_id, event_name, team }` or `{ action: stop, event_type, attempt_id }` | Start: live attempt (201); stop: `{ cleared }` | 유선 계측기와 유선 매뉴얼 모드의 출발 센서 상태를 전광판에 공유한다. 시작과 종료는 `live-attempt` SSE로 전파되며, 10분이 지난 미완료 상태는 자동 종료된다. |

### Record Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/records` | `traffic.operate` | — | `["FSK 2025 가속 1차", ...]` | List all record table names |
| GET | `/records/:name` | `traffic.operate` | — | `[{ rowid, time, num, univ, team, type, result, status, detail, cones, oc, scoreboard }]` | Get records. `status` is `null` (normal), `DNS`, `DNF`, or `DSQ`; a classified row may retain its positive raw `result` |
| GET | `/records/year/:year` | `traffic.operate` | — | `[{ name, records: [...] }]` | 연도별 기록 일괄 조회 (visibility 필터 적용, score 집계용) |
| GET | `/records/visibility` | `traffic.operate` | — | `{ name: bool }` | 기록 파일별 성적 반영 여부 |
| PUT | `/records/:name/visibility` | `traffic.manage` | — | `{ name, visible }` | 기록 파일 성적 반영 토글 |
| POST | `/records` | `traffic.operate` | `{ name, data: { time, type, entry: { id, num, univ, team }, result?, status?, detail? } }` | `{ name, record }` (201) | Add record (auto-creates table with `FSK {year}` prefix). `status=null` requires a positive integer `result`; `DNS`/`DNF`/`DSQ` allow a null or positive raw result. The stable team `id` is re-resolved at save time |
| PATCH | `/records/:name/:rowid` | `traffic.operate` | `{ field, value }` | `{ num, ... }` | Update `status`, `scoreboard`, `detail`, `cones`, `oc`, or `result`. `status` is explicit and scoreboard visibility is independent. An untimed status row cannot be restored to normal; cancel it with DELETE |
| DELETE | `/records/:name/:rowid` | `traffic.operate` | — | `{ name, rowid, deleted }` | Cancel and delete an untimed (`result=null`) status row only. Timed rows must be retained and reclassified |
| DELETE | `/records/:name` | `traffic.manage` | — | 200 | Drop record table |

### Event Modes

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/event-modes` | `traffic.operate` | — | `[{ event_type, enabled }]` | Event mode statuses |
| PUT | `/event-modes/:type` | `traffic.manage` | — | `{ event_type, enabled }` | Toggle event mode (broadcasts SSE) |

### Wireless LoRa Timing (one master + ≤6 sensors, single channel)

마스터에 USB로 연결된 브리지 PC가 캡처·유실 구간·확인 지점(checkpoint)과 진단을 서버로 보낸다. 무선에는 물리 신호등이 없다. 경기별 독점 lease 보유자가 `start`, `stop`, `reset`으로 제어하며, 실제 측정 시작점은 출발 센서 통과다.

서버만 공식 결과를 계산한다. 각 센서의 boot ID와 연속 캡처 순번을 확인하고, 모든 필수 센서의 checkpoint가 측정 구간을 포함할 때 확정한다. 전송 지연·순서 역전·비콘 누락·오래된 진단만으로 중단하지 않으며 확인 전에는 `pending`으로 수집을 계속한다. 실제 캡처 유실·캡처 시계 오류·세션 변경은 계측을 해제하고 영향을 받은 구간을 `invalid`로 표시한다. 자동 오류 뒤에도 이전 런의 증거 검증은 계속하며, 오류 이전의 정상 구간은 증거가 늦게 도착하거나 서버가 재시작되어도 확정할 수 있다. 완주 구간이 검증되면 `verified`로 변경하고 해당 런의 오류 표시를 해제한다. 이미 검증된 앞 구간의 기록은 보존한다. 명시적 정지·초기화·판정 확정 또는 새 START는 이전 런의 추가 검증을 종료한다. 정상 기준점을 확보한 다음 START로 복구하며 누적 오류 카운터를 지우거나 재부팅할 필요가 없다.

종목별 시간 상·하한은 없다. 원시 tick 차이가 양수인지 확인하고 마지막에 한 번 ms로 반올림한다. 양수 구간이 0ms로 반올림되는 것도 자동 기록에서 허용한다. 수동 기록 입력은 양의 ms 정수다.

세션 객체: `{ event_type, armed, start_tick, master_boot_id, run_id, armed_at, team, event_name, controller, lease_expires_at, updated_at, verification: pending|verified|invalid, result, lap_times, finished, saved_record_name, saved_record_rowid }`. 시작 전 `verification`은 null이며 `lap_times`는 ms 배열이다. `finished`는 추가 증거 검증까지 종료되었음을 뜻한다. 자동 오류 뒤에는 `armed: false`, `verification: invalid`, `finished: false`로 이전 증거를 기다릴 수 있으며 별도 대기 시간 제한은 없다.

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| POST | `/wireless/clock` | `traffic.operate` | `{ request_id(32자 소문자 hex), master_tick(str 64-bit), master_boot_id(uint32) }` | `{ ok: true }` | `wireless:command { action: "clock", request_id }`에 대한 브리지 응답. 마스터의 `T` 응답을 전달한다. 잘못된 형식은 400, 만료·중복·미요청 응답은 409. |
| POST | `/wireless/ingest` | `traffic.operate` | `{ events?: [{ node_id, ev_seq(uint16), master_tick(str uint64), master_boot_id(uint32), sensor_boot_id(uint32), capture_seq(uint32), end_seq(uint32), end_tick(str uint64), flags(uint8), sync_age_ms(uint16), rssi?, snr? }], telemetry?: [...] }` (각 ≤200) | `{ stored, deduped, rejected, acknowledged: [{ node_id, ev_seq, master_tick, master_boot_id, sensor_boot_id }] }` | v9 캡처 증거를 원본·런 상태·공식 기록과 한 트랜잭션으로 저장한다. 전체 ACK 키로 멱등 처리하며 commit 전에는 ACK·SSE를 보내지 않는다. DB 실패는 500이며 같은 배치를 재시도한다. checkpoint는 stored/deduped 캡처 수에서 제외되지만 ACK에는 포함된다. 진단은 최신 상태만 표시하며 측정 구간의 증거를 대체하지 않는다. |
| PUT | `/wireless/debounce` | `traffic.manage` | `{ ms: 0~5000 정수 }` | `{ ...light }` | 센서 디바운스 창(ms). 한 통과의 다중 엣지(바운스)를 접는 간격. 기본 300, 0이면 끔. `wireless_light.debounce_ms`에 저장, `wireless:light` 브로드캐스트(모든 화면 공유) |
| GET | `/wireless/mapping` | `traffic.operate` | — | `[{ node_id, event_type, role, label, enabled, updated_at }]` | 센서→경기·역할 매핑 |
| PUT | `/wireless/mapping/:node_id` | `traffic.manage` | `{ event_type, role(start\|finish\|lane1~lane9), label?, enabled? }` | `{ ...row }` | 매핑 upsert (`wireless:mapping` 브로드캐스트). 가속·오토크로스=start+finish, 스키드패드·내구=start(단일 센서 멀티랩). 기록 엔진은 finish만 센서2로 취급, 그 외(start·lane*)는 센서1 |
| DELETE | `/wireless/mapping/:node_id` | `traffic.manage` | — | 200 | 매핑 삭제 |
| GET | `/wireless/state` | `traffic.operate` | — | `{ light, mapping, telemetry, bridge, sessions, qualityFaults, lastEventId }` | 재연결용 스냅샷. `light`는 기존 이름의 브리지/디바운스 설정 객체이며 색·물리 제어 의미는 없다. `qualityFaults`는 다음 정상 START까지 유지되는 확정 오류다. |
| GET | `/wireless/events` | `traffic.operate` | `?since=<id>&limit=<n≤1000>` | `[{ id, ...event, server_time }]` | 캡처·유실·checkpoint 원본 백필. 화면은 건강한 캡처만 통과 목록에 표시하고 공식 결과는 session에서 읽는다. |
| POST | `/wireless/arm` | `traffic.operate` | `{ event_type, action: start\|stop\|reset, team?, event_name? }` | `{ ...session }` | START는 필수 매핑·최신 HFXO/동기/skew·건강한 checkpoint와 브리지·마스터 `T` 왕복 시각을 확인하고 팀/이벤트를 고정한다. 이미 armed이거나 준비되지 않으면 409. 클라이언트 tick은 시작 기준으로 신뢰하지 않는다. STOP은 현재 수집을 닫고 결과를 보존한다. RESET은 현재 런과 화면을 즉시 초기화하며 저장 기록은 보존한다. |
| POST | `/wireless/select` | `traffic.operate` | `{ event_type, team?: { id, num, univ, team }\|null, event_name?: string\|null }` | `{ ...session }` | 경기 선택(팀·이벤트명) 공유 — 서버 기록 귀속. 안정적 팀 ID를 현재 활성 팀으로 재확인하며 오래되거나 유효하지 않으면 409, null=해제. lease 점유자만. `wireless:session` 브로드캐스트 |
| POST | `/wireless/status` | `traffic.operate` | `{ event_type, status: DNS\|DNF\|DSQ }` | `{ name, record, session }` | 선택된 팀/이벤트의 현재 시도를 판정한다. arm 단계와 무관하게 가능하며, 부분·완료 기록이 있으면 raw result를 보존한 같은 행을 갱신하고 없으면 untimed status 행을 만든다. lease 점유자만 |
| POST | `/wireless/lease/:event` | `traffic.operate` | — | `{ ...session }` | 경기 독점 제어 lease 획득/갱신(heartbeat). 타인 점유 시 409. 점유자 변경 시만 `wireless:session` 브로드캐스트(heartbeat는 조용히 만료 연장) |
| DELETE | `/wireless/lease/:event` | `traffic.operate` | — | `{ ...session }` | lease 해제(보유자 또는 admin 강제 회수). `wireless:session` 브로드캐스트 |
| GET | `/time` | public | — | `{ now }` | 서버 epoch ms — 클라가 라이브 클럭을 서버 기준으로 동기화(오프셋 추정). 인증 면제 |
| POST | `/wireless/bridge/offline` | `traffic.operate` | — | `{ ...bridge }` | 브리지가 종료 직전 오프라인을 즉시 보고 (15초 무수신 감지 대기 없이) |

무선 프로토콜은 v9다. 서버·웹 브리지·마스터·전 센서는 같은 버전을 사용한다. 업그레이드 시 캡처 검증 정보가 없는 진행 런은 중단하고 저장된 공식 기록은 보존한다.

시작 시각 확인 중 성공한 정지·초기화나 다른 경기 제어 요청으로 상태가 바뀌면 해당 START는 `409`로 거부된다. 서버는 시각 확인 전후에 계측 준비 상태를 검사하고, 확인 중 저장된 캡처도 새 런에서 한 번만 처리한다.

## Score module (Competition port 9200)

### SSE

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/score/events` | `score.operate` | — | SSE stream | 화이트리스트만 재전파: entry `entries`, inspection `category-result`/`answer`, traffic `records`/`record-visibility`/`event-mode`. 재연결 시 `refresh`. 로컬 이벤트: `manual-score`/`penalty`/`setting`/`endurance`/`publication` |
| GET | `/score/public/:year/events` | public (공개 활성 시) | — | SSE stream | 공개 성적표 갱신용 `refresh`, 공개 전환용 `publication`. 관리자 이벤트 페이로드는 노출하지 않음. 전체 500개·IP당 10개 연결 제한 |

### Score Aggregation

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/score` | `score.operate` | `?year=` | `{ entries, inspection, events, manualScores, penalties, settings, energy }` | Main aggregation. `energy` contains configuration, reference values, and per-team `PENDING`/`DSQ`/`SCORED` results |

### Public Scoreboard

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/score/publication` | `score.operate` | `?year=` | `{ year, enabled }` | 연도별 공개 상태 조회 |
| PUT | `/score/publication` | `score.manage` | `{ year, enabled }` | `{ year, enabled }` | 연도별 공개 상태 변경 |
| GET | `/score/public/:year` | public (공개 활성 시) | — | `{ year, entries, events }` | 번호/학교·팀/유형과 내구 제외 경기 모드의 최종 기록만 반환 |

### Manual Scores

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| PUT | `/score/manual` | `score.operate` | `{ year, team_num, score_type, value }` | 200 | Upsert manual report/bonus/deduction score. `energy` is rejected because it is calculated from endurance measurements; report values cannot exceed `보고서.total` when configured |

### Penalty & Score Settings

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| PUT | `/score/penalty` | `score.manage` | `{ year, event_type, cone_penalty, oc_penalty, start_delay }` | 200 | Set per-event penalty values |
| PUT | `/score/setting` | `score.manage` | `{ year, event_type, setting_key, value }` | 200 | Set score settings. Events use `total`/`finish`/`cutoff`; report uses `보고서.total`; energy uses `에너지.total` plus `distance_km`/`fuel_factor` (2.31 L or 2.95 kg) |

### Endurance

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/score/endurance` | `score.operate` | `?year=` | `{ team_num: { status, driver1_name, driver1_time, driver2_name, ... } }` | Endurance driver names, results, and energy measurement records for year. Energy class is derived from the entry vehicle type (`C-Formula` or `E-Formula`) |
| PUT | `/score/endurance` | `score.operate` | `{ year, team_num, field, value }` | 200 | Update endurance fields, including `driver1_name`/`driver2_name` (trimmed, up to 100 characters), the `qualified` flag, or energy fields (C fuel/extra fuel, E net energy, official energy DSQ flag). Boolean flags accept `0` or `1`. Energy class cannot be written manually; negative values are accepted only for E net energy |

## Documents module (Competition port 9200)

### Student API

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/entries` | student | `?year=` | `{ num: { univ, team, type, active } }` | 로그인 학생에게 해당 연도의 자기 매핑 팀만 반환. 비활성 팀도 포함 |
| GET | `/sessions` | student | `?year=` | `{ team, sessions }` | My team's sessions and latest submission for the selected year; defaults to the latest mapped year |
| GET | `/sessions/:id` | student | — | `{ session, team_num, submission, files }` | Session detail with files |
| POST | `/sessions/:id/submit` | student | `multipart/form-data` | `{ id, submitted_at, is_late, total_size }` | Upload files (validates time window, extensions, size) |
| GET | `/submissions/:subId/files/:fileId` | student | — | File stream | Download own submission file (PDF/text/image/AV → `inline`, other → `attachment`) |
| GET | `/submissions/:subId/zip` | student | — | ZIP stream | 자기 팀 제출물 전체 zip 다운로드 |

### Operations API

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/entries` | `documents.operate` | `?year=` | `{ num: { univ, team, type, active } }` | 계정 할당·제출 대상 선택을 위한 전체 엔트리 목록. 비활성 팀도 포함 |
| GET | `/admin/sessions` | `documents.operate` | `?year=` | `[{ id, name, notice, start_at, end_at, ... }]` | All sessions |
| POST | `/admin/sessions` | `documents.manage` | `{ name, notice?, start_at, end_at, late_end_at?, max_file_size?, allowed_extensions?, year, teams: [int] }` | `{ id }` | Create session |
| PUT | `/admin/sessions/:id` | `documents.manage` | `{ name, notice?, start_at, end_at, late_end_at?, max_file_size?, allowed_extensions?, teams: [int] }` | 200 | Update session (cleans up removed teams' submissions) |
| DELETE | `/admin/sessions/:id` | `documents.manage` | — | 200 | Delete session + all files |
| GET | `/admin/sessions/:id/status` | `documents.operate` | — | `{ session, status: [{ team_num, submission, files, prevSubmission, prevFiles, submissionCount }] }` | Per-team submission status (`submissionCount` = 누적 제출 횟수, 직전 1건은 `prevSubmission`) |
| GET | `/admin/submissions/:subId/files/:fileId` | `documents.operate` | — | File stream | Admin file download (PDF/text/image/AV → `inline`, other → `attachment`) |
| GET | `/admin/submissions/:subId/zip` | `documents.operate` | — | ZIP stream | 제출물 전체 zip 다운로드 (팀 라벨 포함 파일명) |
| GET | `/admin/sessions/:id/archive` | `documents.operate` | — | ZIP stream | 세션 전체 아카이브 (팀별 폴더 구조) |
| GET | `/admin/years/:year/archive` | `documents.operate` | — | ZIP stream | 연도 전체 아카이브 (세션/팀별 폴더 구조) |
| DELETE | `/admin/years/:year/files` | `documents.manage` | — | `{ sessions, files }` | 연도별 파일 데이터 삭제 (제출 기록은 유지) |
| GET | `/admin/students` | `documents.operate` | — | `[{ email, name, realname, phone }]` | Active student users (fetched from auth service) |
| GET | `/admin/student-teams` | `documents.operate` | `?year=` | `[{ email, team_num, year }]` | Student-team mappings |
| POST | `/admin/student-teams` | `documents.manage` | `{ email, team_num, year }` | `{ email, team_num, year }` | Add student-team mapping |
| DELETE | `/admin/student-teams/:email/:year` | `documents.manage` | — | 200 | Remove student-team mapping |

## Email Service (port 9900)

이메일/SMS 관리 서비스. health와 internal API를 제외한 모든 화면·API는 admin 전용이다.

### Config

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/config` | admin | — | `{ brevo_api_key: "****xxxx", brevo_sender_name, brevo_sender_email, naver_cloud_access_key: "****xxxx", ... }` | 설정 목록 (민감 키는 마스킹) |
| PUT | `/api/config` | admin | `{ configs: [{ key, value }] }` | `{ updated: ["key1", ...] }` | 설정 업데이트 (빈 값·마스킹 값 무시) |
| POST | `/api/config/reset` | admin | `{ group: "brevo" \| "sms" }` | `{ reset: ["key1", ...] }` | 그룹 설정 일괄 초기화 |

Config keys: `email_enabled`, `brevo_api_key`, `brevo_sender_name`, `brevo_sender_email`, `naver_cloud_access_key`, `naver_cloud_secret_key`, `naver_cloud_sms_service_id`, `phone_number_sms_sender`

### Stats & Quota

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/stats` | admin | — | `{ sent: 12, errors: 0, totalSent: 100, totalErrors: 3 }` | 오늘·누적 전송/오류 건수 |
| GET | `/api/quota` | admin | — | `{ remaining: 288 }` or `{ remaining: null, error: "..." }` | Brevo 남은 일일 전송 가능 수 (GET /v3/account) |

### Email Log

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/emails` | admin | `?limit=50&offset=0&status=sent\|error` | `{ rows: [{ id, subject, recipient, status, error, message_id, source, sent_at, sent_by }], total }` | 전송 기록 (수신자별 1행, 페이지네이션, 상태 필터. 본문은 미포함) |
| GET | `/api/emails/:id` | admin | — | `{ id, subject, recipient, ..., html_content }` | 전송 기록 상세 (본문 포함) |

### Email Sending

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| POST | `/api/send` | admin | `{ subject, htmlContent, recipients: ["email@..."] }` | `{ success: true, messageId }` | 이메일 전송 (Brevo POST /v3/smtp/email). 전송 전 quota 확인 — 부족 시 400 |
| GET | `/api/recipients` | admin | — | `[{ email, name, role, realname, active }]` | 수신자 목록 (auth 서비스에서 사용자 프록시) |

- `email_enabled`가 `FALSE`이면 전송 거부 (503)
- Quota 부족 시 응답: `400 "전송 가능한 메일 수(N건)가 수신자 수(M명)보다 적습니다."`
- 전송 성공/실패 모두 email_log 테이블과 시스템 로그에 동시 기록

### Test

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| POST | `/api/test-email` | admin | `{ recipient: "email@..." }` | `{ success: true }` | Brevo 설정 검증용 테스트 이메일 전송 |
| POST | `/api/test-sms` | admin | `{ recipient: "01012345678" }` | `{ success: true }` | Naver Cloud SMS 설정 검증용 테스트 SMS 전송 |

### Internal API

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| POST | `/api/internal/send` | internal | `{ subject, htmlContent, recipients: [...], source }` | `{ success: true, messageId }` | 다른 서비스용 이메일 전송 API. `source`로 호출 서비스 식별 (e.g., "auth"). 내부 호출은 성공 시 `email.send` info 로그를 남기지 않음 (호출자가 집계 로그를 남기는 전제, email_log 테이블에는 수신자별 행이 그대로 기록). 부분 실패(`email.send_partial`)·전부 실패(`email.send` warn)는 그대로 기록. |
| GET | `/api/internal/sms-config` | internal | — | `{ naver_cloud_access_key, naver_cloud_secret_key, naver_cloud_sms_service_id, phone_number_sms_sender }` | SMS configuration for the Competition Queue and Registration modules (unmasked) |

---

## Course Service (port 10000)

코스·콘 API와 SSE, 스냅샷 생성은 `course.operate`, 스냅샷 조회·복원·삭제와 코스 삭제는 `course.manage`, 미션 프리셋과 장치 목록은 `rover.operate`가 필요하다. 로버와 GPS 유닛은 fsk-coursekeeper 장치 API를 tailnet에서 직접 제공하며 콘솔이 브라우저에서 직접 연결한다. 공개 조회는 `/course/public`에서 제공한다.

### Courses (`course.operate`)

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/courses` | `course.operate` | — | `[{ id, name, cone_count, reverse, start_cone_id, is_public, created_at, updated_at }]` | 코스 목록 조회 |
| POST | `/api/courses` | `course.operate` | `{ name }` | 201 `{ id, name, created_at, updated_at }` | 코스 생성 |
| PATCH | `/api/courses/:id` | `course.operate` | `{ name }` | `{ id, name, updated_at }` | 코스 이름 수정 |
| PATCH | `/api/courses/:id/direction` | `course.operate` | `{ reverse?, start_cone_id?: int\|null }` | `{ ...course }` | 코스 진행 방향(reverse)·시작 콘 저장 (요청에 담긴 것만 갱신, start_cone_id null=자동 시작 게이트). 주행 마커가 없는 코스의 폴백 값이며 UI는 시작 콘만 노출한다. `courses` SSE(type=direction) 브로드캐스트 |
| DELETE | `/api/courses/:id` | `course.manage` | — | 200 | 코스 삭제 (콘·메모·스냅샷·주행 마커·미션 프리셋 CASCADE 삭제). 활성 미션이 쓰는 코스는 콘솔이 삭제를 막는다 |
| GET | `/api/courses/:id/export` | `course.operate` | — | `{ name, cones, memos, route_markers, route_steps, ... }` | 코스 JSON 다운로드. `route_steps`는 DB id가 아닌 `route_markers` 배열 인덱스 |
| POST | `/api/courses/import` | `course.operate` | `{ name, cones, memos?, route_markers?, route_steps? }` | 201 `{ id, name, ... }` | JSON으로 코스 일괄 생성 (트랜잭션, 주행 단계의 마커 인덱스를 새 id로 재매핑) |

### Public courses

공개 여부는 FSK 전용 `course_publication` 테이블에 행이 있는지로 저장하며, 운영 API의 코스 응답·`courses` SSE에는 `is_public`(0\|1)으로 덧붙여집니다. 기존·신규·가져온 코스의 기본값은 비공개입니다. 관리 화면에서 공개로 전환한 코스의 현재 내용을 그대로 제공하며, 별도의 공개 스냅샷은 만들지 않습니다. 아래 경로는 Course 서비스 기준이며 외부에서는 `/course` 접두어를 붙입니다.

| Method | Path | Auth | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| PATCH | `/api/courses/:id/publication` | `course.manage` | `{ is_public: boolean }` | `{ ...course, is_public: 0\|1 }` | 공개/비공개 전환. `course.publication` 로그에 변경 전후 공개 상태 기록 |
| GET | `/api/public/courses` | public | — | `[{ id, name, cone_count }]` | 공개된 코스만 조회 |
| GET | `/api/public/courses/:id` | public | — | `{ course: { id, name, reverse, start_cone_id }, cones: [{ id, lat, lng, alt, side }], route: { markers: [{ id, lat, lng, label }], steps: [marker_id, ...] } }` | 지도와 다운로드용 현재 코스 데이터. 비공개·없는 코스는 동일한 404 |

공개 목록·상세는 `Cache-Control: no-store`이며 메모·운영 메타데이터를 제외합니다. 공개 화면은 진입 시 조회한 데이터를 수동 새로고침까지 유지하며 SSE·폴링은 없습니다. 운영 SSE는 유지합니다.

공개 다운로드는 클릭 시 상세 API를 새로 조회한 다음 브라우저에서 ZIP을 생성합니다. 생성 완료 후에도 해당 코스의 공개 여부와 내용이 유지되는지 다시 확인하며, 변경되었으면 다운로드를 취소합니다. 공개 JSON에는 `memos` 필드 자체가 없고 PNG·트랙 파일에도 메모를 포함하지 않습니다. ZIP은 코스 JSON, 미리보기 PNG, Assetto Corsa 트랙 ZIP, 영어 설치 안내 `README.txt`로 구성됩니다. 관리 화면의 ZIP도 README를 포함하며 기존 메모 내보내기를 유지합니다.

### Course Snapshots

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/courses/:id/snapshots` | `course.manage` | — | `{ snapshots: [{ id, course_id, taken_at, actor, reason, cone_count }] }` | 코스 스냅샷 목록 (최신순 최대 100개) |
| POST | `/api/courses/:id/snapshots` | `course.operate` | `{ reason? }` | 201 | 현재 콘 상태 스냅샷 저장. 콘솔은 미션 생성 시 `auto:` 사유로 남긴다 |
| POST | `/api/courses/:id/snapshots/:sid/restore` | `course.manage` | — | 200 | 스냅샷으로 콘 상태 복원 (복원 직전 자동 스냅샷) |
| DELETE | `/api/courses/:id/snapshots/:sid` | `course.manage` | — | 200 | 스냅샷 삭제 |

### Cones (`course.operate`)

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/courses/:id/cones` | `course.operate` | — | `[{ id, course_id, lat, lng, alt, side, created_at, updated_at }]` | 코스의 콘 목록 |
| POST | `/api/courses/:id/cones` | `course.operate` | `{ lat, lng, alt?, side }` | 201 `{ id, course_id, lat, lng, side, ... }` | 콘 추가 (side: "left"\|"center"\|"right") |
| DELETE | `/api/courses/:id/cones` | `course.operate` | — | 200 | 코스의 콘 전체 삭제 (bulk wipe) |
| PATCH | `/api/cones/:id` | `course.operate` | `{ lat?, lng?, side? }` | `{ id, course_id, lat, lng, side, updated_at }` | 콘 수정 (위치/방향) |
| DELETE | `/api/cones/:id` | `course.operate` | — | 200 | 콘 삭제 |

### 주행 순서 마커

주행 마커는 콘과 별도인 재사용 가능한 지도 앵커다. `steps`는 마커 id 배열이며 같은 id를 여러 번 포함할 수 있어 스키드패드의 `진입 → 좌 2회 → 우 2회 → 진출`처럼 물리 노면을 반복 통과하는 순서를 표현한다.

주행 방향의 단일 지정 수단이다. `course.reverse` / `course.start_cone_id`는 마커가 없는 코스에만 적용되는 폴백으로 남고, 웹 UI에는 진행방향 전환 컨트롤이 없다.

fsk-coursekeeper 패키지 `route-mode.mjs`의 `resolveCourseRoute`가 지도·ZIP 내보내기 양쪽에서 계산 방식을 결정한다 (동일 입력 → 동일 결과):

| mode | 조건 | 계산 |
|---|---|---|
| `auto` | 해석 가능한 단계 2개 미만 | `computeCenterline` + 저장된 `start_cone_id`/`reverse` |
| `oriented` | 단계가 한 루프를 한 방향으로 훑음(반복 방문 없음, 모든 마커가 노면 위, 되돌아가지 않음) | `computeCenterline`. 마커가 `start`와 `reverse`만 공급하므로 **기하는 마커 도입 전과 완전히 동일** |
| `guided` | 그 외(반복 방문·분기·노면 밖 마커) | `computeGuidedRoute` |

닫힌 루프에서 마커 2개는 어느 쪽으로 돌아도 도달하므로 첫 구간은 **짧은 호**로 해석한다. 먼 쪽을 강제하려면 반대편에 마커를 추가한다.

마커 이전에 생성된 코스는 서비스 부팅 시 `course.seed_route_markers_from_direction.v1` 마이그레이션이 저장된 방향을 재현하는 마커 2개(루프 시작점과 1/3 지점)를 심는다. 루프로 닫히지 않는 코스는 건드리지 않아 `auto`로 남는다.

| Method | Path | Role | Body | Response | 설명 |
|---|---|---|---|---|---|
| GET | `/api/courses/:id/route` | `course.operate` | — | `{ markers, steps }` | 물리 마커와 방문 순서 조회 |
| POST | `/api/courses/:id/route/markers` | `course.operate` | `{ lat, lng, label? }` | 201 `{ id, course_id, ... }` | 물리 마커 추가(방문 단계는 자동 추가하지 않음, 코스당 최대 200개) |
| PATCH | `/api/route/markers/:id` | `course.operate` | `{ lat?, lng?, label? }` | `{ id, course_id, ... }` | 마커 이동·이름 수정 |
| DELETE | `/api/route/markers/:id` | `course.operate` | — | `{ markers, steps }` | 마커와 그 마커를 참조하는 모든 방문 삭제, position 재정렬 |
| PUT | `/api/courses/:id/route/steps` | `course.operate` | `{ steps: [marker_id, ...] }` | `{ markers, steps }` | 방문 순서 전체 교체(반복 id 허용, 최대 500단계) |

#### 메모 스티커 (지도 주석)

메모는 중심 좌표(lat/lng)와 실측 크기(width/height, m)에 고정되어 지도 줌·회전을 따르며, 코스 삭제 시 CASCADE 삭제됩니다.

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/courses/:id/memos` | `course.operate` | — | `[{ id, course_id, lat, lng, width, height, rotation, content, created_at, updated_at }]` | 코스의 메모 목록 |
| POST | `/api/courses/:id/memos` | `course.operate` | `{ lat, lng, width, height, rotation?, content? }` | 201 `{ id, course_id, lat, lng, width, height, rotation, content, ... }` | 메모 추가 (width/height 단위 m, 0 초과 100000 이하; rotation deg, [0,360) 정규화; content 최대 5000자) |
| PATCH | `/api/memos/:id` | `course.operate` | `{ lat?, lng?, width?, height?, rotation?, content? }` | `{ id, course_id, lat, lng, width, height, rotation, content, updated_at }` | 메모 수정 (이동/크기/회전/내용) |
| DELETE | `/api/memos/:id` | `course.operate` | — | 200 | 메모 삭제 |

### Mission presets and devices (`rover.operate`)

미션 프리셋은 코스 데이터다. 미션 실행 원장은 각 로버의 hub가 소유한다.

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/courses/:id/mission-presets` | `rover.operate` | — | `{ presets:[{ preset_revision, ... }] }` | 순서·중복·종료 동작을 저장한 코스별 프리셋(코스 데이터). 삭제된 콘이 있으면 `stale:true` |
| POST | `/api/courses/:id/mission-presets` | `rover.operate` | `{ name, finish_behavior, items:[{cone_id,lat,lng,alt,side}...] }` | 201 preset | 프리셋 생성. 항목 좌표·방향이 live cone과 다르면 409 `cone_snapshot_mismatch` |
| PUT | `/api/courses/:id/mission-presets/:presetId` | `rover.operate` | 생성 payload + `{ expected_preset_revision }` | preset | last-read revision이 일치할 때만 프리셋 갱신 |
| DELETE | `/api/courses/:id/mission-presets/:presetId` | `rover.operate` | `{ expected_preset_revision }` | 204 | last-read revision이 일치할 때만 프리셋 삭제 |
| GET | `/api/devices` | `rover.operate` | — | `{ devices: [{ id, kind: rover\|gps, label, url }] }` | 콘솔이 tailnet으로 직접 연결할 로버·GPS 유닛 API 주소(`COURSE_DEVICES`) |

### SSE (`/api/events`, `course.operate`)

| Event | Data | Description |
|-------|------|-------------|
| `init` | `{ courses }` | 연결 시 코스 목록 |
| `courses` | `{ type, course?, courseId?, courses }` | 코스 변경 (type: create/rename/direction/delete/import/start_reset/publication) |
| `cones` | `{ type, courseId, cone?, coneId?, cones }` | 콘 변경 (type: add/update/delete/clear/restore) |
| `memos` | `{ type, courseId, memo?, memoId?, memos }` | 메모 변경 (type: add/update/delete) |
| `route` | `{ type, courseId, markers, steps }` | 주행 마커/방문 순서 변경 (type: marker_add/marker_update/marker_delete/steps) |

---

## Calendar Service (port 11000)

대회 일정 관리 서비스. 조회는 공개 대상(`public`, `student`, `official`)에 따라 필터링되며, CUD는 `calendar.manage` 권한이 필요하다.

### Events

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/events` | public | `?timeMin=<ISO>&timeMax=<ISO>` | `[{ id, title, start, end, description, location, allDay, calendarId, role }]` | 기간 내 이벤트 목록 (사용자 role에 따라 필터링) |
| POST | `/api/events` | `calendar.manage` | `{ title, start, end, role?, description?, location?, allDay? }` | 201 `{ id, title, start, end, description, location, allDay, calendarId, role }` | 이벤트 생성 (`role`: `public`, `student`, `official`; 기본값 `official`) |
| PUT | `/api/events/:id` | `calendar.manage` | `{ title, start, end, role?, description?, location?, allDay? }` | `{ id, title, start, end, description, location, allDay, calendarId, role }` | 이벤트 수정 |
| DELETE | `/api/events/:id` | `calendar.manage` | — | 204 | 이벤트 삭제 |

### Subscribe / iCal

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/events/subscribe` | student | — | `{ role, path }` | 사용자 role 기반 서명된 iCal 구독 URL 반환 |
| GET | `/api/events/ical` | public | `?role=<role>&sig=<hmac>` | `text/calendar` (iCalendar RFC 5545) | 서명 검증 후 role 기반 필터링된 iCal 피드 반환 |

- `calendarId`: `role` 필드와 동일한 값 (캘린더 식별자)
- `allDay: true` → `start`/`end`는 `YYYY-MM-DD` 형식
- `allDay: false` → `start`/`end`는 UTC ISO 8601 형식(`...Z`, 예 `2026-07-13T05:00:00.000Z`). 요청 body는 `YYYY-MM-DD HH:mm`(Asia/Seoul 해석) 또는 오프셋/Z 포함 ISO를 받아 UTC로 정규화해 저장·응답한다
- iCal 서명: HMAC-SHA256 (`JWT_SECRET`), PRODID `-//Formula Student Korea//Calendar//KO`
