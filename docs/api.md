# API Reference

This is the maintained HTTP contract. Auth, email, course, and calendar expose their listed `/api/*` routes directly. The seven competition modules run in one Competition process on port 9200. Paths shown inside a Competition module section are relative to that module prefix:

| Module | External prefix |
|---|---|
| Teams (Entry UI) | `/competition/api/v1/teams` |
| Queue | `/competition/api/v1/queue` |
| Registration | `/competition/api/v1/registration` |
| Inspection | `/competition/api/v1/inspection` |
| Traffic | `/competition/api/v1/traffic` |
| Score | `/competition/api/v1/score` |
| Documents | `/competition/api/v1/documents` |

Teams table paths are relative to `/competition/api/v1` because Teams, vehicle types, and meta are flat resources. Other module table paths are relative to their listed module prefix. For example, Queue's `/health` row means `/competition/api/v1/queue/health`. API and SSE clients must use these versioned prefixes. The stable browser UI paths remain `/entry`, `/queue`, `/registration`, `/inspection`, `/traffic`, `/score`, and `/documents`.

Former standalone, nested `/{module}/api/*`, lifecycle, finalize, snapshot, and version routes are not compatibility APIs and return `404`.

Competition years use `Asia/Seoul`. Reads may select any valid year. Team, vehicle-type, and Inspection mutations may select the current or next KST year; Queue, Registration, Traffic, Score, and Documents mutations remain limited to the current KST year. A year outside the applicable write window returns `409 YEAR_READ_ONLY`. There is no draft/finalize state.

Competition process health is separate from module compatibility health:

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/health/live` | public | Process liveness |
| GET | `/health/ready` | public | Shared database readiness |

All mutating endpoints are logged via `shared/logger.mjs`.

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

The permission keys are:

`registration.operate`, `registration.manage`, `queue.operate`, `queue.manage`,
`inspection.operate`, `inspection.manage`, `documents.operate`, `documents.manage`,
`files.access`, `calendar.manage`, `course.operate`, `course.manage`, `rover.operate`,
`traffic.operate`, `traffic.manage`, `score.operate`, and `score.manage`.

Entry, Email/SMS, the system logs, and Account & Access are Admin tools. They have no
grant key, so no Official can be given them; the home page and sidebar list them in a
separate Admin group.

Queue and Inspection are deliberately separate. `queue.manage` implies only
`queue.operate`; `inspection.manage` implies only `inspection.operate`.

### Rate Limiting

- **Auth**: OAuth login/callback — 20 requests/minute per IP
- **Queue**: Public endpoints (`POST /api/state/:num`) — 30 requests/minute per IP
- **Registration**: Public credential lookup (`POST /lookup`) — 60 requests/minute per IP
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
| POST | `/state/:num` | public | `{ phone }` | `{ queue, rank, queues: [{ type, name, rank, total }] }` | Check queue position (rate-limited, phone verification); structured rows use the stable inspection key |
| GET | `/booths/all` | public | — | `{ type: [{ booth_num, active, occupied_by, entered_at, timer_paused_at, timer_paused_ms }] }` | All booth statuses |
| GET | `/booths/:type` | public | — | `[{ booth_num, active, occupied_by, entered_at, timer_paused_at, timer_paused_ms }]` | Booth status for inspection type |

### Inspection Type Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/all` | `queue.operate` | — | `[{ type, name, length, active, ignore_priority, ... }]` | All inspection types (including inactive) |
| GET | `/admin/inspection/:type` | `queue.operate` | — | `[{ num, phone, timestamp, is_reinspection, priority }]` | Queue listing for inspection type (sorted) |
| PATCH | `/admin/inspection/:type` | `queue.manage` | `{ active: bool }` | 200 | Toggle inspection active status |
| PATCH | `/admin/inspection/:type/visibility` | `queue.manage` | `{ hidden: bool }` | 200 | Toggle inspection visibility on register page |
| PUT | `/admin/inspection/:type/ignore` | `queue.manage` | `{ field, value }` | 200 | Set ignore_priority or ignore_reinspection |

### Queue Registration

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| POST | `/admin/register/:type` | `queue.manage` or `kiosk.queue.register` | `{ num, phone }` | 201 | Register team in queue (validates entry, penalty, concurrent rules) |
| POST | `/admin/cancel/:type` | `queue.operate` | `{ num }` | 200 | Cancel registration (applies time penalty) |

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
| GET | `/admin/settings/sms` | `queue.operate` | — | `{ value: bool }` | SMS notification enabled status |
| PATCH | `/admin/settings/sms` | `queue.manage` | `{ value: bool }` | 200 | Toggle SMS notifications |
| GET | `/admin/settings/sms-rank` | `queue.operate` | — | `{ value: int }` | SMS notification rank threshold |
| PATCH | `/admin/settings/sms-rank` | `queue.manage` | `{ value: int }` | 200 | Set SMS rank (1-10) |
| GET | `/admin/settings/cancel-penalty` | `queue.operate` | — | `{ value: int }` | Cancel penalty minutes |
| PATCH | `/admin/settings/cancel-penalty` | `queue.manage` | `{ value: int }` | 200 | Set cancel penalty (0-60 min) |

## Registration module (Competition port 9200)

