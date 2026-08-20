# API Reference

This is the maintained HTTP contract. Auth, email, course, and calendar expose their listed `/api/*` routes directly. The six competition modules run in one Competition process on port 9200. Paths shown inside a Competition module section are relative to that module prefix:

| Module | External prefix |
|---|---|
| Teams (Entry UI) | `/competition/api/v1/teams` |
| Queue | `/competition/api/v1/queue` |
| Inspection | `/competition/api/v1/inspection` |
| Traffic | `/competition/api/v1/traffic` |
| Score | `/competition/api/v1/score` |
| Documents | `/competition/api/v1/documents` |

Teams table paths are relative to `/competition/api/v1` because Teams, vehicle types, and meta are flat resources. Other module table paths are relative to their listed module prefix. For example, Queue's `/health` row means `/competition/api/v1/queue/health`. API and SSE clients must use these versioned prefixes. The stable browser UI paths remain `/entry`, `/queue`, `/inspection`, `/traffic`, `/score`, and `/documents`.

Former standalone, nested `/{module}/api/*`, lifecycle, finalize, snapshot, and version routes are not compatibility APIs and return `404`.

Competition years use `Asia/Seoul`. Reads may select any valid year. Every Teams, Queue, Inspection, Traffic, Score, and Documents mutation is allowed only for the current KST year; a different year returns `409 YEAR_READ_ONLY`. There is no draft/finalize state.

Competition process health is separate from module compatibility health:

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/health/live` | public | Process liveness |
| GET | `/health/ready` | public | Shared database readiness |

All mutating endpoints are logged via `shared/logger.mjs`.

## Common Infrastructure

### Authentication

- **JWT cookie**: `fsk_session` cookie containing HMAC-SHA256 signed JWT with `{ email, name, role }`
- **Internal service**: `X-Internal-Service` header matching `INTERNAL_SECRET` env var — auto-authenticated as admin
- **Forward auth**: `X-Forward-Auth-Key` header matching `INTERNAL_SECRET` — used by Caddy `forward_auth` for FileBrowser

### Role Hierarchy

`public < student < official < chief < admin`

Levels: `{ student: 1, official: 2, chief: 3, admin: 4 }`. Higher roles can access lower-level resources.

### Rate Limiting

- **Auth**: OAuth login/callback — 20 requests/minute per IP
- **Queue**: Public endpoints (`POST /api/state/:num`) — 30 requests/minute per IP

### Common module endpoints

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/health` | public | Module health check, returns `"ok"` |
| GET | `/logs` | admin | Module-scoped structured logs from the shared Competition DB |

---

## Auth Service (port 9100)

### OAuth & Session

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/login` | public | `?redirect=<path>` | 302 → Google OAuth | Initiates Google OAuth flow with CSRF nonce |
| GET | `/api/callback` | public | `?code=<code>&state=<state>` | 302 → redirect URL | OAuth callback; exchanges code for token, sets JWT cookies |
| POST | `/api/logout` | public* | — | 200 | Clears session cookies (*requires valid session) |
| GET | `/api/session` | public | — | `{ name, role }` or 401 | Validates current JWT session |
| GET | `/api/forward-auth` | internal | `?role=<role>`, `X-Forward-Auth-Key` header | 200 + `X-Forwarded-User` header, or 401/403 | Caddy forward_auth for FileBrowser; timing-safe key comparison |

### User Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/users` | admin | — | `[{ id, email, name, role, realname, phone, affiliation, active, created_at, protected }]` | List all users |
| POST | `/api/users` | admin | `{ email, role }` | `{ id, email, role }` | Create user |
| POST | `/api/users/bulk` | admin | `{ users: [{ email, role, realname, phone, affiliation }] }` | `{ added, skipped, errors }` | Bulk create users (INSERT OR IGNORE, 기본 역할 student) |
| PATCH | `/api/users/bulk` | admin | `{ ids: [int], active: bool }` | `{ updated }` | Bulk activate/deactivate users |
| DELETE | `/api/users/bulk` | admin | `{ ids: [int] }` | `{ deleted }` | Bulk delete users (protects last admin) |
| PATCH | `/api/users/:id` | admin | `{ role?, realname?, phone?, active? }` | 200 | Update user role/realname/phone/active status |
| DELETE | `/api/users/:id` | admin | — | 200 | Delete single user (protects last admin, ADMIN_EMAIL) |

### Internal User Lookup

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/users/exists/:email` | admin | — | 200 or 404 | Check if user exists and is active (internal service use) |
| GET | `/api/users/role/:email` | admin | — | `{ role }` or 404 | Get user role (internal service use, sliding renewal) |

### Operations Contacts

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/ops-contacts` | official | — | `[{ id, email, name, realname, phone, description, sort_order }]` | List users displayed in sidebar, ordered by `sort_order` |
| POST | `/api/ops-contacts` | admin | `{ user_id }` | 201 | Add user to sidebar display (official+ only) |
| POST | `/api/ops-contacts/reorder` | admin | `{ user_ids: [...] }` | 200 | Replace the display order; every active displayed contact must be included exactly once |
| PATCH | `/api/ops-contacts/:userId` | admin | `{ description }` | `{ description }` | Update the short description shown after the contact name (max 30 characters) |
| DELETE | `/api/ops-contacts/:userId` | admin | — | 200 | Remove user from sidebar display |

