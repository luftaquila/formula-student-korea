# API.md

Complete API reference for all 8 backend services. Each service exposes `/api/health` (public, returns `"ok"`) and `/api/logs` (admin, query handler from `shared/logger.mjs`). Services with real-time updates expose an SSE endpoint. All services except entry have a SPA fallback (`GET /{*splat}`) serving `index.html`.

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

### Common Endpoints (all services)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/health` | public | Health check, returns `"ok"` |
| GET | `/api/logs` | admin | Structured log query (from `shared/logger.mjs`) |

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
| GET | `/api/users` | admin | — | `[{ id, email, name, role, memo, active, created_at, protected }]` | List all users |
| POST | `/api/users` | admin | `{ email, role }` | `{ id, email, role }` | Create user |
| POST | `/api/users/bulk` | admin | `{ users: [{ email, role, memo }] }` | `{ added, skipped, errors }` | Bulk create users (INSERT OR IGNORE) |
| PATCH | `/api/users/bulk` | admin | `{ ids: [int], active: bool }` | `{ updated }` | Bulk activate/deactivate users |
| DELETE | `/api/users/bulk` | admin | `{ ids: [int] }` | `{ deleted }` | Bulk delete users (protects last admin) |
| PATCH | `/api/users/:id` | admin | `{ role?, memo?, active? }` | 200 | Update user role/memo/active status |
| DELETE | `/api/users/:id` | admin | — | 200 | Delete single user (protects last admin, ADMIN_EMAIL) |

### Internal User Lookup

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/users/exists/:email` | admin | — | 200 or 404 | Check if user exists and is active (internal service use) |
| GET | `/api/users/role/:email` | admin | — | `{ role }` or 404 | Get user role (internal service use, sliding renewal) |

### Operations Contacts

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/ops-contacts` | official | — | `[{ id, name, phone }]` | List operations contacts |
| POST | `/api/ops-contacts` | admin | `{ name, phone }` | `{ id, name, phone }` | Add contact |
| DELETE | `/api/ops-contacts/:id` | admin | — | 200 | Delete contact |

### Log Aggregation

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/admin/logs` | admin | `?service=&limit=&offset=&level=&action=&actor=&from=&to=&search=` | `{ logs, total, services }` | Aggregated logs from all services (local auth + remote via LOG_SERVICES) |

---

## Entry Service (port 9200)

### Entry Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/years` | public | — | `[2025, 2024, ...]` | Available year list |
| GET | `/api/entries` | public | `?year=&download` | `{ num: { univ, team, type } }` | All entries for year; `download` param triggers JSON file download |
| POST | `/api/entries` | admin | `{ num, univ, team, type? }?year=` | 201 | Create entry |
| PATCH | `/api/entries/:num` | admin | `{ num, univ, team, type? }?year=` | 200 or 502 | Update entry (502 if documents sync failed, rollback) |
| DELETE | `/api/entries/:num` | admin | `?year=` | 200 | Delete single entry |
| DELETE | `/api/entries` | admin | `?year=` | 200 | Delete all entries for year |
| POST | `/api/entries/bulk` | admin | `{ data: { "num": { univ, team, type? } } }?year=` | 200 | Bulk upload (replaces all entries for year) |

### Vehicle Types

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/vehicle-types` | public | — | `[{ id, name, sort_order }]` | List vehicle types |
| POST | `/api/vehicle-types` | admin | `{ name }` | `{ id, name, sort_order }` | Create vehicle type |
| DELETE | `/api/vehicle-types/:id` | admin | — | 200 | Delete vehicle type (NULLs entries referencing it) |

---

## Queue Service (port 9300)

### SSE

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/events` | public | — | SSE stream | Real-time queue/booth updates; initial data: `{ activeInspections, allBooths }` |

### Public Endpoints

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/active` | public | — | `[{ type, name, length, active, ... }]` | Active inspection types |
| POST | `/api/state/:num` | public | `{ phone }` | `{ queue, rank }` | Check queue position (rate-limited, phone verification) |
| GET | `/api/booths/all` | public | — | `{ type: [{ booth_num, active, occupied_by, entered_at }] }` | All booth statuses |
| GET | `/api/booths/:type` | public | — | `[{ booth_num, active, occupied_by, entered_at }]` | Booth status for inspection type |

### Inspection Type Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/admin/all` | official | — | `[{ type, name, length, active, ignore_priority, ... }]` | All inspection types (including inactive) |
| GET | `/api/admin/inspection/:type` | official | — | `[{ num, phone, timestamp, is_reinspection, priority }]` | Queue listing for inspection type (sorted) |
| PATCH | `/api/admin/inspection/:type` | chief | `{ active: bool }` | 200 | Toggle inspection active status |
| PATCH | `/api/admin/inspection/:type/visibility` | chief | `{ hidden: bool }` | 200 | Toggle inspection visibility on register page |
| PUT | `/api/admin/inspection/:type/ignore` | chief | `{ field, value }` | 200 | Set ignore_priority or ignore_reinspection |