Registration rows use `competition_team.id` as their only team identity. Number and team labels below are canonical values resolved from that team. `waiting` is the operational state; `done` and `canceled` remain stored with the submitted phone and timestamps as audit history. Rows left in the retired `called` state by an earlier preview build are treated as waiting until they are completed or canceled.

### Public status and lookup

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/events` | public | `?year=` | SSE stream | `init` and `registration`: `{ year, open, waiting }`; `entries`: year-scoped canonical-roster invalidation |
| GET | `/status` | public | `?year=` | `{ year, open, waiting }` | Public queue summary without other teams' call state |
| POST | `/lookup` | public | `{ year, num, phone }` | `{ teamId, number, university, name, status, position, waitingTotal, ... }` | Credentialed active-queue lookup; phone is normalized but never returned |

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

`excluded_types` is a category-level array of vehicle type **names** (from entry's `vehicle_types_<year>`) that must NOT see the category. Exclusions rather than inclusions are stored, so `[]` (the default) means every type sees it and a newly added vehicle type is visible without touching existing categories. Max 50 names; a non-array is rejected with 400. It survives `copy` and JSON export/import, and only categories carry it (other levels always report `[]`).

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

A successful answer or memo change automatically adds the authenticated account's real name to that category's inspector list. Identical no-op saves do not add an inspector, and a real mutation is rejected if the authenticated session has no real name. Inspector names are append-only participation history; there is no manual inspector mutation endpoint. Each answer record exposes `answer_updated_by`, `answer_updated_at`, `memo_updated_by`, and `memo_updated_at`, so answer and memo editors remain independent.

## Traffic module (Competition port 9200)

### SSE

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/events` | `traffic.operate` | — | SSE stream | Real-time record/event-mode + wireless updates. init: `{ recordFiles, eventModes, recordVisibility, wireless: { light, mapping, telemetry, bridge, sessions, qualityFaults, lastEventId } }`. `qualityFaults` contains the latest active automatic-stop reason per event. Wireless event names: `wireless:event`, `wireless:telemetry`, `wireless:light`, `wireless:mapping`, `wireless:bridge`, `wireless:session`, `wireless:command`, `wireless:quality-fault`. A quality-fault payload is `{ fault_id, event_type, run_id, kind, occurred_at, reasons }`; a successful subsequent GREEN emits `{ event_type, cleared: true }`. |

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

### Controller Logs

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/controllers` | `traffic.operate` | — | `[{ timestamp, data }]` | All controller logs (DESC) |
| POST | `/controllers` | `traffic.operate` | `{ timestamp, data }` | 201 | Add controller log |
| DELETE | `/controllers` | `traffic.manage` | — | 200 | Clear all controller logs |

### Event Modes

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/event-modes` | `traffic.operate` | — | `[{ event_type, enabled }]` | Event mode statuses |
| PUT | `/event-modes/:type` | `traffic.manage` | — | `{ event_type, enabled }` | Toggle event mode (broadcasts SSE) |

### Wireless LoRa Timing (one master + ≤6 sensors, single channel)

마스터 노드에 USB로 연결된 브리지 PC가 모든 센서의 raw 이벤트·진단·신호등 상태를 서버로 push한다. 서버가 권위 상태(경기별 세션: arm·선택·신호등·lease)를 보유하고 모든 클라이언트가 SSE로 동일하게 본다. `green = arm`(측정 t0는 출발 센서). 경기 기록은 **서버 기록 엔진**이 64-bit raw tick의 차이를 먼저 계산하고 마지막에 한 번만 ms로 반올림해 저장한다(가속/오토크로스 = 출발→도착, 스키드패드 = lap2+lap4). green은 필수 센서 매핑과 최신 HFXO·동기·skew·캡처/큐 상태가 모두 정상일 때만 허용되며, 진행 중 품질 악화나 비현실적 측정 구간은 fail-closed 처리된다. 제어는 경기별 **독점 lease**(claim/heartbeat/release/takeover)로, lease 보유자면 비-브리지도 가상 경기를 제어하고 물리 신호등은 다운링크(`/command`)로 제어한다. 경기: 가속·스키드패드·오토크로스·내구(`EVENT_TYPES`, 짐카나 제거).