### Account Applications (계정 신청)

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/apply/config` | public | — | `{ open: bool }` | 신청 접수 가능 여부 |
| GET | `/api/apply/me` | public | — | `{ registered: true, email, name }`(로그인됨) 또는 `{ registered: false, email, name, application, applicationsOpen }`(신청자) 또는 401 | 내 세션/신청 상태 (`fsk_applicant` 쿠키 또는 세션 검증) |
| POST | `/api/apply` | public | `{ realname, phone, affiliation }` | 201 | 계정 신청 접수 (`fsk_applicant` 쿠키 검증, 세 필드 모두 필수, 접수 열림 필요) |
| PATCH | `/api/apply` | public | `{ realname, phone, affiliation }` | 200 | 신청 내용 수정 (`fsk_applicant` 쿠키 검증, 세 필드 모두 필수, 접수 닫혀도 허용) |
| GET | `/api/applications` | admin | — | `[{ id, email, name, realname, phone, affiliation, ... }]` | 신청 목록 |
| PATCH | `/api/applications/config` | admin | `{ open: bool }` | 200 | 신청 접수 열기/닫기 |
| POST | `/api/applications/approve` | admin | `{ ids: [int], role }` | 200 | 신청 승인 → users로 이동, 알림 발송 |
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
| GET | `/meta` | public | — | `{ currentYear, years }` | KST current year and readable stored years |
| GET | `/teams` | public / admin | `?year=&includeInactive=true` | `[{ id, year, number, university, name, vehicleTypeId, vehicleType, active }]` | Public reads active teams; admin may include inactive teams |
| GET | `/teams/:id` | admin | — | Team | Read one team by stable ID |
| GET | `/teams/export` | admin | `?year=` | `{ year, teams }` download | Export a readable year; vehicle types are represented by name on each team |
| POST | `/teams/import` | admin | `{ teams }?year=` | `201 [Team]` | Initial import; current year only and only while it has no teams; referenced type names must already exist |
| POST | `/teams` | admin | `{ number, university, name, vehicleTypeId? }?year=` | `201 Team` | Create a current-year team with a stable ID |
| PATCH | `/teams/:id` | admin | `{ number?, university?, name?, vehicleTypeId?, active? }` | Team | Update projections or deactivate without changing the stable ID |

There is no team delete or roster replacement endpoint. Deactivation preserves historical rows and clears only transient operational state.

### Vehicle Types

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/vehicle-types` | public | `?year=` | `[{ id, year, name, sortOrder, color }]` | List yearly vehicle types |
| POST | `/vehicle-types` | admin | `{ name, color?, sortOrder? }?year=` | Vehicle type | Create a current-year vehicle type |
| PATCH | `/vehicle-types/:id` | admin | `{ name?, color?, sortOrder? }` | Vehicle type | Update type and affected team projections transactionally |
| DELETE | `/vehicle-types/:id` | admin | — | 204 | Delete an unused current-year vehicle type |

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
| POST | `/state/:num` | public | `{ phone }` | `{ queue, rank }` | Check queue position (rate-limited, phone verification) |
| GET | `/booths/all` | public | — | `{ type: [{ booth_num, active, occupied_by, entered_at }] }` | All booth statuses |
| GET | `/booths/:type` | public | — | `[{ booth_num, active, occupied_by, entered_at }]` | Booth status for inspection type |

### Inspection Type Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/all` | official | — | `[{ type, name, length, active, ignore_priority, ... }]` | All inspection types (including inactive) |
| GET | `/admin/inspection/:type` | official | — | `[{ num, phone, timestamp, is_reinspection, priority }]` | Queue listing for inspection type (sorted) |
| PATCH | `/admin/inspection/:type` | chief | `{ active: bool }` | 200 | Toggle inspection active status |
| PATCH | `/admin/inspection/:type/visibility` | chief | `{ hidden: bool }` | 200 | Toggle inspection visibility on register page |
| PUT | `/admin/inspection/:type/ignore` | chief | `{ field, value }` | 200 | Set ignore_priority or ignore_reinspection |

### Queue Registration

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| POST | `/admin/register/:type` | chief | `{ num, phone }` | 201 | Register team in queue (validates entry, penalty, concurrent rules) |
| POST | `/admin/cancel/:type` | official | `{ num }` | 200 | Cancel registration (applies time penalty) |

### Active Cancel Penalties

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/penalties` | official | — | `[{ num, inspection, inspection_name, until, can_restore }]` | List active cancel penalties for the current year |
| DELETE | `/admin/penalties/:type/:num` | official | — | 200 | Clear an active cancel penalty |
| POST | `/admin/penalties/:type/:num/restore` | official | — | 200 | Clear a penalty and restore the canceled queue entry at its original timestamp |

### Priority Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/priority/:type` | chief | — | `[{ num, inspection, priority }]` | List priorities for inspection type |
| POST | `/admin/priority/:type` | chief | `{ num, priority }` | 201 | Set/update team priority |
| DELETE | `/admin/priority/:type` | chief | `{ num }` | 200 | Remove team priority |
| DELETE | `/admin/priority/:type/all` | chief | — | 200 | Clear all priorities for inspection type |

### History

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/history/status` | chief | — | `{ type: [num, ...] }` | 검차별 재검 이력 보유 팀 목록 (현재 연도) |
| DELETE | `/admin/history/:type` | chief | — | 200 | Clear inspection history + booth occupancy for type |

### Booth Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/booths/:type` | official | — | `[{ booth_num, active, occupied_by, entered_at }]` | Booth list for type |
| PATCH | `/admin/booths/:type/config` | chief | `{ count }` | 200 | Change booth count (1-100) |
| PATCH | `/admin/booths/:type/:boothNum` | official | `{ active: bool }` | 200 | Toggle booth active/inactive |
| POST | `/admin/booths/:type/:boothNum/enter` | official | `{ num }` | 200 | Move team from queue to booth |
| POST | `/admin/booths/:type/:boothNum/exit` | official | — | 200 | Complete inspection, record history |

### Statistics

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/stats/timerange` | official | `?year=` | `{ from, to }` | Log time range for year |
| GET | `/admin/stats` | official | `?from=&to=&inspection=` | `[{ num, registrations, cancellations, entries, totalOccupyTime }]` | All teams stats |
| GET | `/admin/stats/:num` | official | `?from=&to=&inspection=` | `{ summary, timeline }` | Single team stats with event timeline |

### Settings

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/settings/sms` | official | — | `{ value: bool }` | SMS notification enabled status |
| PATCH | `/admin/settings/sms` | chief | `{ value: bool }` | 200 | Toggle SMS notifications |
| GET | `/admin/settings/sms-rank` | official | — | `{ value: int }` | SMS notification rank threshold |
| PATCH | `/admin/settings/sms-rank` | chief | `{ value: int }` | 200 | Set SMS rank (1-10) |
| GET | `/admin/settings/cancel-penalty` | official | — | `{ value: int }` | Cancel penalty minutes |
| PATCH | `/admin/settings/cancel-penalty` | chief | `{ value: int }` | 200 | Set cancel penalty (0-60 min) |

## Inspection module (Competition port 9200)

### SSE

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/sheet/events` | official | — | SSE stream | Real-time answer/memo/result/inspector updates |

### Template Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/sheet/template` | official | `?year=` | Tree: `[{ id, name, excluded_types, subcategories: [{ groups: [{ items }] }] }]` | Template tree for year |
| POST | `/sheet/template` | chief | `{ year, level, parent_id?, name, sort_order?, answer_type?, remarks?, unit?, pdf_include?, excluded_types? }` | `{ id }` | Create template node |
| PUT | `/sheet/template/:id` | chief | `{ name?, sort_order?, answer_type?, remarks?, unit?, pdf_include?, excluded_types? }` | 200 | Update template node |
| DELETE | `/sheet/template/:id` | chief | — | 200 | Delete template node (CASCADE, blocks past years) |
| POST | `/sheet/template/reorder` | chief | `{ items: [{ id, sort_order }] }` | 200 | Reorder sibling nodes |
| POST | `/sheet/template/copy` | chief | `{ from_year, to_year }` | 201 | Copy template across years |
| POST | `/sheet/template/import` | chief | `{ year, template: [...] }` | 201 | Import template from JSON |