### Queue Registration

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| POST | `/api/admin/register/:type` | official | `{ num, phone }` | 201 | Register team in queue (validates entry, penalty, concurrent rules) |
| POST | `/api/admin/cancel/:type` | official | `{ num }` | 200 | Cancel registration (applies time penalty) |

### Priority Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/admin/priority/:type` | chief | — | `[{ num, inspection, priority }]` | List priorities for inspection type |
| POST | `/api/admin/priority/:type` | chief | `{ num, priority }` | 201 | Set/update team priority |
| DELETE | `/api/admin/priority/:type` | chief | `{ num }` | 200 | Remove team priority |
| DELETE | `/api/admin/priority/:type/all` | chief | — | 200 | Clear all priorities for inspection type |

### History

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| DELETE | `/api/admin/history/:type` | chief | — | 200 | Clear inspection history + booth occupancy for type |

### Booth Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/admin/booths/:type` | official | — | `[{ booth_num, active, occupied_by, entered_at }]` | Booth list for type |
| PATCH | `/api/admin/booths/:type/config` | chief | `{ count }` | 200 | Change booth count (1-100) |
| PATCH | `/api/admin/booths/:type/:boothNum` | official | `{ active: bool }` | 200 | Toggle booth active/inactive |
| POST | `/api/admin/booths/:type/:boothNum/enter` | official | `{ num }` | 200 | Move team from queue to booth |
| POST | `/api/admin/booths/:type/:boothNum/exit` | official | — | 200 | Complete inspection, record history |

### Statistics

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/admin/stats/timerange` | official | `?year=` | `{ from, to }` | Log time range for year |
| GET | `/api/admin/stats` | official | `?from=&to=&inspection=` | `[{ num, registrations, cancellations, entries, totalOccupyTime }]` | All teams stats |
| GET | `/api/admin/stats/:num` | official | `?from=&to=&inspection=` | `{ summary, timeline }` | Single team stats with event timeline |

### Settings

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/admin/settings/sms` | official | — | `{ value: bool }` | SMS notification enabled status |
| PATCH | `/api/admin/settings/sms` | chief | `{ value: bool }` | 200 | Toggle SMS notifications |
| GET | `/api/admin/settings/sms-rank` | official | — | `{ value: int }` | SMS notification rank threshold |
| PATCH | `/api/admin/settings/sms-rank` | chief | `{ value: int }` | 200 | Set SMS rank (1-10) |
| GET | `/api/admin/settings/cancel-penalty` | official | — | `{ value: int }` | Cancel penalty minutes |
| PATCH | `/api/admin/settings/cancel-penalty` | chief | `{ value: int }` | 200 | Set cancel penalty (0-60 min) |

### Internal API

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| DELETE | `/api/internal/team/:num` | admin | `?year=` | 200 | Cleanup team data on entry deletion (queue, priority, penalty, history, booth occupancy) |

---

## Inspection Service (port 9400)

### SSE

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/sheet/events` | official | — | SSE stream | Real-time answer/memo/result/inspector updates |

### Template Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/sheet/template` | official | `?year=` | Tree: `[{ id, name, subcategories: [{ groups: [{ items }] }] }]` | Template tree for year |
| POST | `/api/sheet/template` | admin | `{ year, level, parent_id?, name, sort_order?, answer_type?, remarks?, unit?, pdf_include? }` | `{ id }` | Create template node |
| PUT | `/api/sheet/template/:id` | admin | `{ name?, sort_order?, answer_type?, remarks?, unit?, pdf_include? }` | 200 | Update template node |
| DELETE | `/api/sheet/template/:id` | admin | — | 200 | Delete template node (CASCADE, blocks past years) |
| POST | `/api/sheet/template/reorder` | admin | `{ items: [{ id, sort_order }] }` | 200 | Reorder sibling nodes |
| POST | `/api/sheet/template/copy` | admin | `{ from_year, to_year }` | 201 | Copy template across years |
| POST | `/api/sheet/template/import` | admin | `{ year, template: [...] }` | 201 | Import template from JSON |