세션 객체: `{ event_type, armed, light_color, green_tick, armed_at, team, event_name, controller, lease_expires_at, updated_at }`.

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| POST | `/wireless/ingest` | `traffic.operate` | `{ events?: [{ node_id, master_tick(str 64-bit), ev_seq, flags?, rssi?, snr?, link_state? }], telemetry?: [{ node_id, rssi?, snr?, offset_us?, skew_ppm?, latency_ms?, link_state?, rx_miss?, beacon_gap?, temp_c10?, batt_mv?, sec_drop?, provisioned?, sync_valid?, skew_valid?, clock_source?, sync_age_ms?, capture_overflow?, event_drop?, queue_depth?, queue_overflow?, usb_ref_valid?, usb_ref_ppm? }] }` (각 ≤200) | `{ stored, deduped, rejected, acknowledged: [{ node_id, ev_seq, master_tick }] }` | 브리지 배치 ingest. `(node_id, ev_seq, master_tick)` 멱등. `acknowledged`는 DB insert 또는 기존 행 dedupe가 확인된 정확한 키만 포함하며, 브리지는 이 키를 USB `C` ACK로 돌려 마스터 RAM 큐를 비운다. 불량 항목은 배치 전체 실패 없이 skip. 상태 악화는 armed 세션을 중단하고 `wireless.quality_fault`를 기록한다. 보안 관측은 `wireless.security` 로그로 남긴다. |
| POST | `/wireless/light` | `traffic.operate` | `{ color: red\|green\|yellow\|off, green_tick?(str) }` | `{ ...light }` | 브리지가 물리 신호등 색 보고. 새 green 보고도 해당 경기 품질 게이트를 통과해야 하며, 거부되면 409이고 브리지는 마스터에 OFF를 보낸다. |
| PUT | `/wireless/physical-event` | `traffic.operate` | `{ event_type: <type>\|null }` | `{ ...light }` | 실제 신호등(SSR)을 사용할 경기 지정(`owner_event`). null=없음(전부 가상). 기본은 모든 경기가 가상, 지정 경기만 실제 제어. `wireless:light` 브로드캐스트 |
| PUT | `/wireless/debounce` | `traffic.manage` | `{ ms: 0~5000 정수 }` | `{ ...light }` | 센서 디바운스 창(ms). 한 통과의 다중 엣지(바운스)를 접는 간격. 기본 300, 0이면 끔. `wireless_light.debounce_ms`에 저장, `wireless:light` 브로드캐스트(모든 화면 공유) |
| GET | `/wireless/mapping` | `traffic.operate` | — | `[{ node_id, event_type, role, label, enabled, updated_at }]` | 센서→경기·역할 매핑 |
| PUT | `/wireless/mapping/:node_id` | `traffic.manage` | `{ event_type, role(start\|finish\|lane1~lane9), label?, enabled? }` | `{ ...row }` | 매핑 upsert (`wireless:mapping` 브로드캐스트). 가속·오토크로스=start+finish, 스키드패드·내구=start(단일 센서 멀티랩). 기록 엔진은 finish만 센서2로 취급, 그 외(start·lane*)는 센서1 |
| DELETE | `/wireless/mapping/:node_id` | `traffic.manage` | — | 200 | 매핑 삭제 |
| GET | `/wireless/state` | `traffic.operate` | — | `{ light, mapping, telemetry, bridge, sessions, qualityFaults, lastEventId }` | 신선 로드용 종합 스냅샷. 각 session은 물리 초기화의 OFF 확인 대기 여부인 `reset_pending`을 포함. `qualityFaults`는 새 GREEN이 품질 검사를 통과할 때까지 유지되는 자동 중단 원인이다. |
| GET | `/wireless/events` | `traffic.operate` | `?since=<id>&limit=<n≤1000>` | `[{ id, node_id, master_tick, ev_seq, server_time, rssi, snr, link_state }]` | 늦게 합류한 클라이언트의 raw 이벤트 백필 |
| POST | `/wireless/arm` | `traffic.operate` | `{ event_type, action: green\|red\|off\|reset, green_tick?(str) }` | `{ ...session }` | 경기 arm/disarm. green은 필수 역할 센서 전부의 최신 link/provisioned/HFXO/sync/skew/beacon/capture/delivery 상태와 마스터 큐가 정상일 때만 허용(아니면 409). lease·reset 규칙은 동일하다. |
| POST | `/wireless/select` | `traffic.operate` | `{ event_type, team?: { id, num, univ, team }\|null, event_name?: string\|null }` | `{ ...session }` | 경기 선택(팀·이벤트명) 공유 — 서버 기록 귀속. 안정적 팀 ID를 현재 활성 팀으로 재확인하며 오래되거나 유효하지 않으면 409, null=해제. lease 점유자만. `wireless:session` 브로드캐스트 |
| POST | `/wireless/status` | `traffic.operate` | `{ event_type, status: DNS\|DNF\|DSQ }` | `{ name, record, session }` | 선택된 팀/이벤트의 현재 시도를 판정한다. arm 단계와 무관하게 가능하며, 부분·완료 기록이 있으면 raw result를 보존한 같은 행을 갱신하고 없으면 untimed status 행을 만든다. lease 점유자만 |
| POST | `/wireless/command` | `traffic.operate` | `{ event_type, action: green\|red\|off\|reset }` | `{ ok, session? }` | 물리 신호등 원격 제어 다운링크. green은 `/wireless/arm`과 같은 품질 게이트를 통과해야 한다. reset은 `reset_pending`을 즉시 브로드캐스트하고 마스터 OFF 보고에서 런 폐기를 확정한다. |
| POST | `/wireless/lease/:event` | `traffic.operate` | — | `{ ...session }` | 경기 독점 제어 lease 획득/갱신(heartbeat). 타인 점유 시 409. 점유자 변경 시만 `wireless:session` 브로드캐스트(heartbeat는 조용히 만료 연장) |
| DELETE | `/wireless/lease/:event` | `traffic.operate` | — | `{ ...session }` | lease 해제(보유자 또는 admin 강제 회수). `wireless:session` 브로드캐스트 |
| GET | `/time` | public | — | `{ now }` | 서버 epoch ms — 클라가 라이브 클럭을 서버 기준으로 동기화(오프셋 추정). 인증 면제 |
| POST | `/wireless/bridge/offline` | `traffic.operate` | — | `{ ...bridge }` | 브리지가 종료 직전 오프라인을 즉시 보고 (15초 무수신 감지 대기 없이) |

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