`excluded_types` is a category-level array of vehicle type **names** (from entry's `vehicle_types_<year>`) that must NOT see the category. Exclusions rather than inclusions are stored, so `[]` (the default) means every type sees it and a newly added vehicle type is visible without touching existing categories. Max 50 names; a non-array is rejected with 400. It survives `copy` and JSON export/import, and only categories carry it (other levels always report `[]`).

### Sheet Data

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/sheet/summary` | official | `?year=` | `{ categories: [{ id, name, excluded_types }], teams }` | All teams' category-level results and inspectors |
| GET | `/sheet/bulk-answers` | official | `?year=&item_ids=1,2,3` | `{ team_num: { item_id: value } }` | Bulk answer values for specific items |
| GET | `/sheet/data/:year/:num` | official | — | `{ answers, results, inspectors }` | Full sheet data, including stored values and update metadata |
| PUT | `/sheet/answer` | official | `{ year, team_num, item_id, value, expectedValue }` | `{ value, updated_at, updated_by }` | Save only if the stored answer still equals the caller's last-read value |
| PUT | `/sheet/memo` | official | `{ year, team_num, item_id, memo, expectedMemo }` | `{ memo, updated_at, updated_by }` | Save only if the stored memo still equals the caller's last-read memo |
| PUT | `/sheet/category-result` | official | `{ year, team_num, category_id, result }` | 200 | Upsert category PASS/FAIL (broadcasts SSE) |
| PUT | `/sheet/inspector` | official | `{ year, team_num, category_id, inspector }` | 200 | Upsert inspector name (broadcasts SSE) |

There are no answer or memo version numbers. If `expectedValue` or `expectedMemo` differs from the stored value, the server returns `409 { code: "INSPECTION_STALE_WRITE", current }` and persists nothing. The browser discards the stale local value and instructs the operator to refresh and retry.

## Traffic module (Competition port 9200)

### SSE

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/events` | admin | — | SSE stream | Real-time record/event-mode + wireless updates. init: `{ recordFiles, eventModes, recordVisibility, wireless: { light, mapping, telemetry, bridge, sessions, lastEventId } }`. Wireless event names: `wireless:event`, `wireless:telemetry`, `wireless:light`, `wireless:mapping`, `wireless:bridge`, `wireless:session`, `wireless:command` |

### Record Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/records` | admin | — | `["FSK 2025 가속 1차", ...]` | List all record table names |
| GET | `/records/:name` | admin | — | `[{ rowid, time, num, univ, team, type, result, detail, cones, oc, invalidated, scoreboard }]` | Get records from table |
| GET | `/records/year/:year` | admin | — | `[{ name, records: [...] }]` | 연도별 기록 일괄 조회 (visibility 필터 적용, score 집계용) |
| GET | `/records/visibility` | admin | — | `{ name: bool }` | 기록 파일별 성적 반영 여부 |
| PUT | `/records/:name/visibility` | admin | — | `{ name, visible }` | 기록 파일 성적 반영 토글 |
| POST | `/records` | admin | `{ name, data: { time, type, entry: { id, num, univ, team }, result, detail? } }` | 201 | Add record (auto-creates table with `FSK {year}` prefix). The stable team `id` is re-resolved at save time; current canonical labels are persisted |
| PATCH | `/records/:name/:rowid` | admin | `{ field, value }` | `{ num, ... }` | Update record field (`invalidated`, `scoreboard`, `detail`, `cones`, `oc`, `result`). `result`는 양의 정수(ms/누적 총합) 또는 -1(DNF)만 |
| DELETE | `/records/:name` | admin | — | 200 | Drop record table |

### Controller Logs

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/controllers` | admin | — | `[{ timestamp, data }]` | All controller logs (DESC) |
| POST | `/controllers` | admin | `{ timestamp, data }` | 201 | Add controller log |
| DELETE | `/controllers` | admin | — | 200 | Clear all controller logs |

### Event Modes

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/event-modes` | admin | — | `[{ event_type, enabled }]` | Event mode statuses |
| PUT | `/event-modes/:type` | admin | — | `{ event_type, enabled }` | Toggle event mode (broadcasts SSE) |

### Wireless LoRa Timing (one master + ≤6 sensors, single channel)

마스터 노드에 USB로 연결된 브리지 PC가 모든 센서의 raw 이벤트·진단·신호등 상태를 서버로 push한다. 서버가 권위 상태(경기별 세션: arm·선택·신호등·lease)를 보유하고 모든 클라이언트가 SSE로 동일하게 본다. `green = arm`(측정 t0는 출발 센서). 경기 기록은 **서버 기록 엔진**이 ingest 이벤트로 직접 계산·저장한다(가속/오토크로스 = 출발→도착, 스키드패드 = lap2+lap4) — 무선 클라는 표시만(이중저장 없음). 제어는 경기별 **독점 lease**(claim/heartbeat/release/takeover)로, lease 보유자면 비-브리지도 가상 경기를 제어하고 물리 신호등은 다운링크(`/command`)로 제어한다. 경기: 가속·스키드패드·오토크로스·내구(`EVENT_TYPES`, 짐카나 제거).

세션 객체: `{ event_type, armed, light_color, green_tick, armed_at, team, event_name, controller, lease_expires_at, updated_at }`.

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| POST | `/wireless/ingest` | admin | `{ events?: [{ node_id, master_tick(str 64-bit), ev_seq, rssi?, snr?, link_state? }], telemetry?: [{ node_id, rssi?, snr?, offset_us?, skew_ppm?, latency_ms?, link_state?, rx_miss?, beacon_gap?, temp_c10?, batt_mv?, sec_drop?, provisioned? }] }` (각 ≤200) | `{ stored, deduped, rejected }` | 브리지 배치 ingest. `(node_id, ev_seq, master_tick)` 멱등(재전송 보존, 재부팅 seq 재사용 구분). 불량 항목은 배치 전체 실패 없이 skip(`rejected`). 도착 = 브리지 heartbeat. 신규 이벤트는 **서버 기록 엔진**을 거쳐 armed 경기의 기록을 자동 저장(`records` 브로드캐스트). 보안 관측: `sec_drop`(인증 거부 카운터, node 0=마스터 AEAD 실패) 증가 또는 `provisioned=0`이면 `wireless.security` 로그(`/logs`). `wireless:event`/`wireless:telemetry`/`wireless:bridge` 브로드캐스트 |
| POST | `/wireless/light` | admin | `{ color: red\|green\|yellow\|off, green_tick?(str) }` | `{ ...light }` | 브리지가 물리 신호등 색 보고(green tick은 green일 때만 갱신). `wireless:light` 브로드캐스트 |
| PUT | `/wireless/physical-event` | admin | `{ event_type: <type>\|null }` | `{ ...light }` | 실제 신호등(SSR)을 사용할 경기 지정(`owner_event`). null=없음(전부 가상). 기본은 모든 경기가 가상, 지정 경기만 실제 제어. `wireless:light` 브로드캐스트 |
| PUT | `/wireless/debounce` | admin | `{ ms: 0~5000 정수 }` | `{ ...light }` | 센서 디바운스 창(ms). 한 통과의 다중 엣지(바운스)를 접는 간격. 기본 300, 0이면 끔. `wireless_light.debounce_ms`에 저장, `wireless:light` 브로드캐스트(모든 화면 공유) |
| GET | `/wireless/mapping` | admin | — | `[{ node_id, event_type, role, label, enabled, updated_at }]` | 센서→경기·역할 매핑 |
| PUT | `/wireless/mapping/:node_id` | admin | `{ event_type, role(start\|finish\|lane1~lane9), label?, enabled? }` | `{ ...row }` | 매핑 upsert (`wireless:mapping` 브로드캐스트). 가속·오토크로스=start+finish, 스키드패드·내구=start(단일 센서 멀티랩). 기록 엔진은 finish만 센서2로 취급, 그 외(start·lane*)는 센서1 |
| DELETE | `/wireless/mapping/:node_id` | admin | — | 200 | 매핑 삭제 |
| GET | `/wireless/state` | admin | — | `{ light, mapping, telemetry, bridge, sessions, lastEventId }` | 신선 로드용 종합 스냅샷 |
| GET | `/wireless/events` | admin | `?since=<id>&limit=<n≤1000>` | `[{ id, node_id, master_tick, ev_seq, server_time, rssi, snr, link_state }]` | 늦게 합류한 클라이언트의 raw 이벤트 백필 |
| POST | `/wireless/arm` | admin | `{ event_type, action: green\|red\|off, green_tick?(str) }` | `{ ...session }` | 경기 arm/disarm(green=arm). 가상 경기를 전 클라에 공유. lease 점유자 있으면 그만(409). green은 기록 엔진 런 리셋. `wireless:session` 브로드캐스트 |
| POST | `/wireless/select` | admin | `{ event_type, team?: { id, num, univ, team }\|null, event_name?: string\|null }` | `{ ...session }` | 경기 선택(팀·이벤트명) 공유 — 서버 기록 귀속. 안정적 팀 ID를 현재 활성 팀으로 재확인하며 오래되거나 유효하지 않으면 409, null=해제. lease 점유자만. `wireless:session` 브로드캐스트 |
| POST | `/wireless/dnf` | admin | `{ event_type }` | `{ ok }` | 진행 경기 DNF(result -1) 저장(세션 선택으로 귀속). 미arm 400, 이미 기록된 런 409, 미선택 400. lease 점유자만 |
| POST | `/wireless/command` | admin | `{ event_type, action: green\|red\|off }` | `{ ok }` | 물리 신호등(SSR) 원격 제어 다운링크 — 서버→브리지(`wireless:command`)→시리얼. 물리 지정 경기+브리지 online+lease 필요(아니면 409). 브리지가 실행 직전 isPhysical 재검사 |
| POST | `/wireless/lease/:event` | admin | — | `{ ...session }` | 경기 독점 제어 lease 획득/갱신(heartbeat). 타인 점유 시 409. 점유자 변경 시만 `wireless:session` 브로드캐스트(heartbeat는 조용히 만료 연장) |
| DELETE | `/wireless/lease/:event` | admin | — | `{ ...session }` | lease 해제(보유자 또는 admin 강제 회수). `wireless:session` 브로드캐스트 |
| GET | `/time` | public | — | `{ now }` | 서버 epoch ms — 클라가 라이브 클럭을 서버 기준으로 동기화(오프셋 추정). 인증 면제 |
| POST | `/wireless/bridge/offline` | admin | — | `{ ...bridge }` | 브리지가 종료 직전 오프라인을 즉시 보고 (15초 무수신 감지 대기 없이) |

## Score module (Competition port 9200)

### SSE

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/score/events` | admin | — | SSE stream | 화이트리스트만 재전파: entry `entries`, inspection `category-result`/`answer`, traffic `records`/`record-visibility`/`event-mode`. 재연결 시 `refresh`. 로컬 이벤트: `manual-score`/`penalty`/`setting`/`endurance`/`publication` |
| GET | `/score/public/:year/events` | public (공개 활성 시) | — | SSE stream | 공개 성적표 갱신용 `refresh`, 공개 전환용 `publication`. 관리자 이벤트 페이로드는 노출하지 않음. 전체 500개·IP당 10개 연결 제한 |

### Score Aggregation

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/score` | admin | `?year=` | `{ entries, inspection, events, manualScores, penalties, settings, energy }` | Main aggregation. `energy` contains configuration, reference values, and per-team `PENDING`/`DSQ`/`SCORED` results |

### Public Scoreboard

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/score/publication` | admin | `?year=` | `{ year, enabled }` | 연도별 공개 상태 조회 |
| PUT | `/score/publication` | admin | `{ year, enabled }` | `{ year, enabled }` | 연도별 공개 상태 변경 |
| GET | `/score/public/:year` | public (공개 활성 시) | — | `{ year, entries, events }` | 번호/학교·팀/유형과 내구 제외 경기 모드의 최종 기록만 반환 |

### Manual Scores

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| PUT | `/score/manual` | admin | `{ year, team_num, score_type, value }` | 200 | Upsert manual report/bonus/deduction score. `energy` is rejected because it is calculated from endurance measurements; report values cannot exceed `보고서.total` when configured |

### Penalty & Score Settings

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| PUT | `/score/penalty` | admin | `{ year, event_type, cone_penalty, oc_penalty, start_delay }` | 200 | Set per-event penalty values |
| PUT | `/score/setting` | admin | `{ year, event_type, setting_key, value }` | 200 | Set score settings. Events use `total`/`finish`/`cutoff`; report uses `보고서.total`; energy uses `에너지.total` plus `distance_km`/`fuel_factor` (2.31 L or 2.95 kg) |

### Endurance

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/score/endurance` | admin | `?year=` | `{ team_num: { status, driver1_time, fuel_consumed, ... } }` | Endurance and energy measurement records for year. Energy class is derived from the entry vehicle type (`C-Formula` or `E-Formula`) |
| PUT | `/score/endurance` | admin | `{ year, team_num, field, value }` | 200 | Update endurance fields, the `qualified` flag, or energy fields (C fuel/extra fuel, E net energy, official energy DSQ flag). Boolean flags accept `0` or `1`. Energy class cannot be written manually; negative values are accepted only for E net energy |

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

### Admin/Chief API

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/admin/entries` | chief | `?year=` | `{ num: { univ, team, type, active } }` | 계정 할당·제출 대상 선택을 위한 전체 엔트리 목록. 비활성 팀도 포함 |
| GET | `/admin/sessions` | chief | `?year=` | `[{ id, name, notice, start_at, end_at, ... }]` | All sessions |
| POST | `/admin/sessions` | chief | `{ name, notice?, start_at, end_at, late_end_at?, max_file_size?, allowed_extensions?, year, teams: [int] }` | `{ id }` | Create session |
| PUT | `/admin/sessions/:id` | chief | `{ name, notice?, start_at, end_at, late_end_at?, max_file_size?, allowed_extensions?, teams: [int] }` | 200 | Update session (cleans up removed teams' submissions) |
| DELETE | `/admin/sessions/:id` | chief | — | 200 | Delete session + all files |
| GET | `/admin/sessions/:id/status` | chief | — | `{ session, status: [{ team_num, submission, files, prevSubmission, prevFiles, submissionCount }] }` | Per-team submission status (`submissionCount` = 누적 제출 횟수, 직전 1건은 `prevSubmission`) |
| GET | `/admin/submissions/:subId/files/:fileId` | chief | — | File stream | Admin file download (PDF/text/image/AV → `inline`, other → `attachment`) |
| GET | `/admin/submissions/:subId/zip` | chief | — | ZIP stream | 제출물 전체 zip 다운로드 (팀 라벨 포함 파일명) |
| GET | `/admin/sessions/:id/archive` | chief | — | ZIP stream | 세션 전체 아카이브 (팀별 폴더 구조) |
| GET | `/admin/years/:year/archive` | chief | — | ZIP stream | 연도 전체 아카이브 (세션/팀별 폴더 구조) |
| DELETE | `/admin/years/:year/files` | chief | — | `{ sessions, files }` | 연도별 파일 데이터 삭제 (제출 기록은 유지) |
| GET | `/admin/students` | chief | — | `[{ email, name, realname, phone }]` | Active student users (fetched from auth service) |
| GET | `/admin/student-teams` | chief | `?year=` | `[{ email, team_num, year }]` | Student-team mappings |
| POST | `/admin/student-teams` | chief | `{ email, team_num, year }` | `{ email, team_num, year }` | Add student-team mapping |
| DELETE | `/admin/student-teams/:email/:year` | chief | — | 200 | Remove student-team mapping |

## Email Service (port 9900)

이메일/SMS 관리 서비스. Brevo API 기반 이메일 전송, 대시보드, Brevo/Naver Cloud SMS 설정 관리. 모든 엔드포인트 admin 전용 (health, internal API 제외).

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
| GET | `/api/internal/sms-config` | internal | — | `{ naver_cloud_access_key, naver_cloud_secret_key, naver_cloud_sms_service_id, phone_number_sms_sender }` | SMS configuration for the Competition Queue module (unmasked) |

---

## Course Service (port 10000)

RTK GPS 기반 코스 콘 위치 관리 + 로버 원격 운용 서비스. 코스/콘 CRUD와 SSE(`/api/events`)는 **chief**, 스냅샷·코스 삭제·로버 운용은 **admin**, 로버 기기 인입 엔드포인트는 `X-Internal-Service`(INTERNAL_SECRET) 검증. 역할 표기: `internal` = 내부 시크릿 전용(관리자 JWT로도 불가), `internal/admin` = 내부 시크릿 또는 admin JWT.

### Courses (chief)

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/courses` | chief | — | `[{ id, name, cone_count, created_at, updated_at }]` | 코스 목록 조회 |
| POST | `/api/courses` | chief | `{ name }` | 201 `{ id, name, created_at, updated_at }` | 코스 생성 |
| PATCH | `/api/courses/:id` | chief | `{ name }` | `{ id, name, updated_at }` | 코스 이름 수정 |
| PATCH | `/api/courses/:id/direction` | chief | `{ reverse?, start_cone_id?: int\|null }` | `{ ...course }` | 코스 진행 방향(reverse)·시작 콘 저장 (요청에 담긴 것만 갱신, start_cone_id null=자동 시작 게이트). `courses` SSE(type=direction) 브로드캐스트 |
| DELETE | `/api/courses/:id` | admin | — | 200 | 코스 삭제 (콘·스냅샷 CASCADE 삭제) |
| GET | `/api/courses/:id/export` | chief | — | `{ name, cones: [{lat, lng, side}...] }` | 코스+콘 JSON 다운로드 |
| POST | `/api/courses/import` | chief | `{ name, cones: [{lat, lng, side}...] }` | 201 `{ id, name, ... }` | JSON으로 코스+콘 일괄 생성 (트랜잭션) |

### Course Snapshots (admin)

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/courses/:id/snapshots` | admin | — | `[{ id, taken_at, actor, reason, cone_count }]` | 코스 스냅샷 목록 |
| POST | `/api/courses/:id/snapshots` | admin | `{ reason? }` | 201 | 현재 콘 상태 스냅샷 저장 |
| POST | `/api/courses/:id/snapshots/:sid/restore` | admin | — | 200 | 스냅샷으로 콘 상태 복원 (복원 직전 자동 스냅샷) |
| DELETE | `/api/courses/:id/snapshots/:sid` | admin | — | 200 | 스냅샷 삭제 |

### Cones (chief)

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/courses/:id/cones` | chief | — | `[{ id, course_id, lat, lng, alt, side, created_at, updated_at }]` | 코스의 콘 목록 |
| POST | `/api/courses/:id/cones` | chief | `{ lat, lng, alt?, side }` | 201 `{ id, course_id, lat, lng, side, ... }` | 콘 추가 (side: "left"\|"center"\|"right") |
| DELETE | `/api/courses/:id/cones` | chief | — | 200 | 코스의 콘 전체 삭제 (bulk wipe) |
| PATCH | `/api/cones/:id` | chief | `{ lat?, lng?, side? }` | `{ id, course_id, lat, lng, side, updated_at }` | 콘 수정 (위치/방향) |
| DELETE | `/api/cones/:id` | chief | — | 200 | 콘 삭제 |

#### 메모 스티커 (지도 주석)

메모는 중심 좌표(lat/lng)와 실측 크기(width/height, m)로 저장돼 콘처럼 지리 좌표에 고정된다 — 줌/회전에도 코스 위 같은 자리를 가리키며 줌에 따라 함께 커지고 작아진다. course 삭제 시 CASCADE.

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/courses/:id/memos` | chief | — | `[{ id, course_id, lat, lng, width, height, rotation, content, created_at, updated_at }]` | 코스의 메모 목록 |
| POST | `/api/courses/:id/memos` | chief | `{ lat, lng, width, height, rotation?, content? }` | 201 `{ id, course_id, lat, lng, width, height, rotation, content, ... }` | 메모 추가 (width/height 단위 m, 0 초과 100000 이하; rotation deg, [0,360) 정규화; content 최대 5000자) |
| PATCH | `/api/memos/:id` | chief | `{ lat?, lng?, width?, height?, rotation?, content? }` | `{ id, course_id, lat, lng, width, height, rotation, content, updated_at }` | 메모 수정 (이동/크기/회전/내용) |
| DELETE | `/api/memos/:id` | chief | — | 200 | 메모 삭제 |

### Rover — 기기 인입 (로버 → 서버)

로버는 SSE(`/api/rover/stream`)로 서버에 연결을 유지하고, 서버 이벤트에 대한 응답과 텔레메트리를 아래 엔드포인트로 POST한다. 라우트 구현은 `course/lib/rover-routes.mjs`.

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/rover/stream` | internal | `?device=gps\|rover` | SSE stream | 기기 SSE 연결 (INTERNAL_SECRET 필수). `device=gps`는 GPS 수신기(fsk-rover-gps)의 **별도 슬롯**, 그 외는 로버 — 둘이 동시에 연결 가능(서로 밀어내지 않음). 서버가 `request-position`/`execute-path`/`base-activate`/`rtcm`/`ntrip-source` 등 명령 이벤트를 전달 |
| POST | `/api/rover/position` | internal/admin | `{ lat, lng, alt?, request_id? }` `?device=gps\|rover` | `{ lat, lng, alt }` | 기기가 현재 위치 전송. `request_id`가 있으면 `/api/rover/request` pending 해소. 활성 소스일 때만 `rover` 라이브 이벤트 브로드캐스트 |
| POST | `/api/rover/telemetry` | internal/admin | `{ fix_status, nav_state, ntrip_*, gps, mode?, base?, ... }` `?device=gps\|rover` | 200 | 주기 텔레메트리. 로버면 활성 미션 시 mission_telemetry 영속; 수신기(`device=gps`)면 receiverState(fix/ntrip/gps + base 상태) 갱신 |
| POST | `/api/rover/waypoint_reached` | internal/admin | `{ index }` | 200 | 웨이포인트 도달 보고 (미션 진행 영속 + `rover:waypoint` 브로드캐스트) |
| POST | `/api/rover/waypoint_skipped` | internal/admin | `{ index }` | 200 | stuck 웨이포인트 건너뜀 보고 (`rover:skipped` 브로드캐스트) |
| POST | `/api/rover/spray_result` | internal/admin | `{ waypoint, outcome: success\|cancelled\|timeout }` | 200 | 도색 결과 보고 (미션에 영속 + `rover:spray` 브로드캐스트) |
| POST | `/api/rover/obstacle` | internal | `{ ... }` | 200 | 장애물 감지 보고 (`rover:obstacle` 브로드캐스트) |
| POST | `/api/rover/logs` | internal/admin | `{ entries: [...] }` | 200 | 로버 로그 업로드 (서버 메모리 캐시, 최대 1000줄) |
| POST | `/api/rover/antenna_calibration_result` | internal/admin | `{ ... }` | 200 | 안테나 캘리브레이션 결과 보고 |
| POST | `/api/rover/wheel_calibration_result` | internal/admin | `{ ... }` | 200 | 휠 캘리브레이션 결과 보고 |
| POST | `/api/rover/calibration-progress` | internal | `{ ... }` | 200 | 스테레오 캘리브레이션 진행률 보고 |
| POST | `/api/rover/base/survey-result` | internal | `{ point_id, lat, lng, alt, h_acc, samples }` | 200 | 수신기(base station)가 측량 결과 보고 → survey_point 갱신 |
| POST | `/api/rover/base/rtcm` | internal | `{ data: base64 }` | 200 | 수신기(base station)가 RTCM3 청크 전송 → 로버로 릴레이(SSE `rtcm`). 로버 미연결이면 드롭 |
| POST | `/api/rover/camera` | internal | `image/jpeg` (≤3MB) | 200 | 카메라 프레임 push (서버가 뷰어에 MJPEG 릴레이). WebRTC가 기본 경로이므로 이건 **폴백** — MJPEG 뷰어가 있을 때만(`mjpeg-on`) 로버가 POST |
| GET | `/api/rover/camera/control` | internal | — | SSE stream | perception 컨테이너의 카메라 제어 채널. 서버가 캡처/스트림 제어 이벤트를 전송: `camera-start`/`camera-stop`, `mjpeg-on`/`mjpeg-off`, `webrtc-2d-on`/`webrtc-2d-off`, `webrtc-vr-on`/`webrtc-vr-off`, `depth-on`/`depth-off`. 각 스트림은 해당 뷰어가 있을 때만 인코딩 |

### Rover — 운용 (관리자 → 서버 → 로버)

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/rover/status` | admin | — | `{ connected, nav_state, mission, last_position, ... }` | 로버 종합 상태 스냅샷 |
| POST | `/api/rover/request` | admin | — | `{ lat, lng }` | 로버에 위치 요청 후 응답 대기 (5초 타임아웃). 503=미연결, 504=타임아웃 |
| POST | `/api/rover/execute` | admin | `{ waypoints: [{lat,lng}...] }` | `{ sent }` | 경로 waypoint를 로버에 전송 (SSE `execute-path` 이벤트). 웨이포인트 간 거리 검증. 409=EMERGENCY_STOP 래치 상태 |
| POST | `/api/rover/stop` | admin | — | `{ stopped: true }` | 비상정지 (SSE `emergency-stop` 이벤트) |
| POST | `/api/rover/pause` | admin | — | 200 | 미션 일시정지 (SSE `pause` 이벤트) |
| POST | `/api/rover/resume` | admin | — | 200 | 미션 재개 (SSE `resume` 이벤트) |
| POST | `/api/rover/clear-emergency` | admin | — | `{ cleared: true }` | 비상정지 해제. 미션은 자동 종료되지 않고 보존되어 "이어서 실행" 가능 |
| POST | `/api/rover/end-mission` | admin | — | `{ ended, mission_id? }` | 보존된 미션을 명시적으로 종료. 활성 미션 없으면 `ended:false` |
| POST | `/api/rover/control` | admin | `{ throttle, steering }` | `{ throttle, steering }` | 수동 제어 (-100~100, SSE `manual-control` 이벤트) |
| POST | `/api/rover/pump` | admin | `{ on }` | `{ on }` | 페리스탈릭 펌프 수동 on/off 토글 |
| POST | `/api/rover/pump-duration` | admin | `{ seconds }` (0~10) | `{ ok }` | 펌프 분사 시간(초) 설정. 로버 재연결 시 재전송 |
| POST | `/api/rover/nav-lights` | admin | `{ ... }` | 200 | 항법등 제어 |
| POST | `/api/rover/led-brightness` | admin | `{ ... }` | 200 | LED 밝기 제어 |
| POST | `/api/rover/calibrate-battery` | admin | `{ measured_v }` (15~32 V) | `{ ok, measured_v }` | 멀티미터 실측값으로 배터리 ADC 게인 1점 보정. 로버가 영구 저장 |
| POST | `/api/rover/calibrate-stereo` | admin | — | 200 | 스테레오 카메라 캘리브레이션 시작 |
| POST | `/api/rover/calibrate-ground` | admin | `{ frames? }` (10~120, 기본 30) | `{ ok }` | 지면 교정 시작(above-ground 검출기 행별 기대 지면 깊이 곡선). 스테레오 교정 선행 필요, perception 미연결 시 503 |
| POST | `/api/rover/calibrate-antenna` | admin | — | 200 | GPS 안테나 오프셋 캘리브레이션 시작 |
| POST | `/api/rover/set-antenna-offset` | admin | `{ ... }` | 200 | 안테나 오프셋 수동 설정 |
| POST | `/api/rover/calibrate-wheels` | admin | — | 200 | 휠 캘리브레이션 시작 |
| POST | `/api/rover/reset-wheel-cal` | admin | — | 200 | 휠 캘리브레이션 초기화 |
| GET | `/api/rover/logs` | internal/admin | — | `{ entries, uploaded_at }` | 업로드된 로버 로그 조회 |
| POST | `/api/rover/logs/fetch` | admin | — | 200 | 로버에 로그 업로드 요청 (SSE 이벤트) |
| GET | `/api/rover/camera/stream` | admin | — | MJPEG stream | 카메라 MJPEG 스트림 (최대 8 뷰어, ≤~25fps 릴레이). WebRTC(WHEP) 실패/드롭 시의 **폴백** — 뷰어가 붙으면 서버가 `mjpeg-on`을 로버에 전달 |
| GET | `/api/rover/camera/hold` | admin | `?mode=2d\|vr` | SSE stream | WebRTC **게이팅 전용** 뷰어. MJPEG 프레임은 안 받고, 로버가 캡처 + 해당 WebRTC 스트림(`mode=2d`→`rover-2d`, `mode=vr`→`rover-vr`)을 publish하도록 유지. 2D 패널/VR 뷰가 세션 동안 열어둠 |
| POST | `/api/rover/camera/depth` | admin | `{ on }` | `{ ok, depth, camera_connected }` | 양안 깊이 컴포지트(정류 좌안 + 깊이 히트맵 + 최근접 거리, 로버가 렌더) 토글. 2D 뷰어(MJPEG `cameraViewers` **또는** WebRTC `holdViewers2d`)가 있어야 적용 — 뷰어 없으면 무시. 마지막 2D 뷰어 이탈 시 자동 해제 |
| POST | `/api/rover/camera/detection` | admin | `{ on }` | `{ ok, detection, camera_connected }` | 근접(장애물) 감지 토글. depth와 달리 뷰어 게이트 없이 NAVIGATING 중 항상 적용되는 미션 안전 설정. roverState에 저장(`rover:status` 반영)되고 perception 재연결마다 재전송. 로버 env `OBSTACLE_DETECTION`이 하드 킬스위치, 이건 운영자 소프트 on/off |
| GET | `/api/rover/camera/status` | admin | — | `{ camera_connected, viewers, depth, last_frame_age_ms }` | 카메라 릴레이 상태. `camera_connected`=perception 제어 SSE 연결됨, `viewers`=MJPEG 뷰어 수, `depth`=컴포지트 모드, `last_frame_age_ms`=서버 계산 프레임 경과(뷰어 없으면 null) |
| GET | `/api/rover/map-tile` | admin | `?z=&x=&y=` | image (jpeg/png) | VR 미니맵용 위성 타일 **동일 출처 프록시**. WebGL 캔버스가 교차 출처 타일로 오염되지 않도록 VWorld(서버측 `VWORLD_KEY`)·구글 타일을 서버가 대신 가져와 전달. z/x/y는 slippy-map(XYZ) 인덱스, 범위 밖이면 400 |

### GPS — 수신기 소스 선택 + base station 측량점

콘 좌표 캡처는 GPS 수신기(연결 시)를 우선, 없으면 로버를 사용한다. 로버의 RTK 보정 소스는
NGII(공용 NTRIP)와 **수신기 base station**(측량점에 고정한 수신기가 RTCM3 생성 → 서버 릴레이 →
로버) 중 선택한다. 수신기의 "캡처 소스"·"base station" 역할은 상호배타. admin 전용. 구현은
`course/lib/rover-routes.mjs`, 테이블은 `course/index.mjs`(`gps_config`, `survey_point`).

| Method | Path | 인증 | Body | 응답 | 설명 |
|--------|------|------|------|------|------|
| GET | `/api/gps/config` | admin | — | `{ ntrip_source, active_base_point_id }` | 현재 GPS 소스 설정 |
| PUT | `/api/gps/config` | admin | `{ ntrip_source: ngii\|base, active_base_point_id? }` | config | 소스 변경. base면 측량 완료된 점 필수. 수신기에 `base-activate`/`base-stop`, 로버에 `ntrip-source` 즉시 전송 |
| GET | `/api/gps/survey-points` | admin | — | `{ points: [...] }` | 측량점 목록 |
| POST | `/api/gps/survey-points` | admin | `{ name }` | point | 측량점 추가(이름만, 좌표 미측량) |
| DELETE | `/api/gps/survey-points/:id` | admin | — | 200 | 삭제. 활성 base면 409 |
| POST | `/api/gps/survey-points/:id/survey` | admin | `{ duration_s? }` | `{ ok, duration_s }` | 수신기 측량 시작(NGII rtk_fixed 위치 평균). 미연결 503, base 모드면 409 |
| POST | `/api/gps/survey-points/:id/survey/cancel` | admin | — | 200 | 측량 취소 |

기기 방향 이벤트(서버 → 기기, 위 `/api/rover/stream`으로 전달): 수신기 `base-survey-start`/
`base-survey-cancel`/`base-activate`/`base-stop`, 로버 `rtcm`(base64)·`ntrip-source`(`ngii\|base`).

### Rover 카메라 — WebRTC 시그널링 (mediamtx, WHIP/WHEP)

저지연 카메라(H.264)는 별도 `mediamtx` 릴레이를 통한 WebRTC로 전달된다. caddy가 `/course/api/rtc/*`를 `mediamtx:8889`로 리버스 프록시하며(`landing/Caddyfile`), 시그널링 SDP만 HTTP로 타고 미디어는 별도 UDP/SRTP다. mediamtx는 permit-all + ClusterIP 전용(외부에서 직접 접근 불가)이라 **caddy의 게이트가 곧 접근 제어**다 — 시그널링 교환 없이는 SRTP 키를 세울 수 없어 미디어 포트만으로는 무용하다:

- **WHIP(로버 publish)**: caddy가 `X-Internal-Service` = `INTERNAL_SECRET`를 요구(없으면 403). 로버가 이 헤더를 실어 발행.
- **WHEP(브라우저 play)**: caddy `forward_auth`로 **admin 세션** 요구(비admin은 401/403).

mediamtx는 프로덕션 k3s(GitOps)에만 배포되며 `compose.yml`에는 없다 — 로컬 compose 스택에선 WebRTC가 동작하지 않고 MJPEG 폴백만 쓰인다.

| 방향 | 경로 | 인증 | 스트림 | 설명 |
|------|------|------|--------|------|
| 로버 publish (WHIP) | `POST /course/api/rtc/rover-2d/whip` | X-Internal-Service | rover-2d | 모노 / 깊이 컴포지트 (2D 패널). aiortc가 발행 |
| 로버 publish (WHIP) | `POST /course/api/rtc/rover-vr/whip` | X-Internal-Service | rover-vr | 정류 좌·우 side-by-side 스테레오 (VR 뷰) |
| 브라우저 play (WHEP) | `POST /course/api/rtc/rover-2d/whep` | admin | rover-2d | 2D 운영 패널이 재생 |
| 브라우저 play (WHEP) | `POST /course/api/rtc/rover-vr/whep` | admin | rover-vr | WebXR VR 뷰가 재생 (눈별 분할) |

로버는 `SERVER_URL`로 WHIP URL을 구성하고, publish 게이팅은 `/api/rover/camera/hold`(위 표)가 담당한다. 프론트는 `course/web/src/composables/useWhepStream.js`(2D)·`course/web/src/views/VrView.vue`(VR)에서 WHEP로 재생하며, WebRTC가 기본이고 MJPEG(`/api/rover/camera/stream`)은 폴백이다.

### Missions (admin)

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/missions` | admin | `?limit=(≤500, 기본 50)&offset=` | `{ missions, total }` | 미션 이력 목록 |
| GET | `/api/missions/:id` | admin | — | `{ ...mission, waypoints, spray_results }` | 미션 상세 |
| GET | `/api/missions/:id/telemetry` | admin | — | `{ samples: [...] }` | 미션 텔레메트리 전체 (대용량 가능 — 페이지네이션 미지원, 후속 과제) |

### SSE (`/api/events`, chief)

| Event | Data | Description |
|-------|------|-------------|
| `init` | `{ courses }` | 연결 시 코스 목록 |
| `courses` | `{ type, course?, courseId?, courses }` | 코스 변경 (type: create/rename/direction/delete/import/start_reset) |
| `cones` | `{ type, courseId, cone?, coneId?, cones }` | 콘 변경 (type: add/update/delete/clear/restore) |
| `memos` | `{ type, courseId, memo?, memoId?, memos }` | 메모 변경 (type: add/update/delete) |
| `rover` | `{ lat, lng, alt, source }` | 활성 소스 위치 수신 시 브로드캐스트 (source: rover\|receiver) |
| `rover:status` | roverState + `{ receiver, position_source, ntrip_source }` | 로버·수신기·GPS·카메라·캘리브레이션 종합 상태 |
| `rover:waypoint` / `rover:skipped` / `rover:spray` / `rover:obstacle` | `{ index }` / `{ waypoint, outcome }` / `{ nearest_m, paused }` 등 | 미션 진행 이벤트 |
| `rover:logs` | `{ count, uploaded_at }` | 로버 로그 업로드 완료 |
| `rover:antenna_calibration` | 캘리브레이션 결과 객체 | 안테나 오프셋 캘리브레이션 결과 |
| `gps:survey_result` | `{ point_id, name, ok, samples? }` | base station 측량 결과 |

---

## Calendar Service (port 11000)

대회 일정 관리 서비스. 조회는 public(role 기반 필터링), CUD는 chief+.

### Events

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/events` | public | `?timeMin=<ISO>&timeMax=<ISO>` | `[{ id, title, start, end, description, location, allDay, calendarId, role }]` | 기간 내 이벤트 목록 (사용자 role에 따라 필터링) |
| POST | `/api/events` | chief | `{ title, start, end, role?, description?, location?, allDay? }` | 201 `{ id, title, start, end, description, location, allDay, calendarId, role }` | 이벤트 생성 (role 기본값 "official", 자신의 role 이하만 설정 가능) |
| PUT | `/api/events/:id` | chief | `{ title, start, end, role?, description?, location?, allDay? }` | `{ id, title, start, end, description, location, allDay, calendarId, role }` | 이벤트 수정 |
| DELETE | `/api/events/:id` | chief | — | 204 | 이벤트 삭제 |

### Subscribe / iCal

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/events/subscribe` | student | — | `{ role, path }` | 사용자 role 기반 서명된 iCal 구독 URL 반환 |
| GET | `/api/events/ical` | public | `?role=<role>&sig=<hmac>` | `text/calendar` (iCalendar RFC 5545) | 서명 검증 후 role 기반 필터링된 iCal 피드 반환 |

- `calendarId`: `role` 필드와 동일한 값 (캘린더 식별자)
- `allDay: true` → `start`/`end`는 `YYYY-MM-DD` 형식
- `allDay: false` → `start`/`end`는 UTC ISO 8601 형식(`...Z`, 예 `2026-07-13T05:00:00.000Z`). 요청 body는 `YYYY-MM-DD HH:mm`(Asia/Seoul 해석) 또는 오프셋/Z 포함 ISO를 받아 UTC로 정규화해 저장·응답한다
- iCal 서명: HMAC-SHA256 (`JWT_SECRET`), PRODID `-//Formula Student Korea//Calendar//KO`