### Sheet Data

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/sheet/summary` | official | `?year=` | `{ categories, teams }` | All teams' category-level results and inspectors |
| GET | `/api/sheet/bulk-answers` | official | `?year=&item_ids=1,2,3` | `{ team_num: { item_id: value } }` | Bulk answer values for specific items |
| GET | `/api/sheet/data/:year/:num` | official | — | `{ answers, results, inspectors }` | Full sheet data for a team |
| PUT | `/api/sheet/answer` | official | `{ year, team_num, item_id, value }` | 200 | Upsert answer (broadcasts SSE) |
| PUT | `/api/sheet/memo` | official | `{ year, team_num, item_id, memo }` | 200 | Upsert memo (broadcasts SSE) |
| PUT | `/api/sheet/category-result` | official | `{ year, team_num, category_id, result }` | 200 | Upsert category PASS/FAIL (broadcasts SSE) |
| PUT | `/api/sheet/inspector` | official | `{ year, team_num, category_id, inspector }` | 200 | Upsert inspector name (broadcasts SSE) |

---

## Traffic Service (port 9500)

### SSE

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/events` | admin | — | SSE stream | Real-time record/event-mode updates; initial data: `{ recordFiles, eventModes }` |

### Record Management

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/records` | admin | — | `["FSK 2025 가속 1차", ...]` | List all record table names |
| GET | `/api/records/:name` | admin | — | `[{ rowid, time, num, univ, team, type, result, detail, cones, oc, invalidated, scoreboard }]` | Get records from table |
| POST | `/api/records` | admin | `{ name, data: { time, type, entry: { num, univ, team }, result, detail? } }` | 201 | Add record (auto-creates table with `FSK {year}` prefix) |
| PATCH | `/api/records/:name/:rowid` | admin | `{ field, value }` | `{ num, ... }` | Update record field (`invalidated`, `scoreboard`, `detail`, `cones`, `oc`) |
| DELETE | `/api/records/:name` | admin | — | 200 | Drop record table |

### Controller Logs

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/controllers` | admin | — | `[{ timestamp, data }]` | All controller logs (DESC) |
| POST | `/api/controllers` | admin | `{ timestamp, data }` | 201 | Add controller log |
| DELETE | `/api/controllers` | admin | — | 200 | Clear all controller logs |

### Event Modes

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/event-modes` | admin | — | `[{ event_type, enabled }]` | Event mode statuses |
| PUT | `/api/event-modes/:type` | admin | — | `{ event_type, enabled }` | Toggle event mode (broadcasts SSE) |

---

## Score Service (port 9600)

### SSE

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/score/events` | admin | — | SSE stream | Re-broadcasts `inspection:*` and `traffic:*` events + manual-score/penalty/setting/endurance |

### Score Aggregation

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/score` | admin | `?year=` | `{ entries, inspection, events, manualScores, penalties, settings }` | Main aggregation (fetches from entry, inspection, traffic services) |

### Manual Scores

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| PUT | `/api/score/manual` | admin | `{ year, team_num, score_type, value }` | 200 | Upsert manual score (report, energy, etc.) |

### Penalty & Score Settings

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| PUT | `/api/score/penalty` | admin | `{ year, event_type, cone_penalty, oc_penalty, start_delay }` | 200 | Set per-event penalty values |
| PUT | `/api/score/setting` | admin | `{ year, event_type, setting_key, value }` | 200 | Set per-event score settings (total_points, completion_points, cutoff) |

### Endurance

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/score/endurance` | admin | `?year=` | `{ team_num: { status, driver1_time, ... } }` | Endurance records for year |
| PUT | `/api/score/endurance` | admin | `{ year, team_num, field, value }` | 200 | Update single endurance field (status, driver times, cones, oc, penalties) |

---

## Documents Service (port 9700)