RTK GPS 기반 코스 콘 위치 관리 + 로버 원격 운용 서비스. 코스/콘 CRUD와 SSE(`/api/events`)는 `course.operate`, 스냅샷·코스 삭제는 `course.manage`, 로버 운용은 `rover.operate` 권한이 필요하다. 로버 기기 인입 엔드포인트는 `X-Internal-Service` 또는 범위가 코스 서비스로 제한된 `X-Rover-Secret`을 검증하며, human 세션으로는 접근할 수 없다.

### Courses (`course.operate`)

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/courses` | `course.operate` | — | `[{ id, name, cone_count, created_at, updated_at }]` | 코스 목록 조회 |
| POST | `/api/courses` | `course.operate` | `{ name }` | 201 `{ id, name, created_at, updated_at }` | 코스 생성 |
| PATCH | `/api/courses/:id` | `course.operate` | `{ name }` | `{ id, name, updated_at }` | 코스 이름 수정 |
| PATCH | `/api/courses/:id/direction` | `course.operate` | `{ reverse?, start_cone_id?: int\|null }` | `{ ...course }` | 코스 진행 방향(reverse)·시작 콘 저장 (요청에 담긴 것만 갱신, start_cone_id null=자동 시작 게이트). 주행 마커가 없는 코스의 폴백 값이며 UI는 시작 콘만 노출한다. `courses` SSE(type=direction) 브로드캐스트 |
| DELETE | `/api/courses/:id` | `course.manage` | — | 200 | 코스 삭제 (콘·스냅샷·주행 마커 CASCADE 삭제). 활성 미션이 사용 중이면 감사 로그를 남기고 `409 { reason:"active_mission_course" }` |
| GET | `/api/courses/:id/export` | `course.operate` | — | `{ name, cones, memos, route_markers, route_steps, ... }` | 코스 JSON 다운로드. `route_steps`는 DB id가 아닌 `route_markers` 배열 인덱스 |
| POST | `/api/courses/import` | `course.operate` | `{ name, cones, memos?, route_markers?, route_steps? }` | 201 `{ id, name, ... }` | JSON으로 코스 일괄 생성 (트랜잭션, 주행 단계의 마커 인덱스를 새 id로 재매핑) |

### Course Snapshots (`course.manage`)

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/courses/:id/snapshots` | `course.manage` | — | `[{ id, taken_at, actor, reason, cone_count }]` | 코스 스냅샷 목록 |
| POST | `/api/courses/:id/snapshots` | `course.manage` | `{ reason? }` | 201 | 현재 콘 상태 스냅샷 저장 |
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

`course/lib/route-mode.mjs`의 `resolveCourseRoute`가 지도·ZIP 내보내기 양쪽에서 계산 방식을 결정한다 (동일 입력 → 동일 결과):

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

메모는 중심 좌표(lat/lng)와 실측 크기(width/height, m)로 저장돼 콘처럼 지리 좌표에 고정된다 — 줌/회전에도 코스 위 같은 자리를 가리키며 줌에 따라 함께 커지고 작아진다. course 삭제 시 CASCADE.

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/courses/:id/memos` | `course.operate` | — | `[{ id, course_id, lat, lng, width, height, rotation, content, created_at, updated_at }]` | 코스의 메모 목록 |
| POST | `/api/courses/:id/memos` | `course.operate` | `{ lat, lng, width, height, rotation?, content? }` | 201 `{ id, course_id, lat, lng, width, height, rotation, content, ... }` | 메모 추가 (width/height 단위 m, 0 초과 100000 이하; rotation deg, [0,360) 정규화; content 최대 5000자) |
| PATCH | `/api/memos/:id` | `course.operate` | `{ lat?, lng?, width?, height?, rotation?, content? }` | `{ id, course_id, lat, lng, width, height, rotation, content, updated_at }` | 메모 수정 (이동/크기/회전/내용) |
| DELETE | `/api/memos/:id` | `course.operate` | — | 200 | 메모 삭제 |

### Rover — 기기 인입 (로버 → 서버)

로버는 SSE(`/api/rover/stream`)로 서버에 연결을 유지하고, 서버 이벤트에 대한 응답과 텔레메트리를 아래 엔드포인트로 POST한다. 라우트 구현은 `course/lib/rover-routes.mjs`.

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/rover/stream` | internal | GPS: `?device=gps`; rover: `?protocol_version=2&boot_id=<uuid>` | SSE stream | 기기 SSE 연결 (INTERNAL_SECRET 필수). v2 boot ID는 서버에 generation으로 영속되므로 A→B 교체 후 A 재접속은 409. 재부팅 경계의 active mission은 persisted `mission-safety-hold { mission_id, plan_hash, hold_id }`를 받고, correlated durable held/interrupted ACK 전까지 재접속마다 재전송한다. `device=gps`는 별도 수신기 슬롯 |
| POST | `/api/rover/mission-report` | internal | `{ protocol_version:2, boot_id, report_seq, mission_id, plan_hash, event, command_id?, command_seq?, command_result?, waypoint_id?, active_waypoint_id?, completed_waypoint_ids?, motion_state?, hold_id?, checkpoint_persisted? }` | `{ ok, duplicate?, reset_mission?, mission? }` | boot·순번·미션·계획에 결합된 미션 보고. `report_seq` high-water와 보고 적용은 SQLite 트랜잭션 하나로 저장되어 서버 재시작 뒤에도 동일 boot replay를 거부한다. 모든 checkpoint report의 `completed_waypoint_ids`를 검증/재현한다. reboot hold는 `held\|interrupted` + 동일 `hold_id` + `checkpoint_persisted:true`일 때만 해제된다. terminal 보고의 동일 순번 재전송도 `reset_mission:true`를 반환한다. stale boot/hash/waypoint는 409 |
| POST | `/api/rover/position` | internal | rover: `{ boot_id, lat, lng, alt?, request_id? }`; GPS: `{ lat, lng, alt?, request_id? }` `?device=gps\|rover` | `{ lat, lng, alt }` | v2 rover 위치는 현재 SSE boot와 일치할 때만 liveness·거리 gate·pending request를 갱신한다. GPS receiver는 별도 세션 계약 |
| POST | `/api/rover/telemetry` | internal | rover: `{ boot_id, fix_status, nav_state, ntrip_*, gps, ... }`; GPS: 기존 payload `?device=gps\|rover` | 200 | v2 rover 텔레메트리는 현재 SSE boot에만 결합된다. current boot의 authoritative `EMERGENCY_STOP`만 active v2 mission을 confirmed-held/interrupted로 조정한다. 수신기(`device=gps`)는 receiverState 갱신 |
| POST | `/api/rover/waypoint_reached` | internal | `{ index }` | 200 | 웨이포인트 도달 보고 (미션 진행 영속 + `rover:waypoint` 브로드캐스트) |
| POST | `/api/rover/waypoint_skipped` | internal | `{ index }` | 200 | stuck 웨이포인트 건너뜀 보고 (`rover:skipped` 브로드캐스트) |
| POST | `/api/rover/spray_result` | internal | `{ waypoint, outcome: success\|cancelled\|timeout }` | 200 | 도색 결과 보고 (미션에 영속 + `rover:spray` 브로드캐스트) |
| POST | `/api/rover/obstacle` | internal | `{ ... }` | 200 | 장애물 감지 보고 (`rover:obstacle` 브로드캐스트) |
| POST | `/api/rover/logs` | internal | `{ entries: [...] }` | 200 | 로버 로그 업로드 (서버 메모리 캐시, 최대 1000줄) |
| POST | `/api/rover/antenna_calibration_result` | internal | `{ ... }` | 200 | 안테나 캘리브레이션 결과 보고 |
| POST | `/api/rover/wheel_calibration_result` | internal | `{ ... }` | 200 | 휠 캘리브레이션 결과 보고 |
| POST | `/api/rover/calibration-progress` | internal | `{ ... }` | 200 | 스테레오 캘리브레이션 진행률 보고 |
| POST | `/api/rover/base/survey-result` | internal | `{ point_id, lat, lng, alt, h_acc, samples }` | 200 | 수신기(base station)가 측량 결과 보고 → survey_point 갱신 |
| POST | `/api/rover/base/rtcm` | internal | `{ data: base64 }` | 200 | 수신기(base station)가 RTCM3 청크 전송 → 로버로 릴레이(SSE `rtcm`). 로버 미연결이면 드롭 |
| POST | `/api/rover/camera` | internal | `image/jpeg` (≤3MB) | 200 | 카메라 프레임 push (서버가 뷰어에 MJPEG 릴레이). WebRTC가 기본 경로이므로 이건 **폴백** — MJPEG 뷰어가 있을 때만(`mjpeg-on`) 로버가 POST |
| GET | `/api/rover/camera/control` | internal | — | SSE stream | perception 컨테이너의 카메라 제어 채널. 서버가 캡처/스트림 제어 이벤트를 전송: `camera-start`/`camera-stop`, `mjpeg-on`/`mjpeg-off`, `webrtc-2d-on`/`webrtc-2d-off`, `webrtc-vr-on`/`webrtc-vr-off`, `depth-on`/`depth-off`. 각 스트림은 해당 뷰어가 있을 때만 인코딩 |