### Student API

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/sessions` | student | — | `{ team, sessions }` | My team's open sessions with latest submission |
| GET | `/api/sessions/:id` | student | — | `{ session, team_num, submission, files }` | Session detail with files |
| POST | `/api/sessions/:id/submit` | student | `multipart/form-data` | `{ id, submitted_at, is_late, total_size }` | Upload files (validates time window, extensions, size) |
| GET | `/api/submissions/:subId/files/:fileId` | student | — | File download | Download own submission file |

### Admin/Chief API

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/admin/sessions` | chief | `?year=` | `[{ id, name, notice, start_at, end_at, ... }]` | All sessions |
| POST | `/api/admin/sessions` | chief | `{ name, notice?, start_at, end_at, late_end_at?, max_file_size?, allowed_extensions?, year, teams: [int] }` | `{ id }` | Create session |
| PUT | `/api/admin/sessions/:id` | chief | `{ name, notice?, start_at, end_at, late_end_at?, max_file_size?, allowed_extensions?, teams: [int] }` | 200 | Update session (cleans up removed teams' submissions) |
| DELETE | `/api/admin/sessions/:id` | chief | — | 200 | Delete session + all files |
| GET | `/api/admin/sessions/:id/status` | chief | — | `{ session, status: [{ team_num, submission, files }] }` | Per-team submission status |
| GET | `/api/admin/submissions/:subId/files/:fileId` | chief | — | File download | Admin file download |
| GET | `/api/admin/students` | chief | — | `[{ email, name }]` | Active student users (fetched from auth service) |
| GET | `/api/admin/student-teams` | chief | `?year=` | `[{ email, team_num, year }]` | Student-team mappings |
| POST | `/api/admin/student-teams` | chief | `{ email, team_num, year }` | `{ email, team_num, year }` | Add student-team mapping |
| DELETE | `/api/admin/student-teams/:email/:year` | chief | — | 200 | Remove student-team mapping |

### Internal API

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| PATCH | `/api/internal/team-num` | admin | `{ prevNum, newNum, year }` | 200 | Sync team number change from entry service (updates student_team, session_team, submission, renames upload dirs) |
| DELETE | `/api/internal/team/:num` | admin | `?year=` | 200 | Cleanup team data on entry deletion (student_team, session_team, submission, files) |

---

## Course Service (port 10000)

RTK GPS 기반 코스 콘 위치 관리 서비스. 모든 엔드포인트 admin 전용 (health, rover/stream, rover/position 제외).

### Courses

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/courses` | admin | — | `[{ id, name, cone_count, created_at, updated_at }]` | 코스 목록 조회 |
| POST | `/api/courses` | admin | `{ name }` | 201 `{ id, name, created_at, updated_at }` | 코스 생성 |
| PATCH | `/api/courses/:id` | admin | `{ name }` | `{ id, name, updated_at }` | 코스 이름 수정 |
| DELETE | `/api/courses/:id` | admin | — | 200 | 코스 삭제 (콘 CASCADE 삭제) |
| GET | `/api/courses/:id/export` | admin | — | `{ name, cones: [{lat, lng, side}...] }` | 코스+콘 JSON 다운로드 |
| POST | `/api/courses/import` | admin | `{ name, cones: [{lat, lng, side}...] }` | 201 `{ id, name, ... }` | JSON으로 코스+콘 일괄 생성 (트랜잭션) |

### Cones

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/courses/:id/cones` | admin | — | `[{ id, course_id, lat, lng, side, created_at, updated_at }]` | 코스의 콘 목록 |
| POST | `/api/courses/:id/cones` | admin | `{ lat, lng, side }` | 201 `{ id, course_id, lat, lng, side, ... }` | 콘 추가 (side: "left"\|"center"\|"right") |
| PATCH | `/api/cones/:id` | admin | `{ lat?, lng?, side? }` | `{ id, course_id, lat, lng, side, updated_at }` | 콘 수정 (위치/방향) |
| DELETE | `/api/cones/:id` | admin | — | 200 | 콘 삭제 |

### Rover

로버는 SSE로 서버에 연결 유지. 관리자가 위치 요청 시 서버가 SSE 이벤트로 로버에 전달, 로버가 즉시 현재 좌표를 POST.

| Method | Path | Role | Request | Response | Description |
|--------|------|------|---------|----------|-------------|
| GET | `/api/rover/stream` | public | — | SSE stream | 로버 SSE 연결 (로버가 호출). `request-position` 이벤트 수신 시 위치 전송 |
| POST | `/api/rover/position` | public | `{ lat, lng }` | `{ lat, lng }` | 로버가 현재 위치 전송 (로버가 호출) |
| POST | `/api/rover/request` | admin | — | `{ lat, lng }` | 로버에 위치 요청 후 응답 대기 (5초 타임아웃). 503=미연결, 504=타임아웃 |
| POST | `/api/rover/execute` | admin | `{ waypoints: [{lat,lng}...] }` | `{ sent }` | 경로 waypoint를 로버에 전송 (SSE `execute-path` 이벤트) |
| POST | `/api/rover/stop` | admin | — | `{ stopped: true }` | 비상정지 (SSE `emergency-stop` 이벤트) |
| POST | `/api/rover/control` | admin | `{ throttle, steering }` | `{ throttle, steering }` | 수동 제어 (-100~100, SSE `manual-control` 이벤트) |

### SSE (`/api/events`)

| Event | Data | Description |
|-------|------|-------------|
| `init` | `{ courses }` | 연결 시 코스 목록 |
| `courses` | `{ type, course?, courseId?, courses }` | 코스 생성/수정/삭제 |
| `cones` | `{ type, courseId, cone?, coneId?, cones }` | 콘 추가/수정/삭제 |
| `rover` | `{ lat, lng }` | 로버 위치 수신 시 브로드캐스트 |