### Rover — 운용 (관리자 → 서버 → 로버)

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/rover/status` | `rover.operate` | — | `{ connected, nav_state, active_mission, mission_protocol, last_position, ... }` | 로버 종합 상태. `active_mission`은 안정적 waypoint occurrence ID·상태·plan hash를 포함하고 `mission_protocol`은 요구/연결 버전과 boot ID를 표시 |
| POST | `/api/rover/request` | `rover.operate` | — | `{ lat, lng }` | 로버에 위치 요청 후 응답 대기 (5초 타임아웃). 503=미연결, 504=타임아웃 |
| POST | `/api/rover/stop` | `rover.operate` | — | `{ stopped: true }` | 비상정지 (SSE `emergency-stop` 이벤트) |
| POST | `/api/rover/clear-emergency` | `rover.operate` | — | `{ cleared: true }` | 비상정지 해제. 미션은 자동 종료되지 않고 보존되어 "이어서 실행" 가능 |
| POST | `/api/rover/control` | `rover.operate` | `{ throttle, steering }` | `{ throttle, steering }` | 수동 제어 (-100~100). v2 활성 미션은 로버가 실제 held를 보고한 경우(`motion_confirmed_held:true`)에만 non-zero 명령을 허용한다. 단순 SSE/telemetry 중단처럼 자율 주행이 계속될 수 있는 interruption은 409; 정지 명령(0/0)은 항상 전달 가능 |
| POST | `/api/rover/pump` | `rover.operate` | `{ on }` | `{ on }` | 페리스탈릭 펌프 수동 on/off 토글 |
| POST | `/api/rover/pump-duration` | `rover.operate` | `{ seconds }` (0~10) | `{ ok }` | 펌프 분사 시간(초) 설정. 로버 재연결 시 재전송 |
| POST | `/api/rover/nav-lights` | `rover.operate` | `{ ... }` | 200 | 항법등 제어 |
| POST | `/api/rover/led-brightness` | `rover.operate` | `{ ... }` | 200 | LED 밝기 제어 |
| POST | `/api/rover/calibrate-battery` | `rover.operate` | `{ measured_v }` (15~32 V) | `{ ok, measured_v }` | 멀티미터 실측값으로 배터리 ADC 게인 1점 보정. 로버가 영구 저장 |
| POST | `/api/rover/calibrate-stereo` | `rover.operate` | — | 200 | 스테레오 카메라 캘리브레이션 시작 |
| POST | `/api/rover/calibrate-ground` | `rover.operate` | `{ frames? }` (10~120, 기본 30) | `{ ok }` | 지면 교정 시작(above-ground 검출기 행별 기대 지면 깊이 곡선). 스테레오 교정 선행 필요, perception 미연결 시 503 |
| POST | `/api/rover/calibrate-antenna` | `rover.operate` | — | 200 | GPS 안테나 오프셋 캘리브레이션 시작 |
| POST | `/api/rover/set-antenna-offset` | `rover.operate` | `{ ... }` | 200 | 안테나 오프셋 수동 설정 |
| POST | `/api/rover/calibrate-wheels` | `rover.operate` | — | 200 | 휠 캘리브레이션 시작 |
| POST | `/api/rover/reset-wheel-cal` | `rover.operate` | — | 200 | 휠 캘리브레이션 초기화 |
| GET | `/api/rover/logs` | `rover.operate` | — | `{ entries, uploaded_at }` | 업로드된 로버 로그 조회 |
| POST | `/api/rover/logs/fetch` | `rover.operate` | — | 200 | 로버에 로그 업로드 요청 (SSE 이벤트) |
| GET | `/api/rover/camera/stream` | `rover.operate` | — | MJPEG stream | 카메라 MJPEG 스트림 (최대 8 뷰어, ≤~25fps 릴레이). WebRTC(WHEP) 실패/드롭 시의 **폴백** — 뷰어가 붙으면 서버가 `mjpeg-on`을 로버에 전달 |
| GET | `/api/rover/camera/hold` | `rover.operate` | `?mode=2d\|vr` | SSE stream | WebRTC **게이팅 전용** 뷰어. MJPEG 프레임은 안 받고, 로버가 캡처 + 해당 WebRTC 스트림(`mode=2d`→`rover-2d`, `mode=vr`→`rover-vr`)을 publish하도록 유지. 2D 패널/VR 뷰가 세션 동안 열어둠 |
| POST | `/api/rover/camera/depth` | `rover.operate` | `{ on }` | `{ ok, depth, camera_connected }` | 양안 깊이 컴포지트(정류 좌안 + 깊이 히트맵 + 최근접 거리, 로버가 렌더) 토글. 2D 뷰어(MJPEG `cameraViewers` **또는** WebRTC `holdViewers2d`)가 있어야 적용 — 뷰어 없으면 무시. 마지막 2D 뷰어 이탈 시 자동 해제 |
| POST | `/api/rover/camera/detection` | `rover.operate` | `{ on }` | `{ ok, detection, camera_connected }` | 근접(장애물) 감지 토글. depth와 달리 뷰어 게이트 없이 NAVIGATING 중 항상 적용되는 미션 안전 설정. roverState에 저장(`rover:status` 반영)되고 perception 재연결마다 재전송. 로버 env `OBSTACLE_DETECTION`이 하드 킬스위치, 이건 운영자 소프트 on/off |
| GET | `/api/rover/camera/status` | `rover.operate` | — | `{ camera_connected, viewers, depth, last_frame_age_ms }` | 카메라 릴레이 상태. `camera_connected`=perception 제어 SSE 연결됨, `viewers`=MJPEG 뷰어 수, `depth`=컴포지트 모드, `last_frame_age_ms`=서버 계산 프레임 경과(뷰어 없으면 null) |
| GET | `/api/rover/map-tile` | `rover.operate` | `?z=&x=&y=` | image (jpeg/png) | VR 미니맵용 위성 타일 **동일 출처 프록시**. WebGL 캔버스가 교차 출처 타일로 오염되지 않도록 VWorld(서버측 `VWORLD_KEY`)·구글 타일을 서버가 대신 가져와 전달. z/x/y는 slippy-map(XYZ) 인덱스, 범위 밖이면 400 |

미션 v2 로버가 연결됐거나 v2 활성 미션이 있으면 레거시 `/api/rover/execute`, `/pause`, `/resume`, `/end-mission`은 410을 반환한다. 새 운용 UI는 아래 Missions API만 사용한다.

### GPS — 수신기 소스 선택 + base station 측량점

콘 좌표 캡처는 GPS 수신기(연결 시)를 우선, 없으면 로버를 사용한다. 로버의 RTK 보정 소스는
NGII(공용 NTRIP)와 **수신기 base station**(측량점에 고정한 수신기가 RTCM3 생성 → 서버 릴레이 →
로버) 중 선택한다. 수신기의 "캡처 소스"·"base station" 역할은 상호배타. `rover.operate` 전용. 구현은
`course/lib/rover-routes.mjs`, 테이블은 `course/index.mjs`(`gps_config`, `survey_point`).

| Method | Path | 인증 | Body | 응답 | 설명 |
|--------|------|------|------|------|------|
| GET | `/api/gps/config` | `rover.operate` | — | `{ ntrip_source, active_base_point_id }` | 현재 GPS 소스 설정 |
| PUT | `/api/gps/config` | `rover.operate` | `{ ntrip_source: ngii\|base, active_base_point_id? }` | config | 소스 변경. base면 측량 완료된 점 필수. 수신기에 `base-activate`/`base-stop`, 로버에 `ntrip-source` 즉시 전송 |
| GET | `/api/gps/survey-points` | `rover.operate` | — | `{ points: [...] }` | 측량점 목록 |
| POST | `/api/gps/survey-points` | `rover.operate` | `{ name }` | point | 측량점 추가(이름만, 좌표 미측량) |
| DELETE | `/api/gps/survey-points/:id` | `rover.operate` | — | 200 | 삭제. 활성 base면 409 |
| POST | `/api/gps/survey-points/:id/survey` | `rover.operate` | `{ duration_s? }` | `{ ok, duration_s }` | 수신기 측량 시작(NGII rtk_fixed 위치 평균). 미연결 503, base 모드면 409 |
| POST | `/api/gps/survey-points/:id/survey/cancel` | `rover.operate` | — | 200 | 측량 취소 |

기기 방향 이벤트(서버 → 기기, 위 `/api/rover/stream`으로 전달): 수신기 `base-survey-start`/
`base-survey-cancel`/`base-activate`/`base-stop`, 로버 `rtcm`(base64)·`ntrip-source`(`ngii\|base`).

### Rover 카메라 — WebRTC 시그널링 (mediamtx, WHIP/WHEP)

저지연 카메라(H.264)는 별도 `mediamtx` 릴레이를 통한 WebRTC로 전달된다. caddy가 `/course/api/rtc/*`를 `mediamtx:8889`로 리버스 프록시하며(`landing/Caddyfile`), 시그널링 SDP만 HTTP로 타고 미디어는 별도 UDP/SRTP다. mediamtx는 permit-all + ClusterIP 전용(외부에서 직접 접근 불가)이라 **caddy의 게이트가 곧 접근 제어**다 — 시그널링 교환 없이는 SRTP 키를 세울 수 없어 미디어 포트만으로는 무용하다:

- **WHIP(로버 publish)**: caddy가 `X-Internal-Service` = `INTERNAL_SECRET`를 요구(없으면 403). 로버가 이 헤더를 실어 발행.
- **WHEP(브라우저 play)**: caddy `forward_auth`로 **`rover.operate` 권한**을 요구한다(미인증은 401, 미승인은 403).

mediamtx는 프로덕션 k3s(GitOps)에만 배포되며 `compose.yml`에는 없다 — 로컬 compose 스택에선 WebRTC가 동작하지 않고 MJPEG 폴백만 쓰인다.

| 방향 | 경로 | 인증 | 스트림 | 설명 |
|------|------|------|--------|------|
| 로버 publish (WHIP) | `POST /course/api/rtc/rover-2d/whip` | X-Internal-Service | rover-2d | 모노 / 깊이 컴포지트 (2D 패널). aiortc가 발행 |
| 로버 publish (WHIP) | `POST /course/api/rtc/rover-vr/whip` | X-Internal-Service | rover-vr | 정류 좌·우 side-by-side 스테레오 (VR 뷰) |
| 브라우저 play (WHEP) | `POST /course/api/rtc/rover-2d/whep` | `rover.operate` | rover-2d | 2D 운영 패널이 재생 |
| 브라우저 play (WHEP) | `POST /course/api/rtc/rover-vr/whep` | `rover.operate` | rover-vr | WebXR VR 뷰가 재생 (눈별 분할) |

로버는 `SERVER_URL`로 WHIP URL을 구성하고, publish 게이팅은 `/api/rover/camera/hold`(위 표)가 담당한다. 프론트는 `course/web/src/composables/useWhepStream.js`(2D)·`course/web/src/views/VrView.vue`(VR)에서 WHEP로 재생하며, WebRTC가 기본이고 MJPEG(`/api/rover/camera/stream`)은 폴백이다.

### Missions (`rover.operate`)

`mission.status`는 `ready → starting → running → pausing/paused 또는 interrupted → resuming → running → completed` 상태 기계다. `cancelled`도 종결 상태다. `plan_hash`는 종료 동작과 occurrence 순서를 묶고 start/resume 발행 시점에 `expected_plan_hash`로 CAS한다. `occurrence_revision`은 웨이포인트 진행 상태를 포함하며 남은 경로 편집과 start/resume 모두 `expected_occurrence_revision`까지 비교한다. `motion_confirmed_held`는 서버가 추정한 interruption과 로버가 확인한 실제 정지를 구분한다. end는 reboot safety hold 중에도 허용되지만 accepted+held ACK 전까지 미션을 active로 유지해 후속 미션과 수동 주행을 차단한다. 빈 return-only 경로는 영구 저장된 `start_position`이 있을 때만 편집·실행할 수 있다. 한 미션은 완료 항목을 포함해 최대 1,000 occurrence이며 코스별 프리셋은 최대 20개다.

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/missions/active` | `rover.operate` | — | `{ mission }` | 유일한 비종결 미션. 없으면 null |
| POST | `/api/missions` | `rover.operate` | `{ course_id, preset_id?, finish_behavior: stop\|return_to_start, items: [{cone_id,lat,lng,alt,side}...] }` | 201 mission | 서버 권위 미션 생성. 각 좌표/방향은 운영자가 마지막으로 확인한 값의 value-CAS이며 live cone과 다르면 409. 같은 cone ID를 여러 번 넣으면 서로 다른 occurrence ID로 보존 |
| PUT | `/api/missions/:id/remaining` | `rover.operate` | `{ expected_plan_hash, expected_occurrence_revision, finish_behavior, items: [{waypoint_id}\|{cone_id}...] }` | mission | `motion_confirmed_held:true`인 미션에서만 남은 경로 교체. 일반 stop 경로는 empty를 거부하고, 모든 pending이 `dispense_outcome_uncertain`이거나 return-only인 경우만 명시적 empty mode를 저장 |
| POST | `/api/missions/:id/start` | `rover.operate` | `{ expected_plan_hash, expected_occurrence_revision, force? }` | 202 `{ command_id, command_seq, delivered, replay, mission }` | ready 미션 시작 명령 |
| POST | `/api/missions/:id/pause` | `rover.operate` | — | 202 command envelope | running 미션 정지 명령. 수락 후 paused |
| POST | `/api/missions/:id/resume` | `rover.operate` | `{ expected_plan_hash, expected_occurrence_revision, force? }` | 202 command envelope | paused/interrupted 미션의 pending occurrence만 재개. 완료 항목은 전송하지 않음 |
| POST | `/api/missions/:id/end` | `rover.operate` | — | 202 command envelope | accepted+held ACK 후에만 cancelled. ACK 전에는 active/motion-unconfirmed fence를 유지 |
| GET | `/api/rover/mission-presets` | `rover.operate` | `?course_id=` | `{ presets:[{ preset_revision, ... }] }` | 순서·중복·종료 동작을 저장한 코스별 프리셋. 삭제된 콘이 있으면 `stale:true` |
| POST | `/api/rover/mission-presets` | `rover.operate` | `{ course_id, name, finish_behavior, items:[{cone_id}...] }` | 201 preset | 프리셋 생성 |
| PUT | `/api/rover/mission-presets/:id` | `rover.operate` | 생성 payload + `{ expected_preset_revision }` | preset | last-read revision이 일치할 때만 프리셋 갱신 |
| DELETE | `/api/rover/mission-presets/:id` | `rover.operate` | `{ expected_preset_revision }` | 204 | last-read revision이 일치할 때만 프리셋 삭제 |
| GET | `/api/missions` | `rover.operate` | `?limit=(≤500, 기본 50)&offset=` | `{ missions, total }` | 미션 이력 목록 |
| GET | `/api/missions/:id` | `rover.operate` | — | v2: `{ ...mission, waypoints, events }`; legacy: 기존 좌표 배열 | 미션 상세와 모든 lifecycle/command/route-edit 감사 이벤트 |
| GET | `/api/missions/:id/telemetry` | `rover.operate` | — | `{ samples: [...] }` | 미션 텔레메트리 전체 (대용량 가능 — 페이지네이션 미지원, 후속 과제) |

### SSE (`/api/events`, `course.operate`)

| Event | Data | Description |
|-------|------|-------------|
| `init` | `{ courses }` | 연결 시 코스 목록 |
| `courses` | `{ type, course?, courseId?, courses }` | 코스 변경 (type: create/rename/direction/delete/import/start_reset) |
| `cones` | `{ type, courseId, cone?, coneId?, cones }` | 콘 변경 (type: add/update/delete/clear/restore) |
| `memos` | `{ type, courseId, memo?, memoId?, memos }` | 메모 변경 (type: add/update/delete) |
| `route` | `{ type, courseId, markers, steps }` | 주행 마커/방문 순서 변경 (type: marker_add/marker_update/marker_delete/steps) |
| `rover` | `{ lat, lng, alt, source }` | 활성 소스 위치 수신 시 브로드캐스트 (source: rover\|receiver) |
| `rover:status` | roverState + `{ active_mission_summary, mission_protocol, receiver, position_source, ntrip_source }` | GPS-rate bounded 상태. `active_mission_summary`는 ID/status/hold/hash/revision 등 권한 판단 필드만 포함하고 waypoint 배열은 포함하지 않음 |
| `rover:mission` | `{ mission }` | command acknowledgement, checkpoint reconcile, waypoint 결과, 정지/완료 직후 v2 미션 전체 상태 |
| `rover:waypoint` / `rover:skipped` / `rover:spray` / `rover:obstacle` | `{ index }` / `{ waypoint, outcome }` / `{ nearest_m, paused }` 등 | 미션 진행 이벤트 |
| `rover:logs` | `{ count, uploaded_at }` | 로버 로그 업로드 완료 |
| `rover:antenna_calibration` | 캘리브레이션 결과 객체 | 안테나 오프셋 캘리브레이션 결과 |
| `gps:survey_result` | `{ point_id, name, ok, samples? }` | base station 측량 결과 |

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
