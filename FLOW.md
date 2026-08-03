# 비즈니스 흐름 문서

전체 10개 서비스의 비즈니스 흐름을 서비스별로 정리한 문서입니다.

> **공통 엔드포인트**: 모든 10개 서비스는 `GET /api/health` (public, 헬스체크)와 `GET /api/logs` (admin, 로컬 서비스 로그 조회) 엔드포인트를 공통으로 노출합니다.

## 목차

- [1. Auth 서비스](#1-auth-서비스)
- [2. Entry 서비스](#2-entry-서비스)
- [3. Queue 서비스](#3-queue-서비스)
- [4. Inspection 서비스](#4-inspection-서비스)
- [5. Traffic 서비스](#5-traffic-서비스)
- [6. Score 서비스](#6-score-서비스)
- [7. Documents 서비스](#7-documents-서비스)
- [8. Course 서비스](#8-course-서비스)
- [9. Calendar 서비스](#9-calendar-서비스)
- [10. Email 서비스](#10-email-서비스)
- [11. 서비스 간 연동 흐름](#11-서비스-간-연동-흐름)

---

## 1. Auth 서비스

### 인증

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 1.1 | Google OAuth 로그인 | public | `GET /api/login` | Google 동의 화면으로 리다이렉트, CSRF nonce 쿠키 설정, IP당 20req/min 제한 |
| 1.2 | OAuth 콜백 처리 | public | `GET /api/callback` | nonce 검증 → 토큰 교환 → 사용자 조회 → JWT 쿠키 발급 (7일) → 리다이렉트 |
| 1.3 | 세션 확인 | public | `GET /api/session` | 랜딩 페이지에서 JWT 유효성 확인, `{ name, role }` 또는 401 반환 |
| 1.4 | 로그아웃 | 인증 | `POST /api/logout` | JWT + 사용자 쿠키 만료 |

### 사용자 관리

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 1.5 | 사용자 추가 | admin | `POST /api/users` | `{ email, role }` → 이메일 소문자 정규화, 중복 방지 |
| 1.6 | 사용자 일괄 추가 | admin | `POST /api/users/bulk` | `{ users: [{ email, role?, realname?, phone? }] }` → 중복 스킵, 기본 역할 student |
| 1.7 | 사용자 목록 조회 | admin | `GET /api/users` | ADMIN_EMAIL 보호 플래그 포함 |
| 1.8 | 사용자 수정 | admin | `PATCH /api/users/:id` | 역할/실명/전화번호/활성 변경, ADMIN_EMAIL 강등·비활성화 방지, 마지막 활성 admin 강등·비활성화·삭제 방지 |
| 1.9 | 일괄 활성/비활성 | admin | `PATCH /api/users/bulk` | `{ ids, active }`, ADMIN_EMAIL 보호, 마지막 활성 admin 일괄 비활성화 방지 |
| 1.10 | 일괄 삭제 | admin | `DELETE /api/users/bulk` | `{ ids }`, ADMIN_EMAIL 보호 |
| 1.11 | 사용자 삭제 | admin | `DELETE /api/users/:id` | ADMIN_EMAIL 보호, 마지막 admin 삭제 방지 |

### 운영 연락처

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 1.12 | 연락처 조회 | official | `GET /api/ops-contacts` | official+ 사이드바에 표시, 사용자 realname/phone 반환 |
| 1.13 | 연락처 추가 | admin | `POST /api/ops-contacts` | `{ user_id }` → official 이상 사용자만 추가 가능 |
| 1.14 | 연락처 삭제 | admin | `DELETE /api/ops-contacts/:userId` | 사이드바 표시 목록에서 제거 |

### 내부 서비스 연동

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 1.15 | 사용자 존재 확인 | 내부 | `GET /api/users/exists/:email` | X-Internal-Service 헤더 필요, 200 또는 404 |
| 1.16 | 사용자 역할 조회 | 내부 | `GET /api/users/role/:email` | 역할 동기화용 |
| 1.17 | Forward Auth | 내부 | `GET /api/forward-auth` | Caddy → FileBrowser 프록시 인증, X-Forward-Auth-Key 헤더 |

### 로그

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 1.18 | 로그 집계 조회 | admin | `GET /api/admin/logs` | 전체 서비스 로그 수집(LOG_SERVICES), 서비스/레벨/액션/기간 필터, 페이지네이션 |

### 계정 신청

미등록 Google 계정이 신청 페이지에서 로그인하면 콜백이 `/auth/apply`로 리다이렉트하고 role 없는 1시간짜리 `fsk_applicant` 쿠키를 발급한다. 관리자가 승인하면 신청이 users로 이동한 뒤 삭제된다.

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 1.19 | 신청 접수 여부 | public | `GET /api/apply/config` | `applications_open` 토글 상태 |
| 1.20 | 내 세션/신청 상태 | public | `GET /api/apply/me` | 로그인됨 `{registered:true,...}` / 신청자 `{registered:false, application, applicationsOpen}` / 401 |
| 1.21 | 계정 신청 | public | `POST /api/apply` | `fsk_applicant` 쿠키 검증, `{realname, phone, affiliation}` 필수, 접수 열림 필요 |
| 1.22 | 신청 수정 | public | `PATCH /api/apply` | `fsk_applicant` 쿠키 검증, 접수 닫혀도 허용 |
| 1.23 | 신청 목록 | admin | `GET /api/applications` | 접수된 신청 목록 |
| 1.24 | 접수 on/off | admin | `PATCH /api/applications/config` | `applications_open` 토글 |
| 1.25 | 신청 승인 | admin | `POST /api/applications/approve` | 신청 → users 등록 후 신청 삭제, 완료 메일 발송 |
| 1.26 | 신청 삭제 | admin | `DELETE /api/applications` | 신청 반려/삭제 |

---

## 2. Entry 서비스

### 엔트리 관리

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 2.1 | 연도 목록 조회 | public | `GET /api/years` | entry_YYYY 테이블 스캔, 내림차순 |
| 2.2 | 엔트리 목록 조회 | public | `GET /api/entries?year=` | JSON 다운로드 (`?download` 파라미터) |
| 2.3 | 엔트리 추가 | admin | `POST /api/entries?year=` | `{ num, univ, team, type? }`, type은 해당 연도 vehicle_types에 존재해야 함 |
| 2.4 | 엔트리 수정 | admin | `PATCH /api/entries/:num?year=` | 번호 변경 시 리넘버링. durable lifecycle_outbox로 5개 서비스(queue/documents/inspection/score/traffic)에 재시도 팬아웃 — 동기화 대기분 있으면 202 `pending_lifecycle`. 번호 유지 + 팀명 변경이 모호하면 409 `{ ambiguous }` → `intent: retain|replacement`로 재요청 |
| 2.5 | 엔트리 삭제 | admin | `DELETE /api/entries/:num?year=` | 삭제 이벤트를 durable outbox로 5개 서비스에 재시도 팬아웃 (대기분 있으면 202) |
| 2.6 | 엔트리 전체 삭제 | admin | `DELETE /api/entries?year=` | 연도별 전체 초기화, 삭제 이벤트를 outbox로 5개 서비스에 팬아웃 |
| 2.7 | 엔트리 일괄 업로드 | admin | `POST /api/entries/bulk?year=` | JSON으로 전체 교체(트랜잭션), 삭제/리넘버 이벤트 outbox 팬아웃. 모호한 팀 교체는 409 → replacements/retains 재요청 |

### 차량 유형

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 2.8 | 차량 유형 조회 | public | `GET /api/vehicle-types?year=` | 연도별 차량 유형 목록, sort_order 순 |
| 2.9 | 차량 유형 추가 | admin | `POST /api/vehicle-types?year=` | `{ name, color? }`, UNIQUE 제약, color: blue/green/orange/purple/red/teal (기본 blue) |
| 2.10 | 차량 유형 수정 | admin | `PATCH /api/vehicle-types/:id?year=` | `{ name?, color? }`, 이름 변경 시 해당 연도 엔트리의 type도 갱신 |
| 2.11 | 차량 유형 삭제 | admin | `DELETE /api/vehicle-types/:id?year=` | 삭제 시 해당 연도 엔트리의 type=NULL로 갱신 |
| 2.12 | 엔트리 변경 실시간 알림 | admin | `GET /api/events` | 엔트리·차량 유형 변경 후 `entries` SSE로 의존 서비스의 스냅샷 무효화 |

---

## 3. Queue 서비스

### 공개 조회

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 3.1 | 활성 검차 조회 | public | `GET /api/active` | 활성화된 검차 유형 목록 |
| 3.2 | 대기 순위 확인 | public | `POST /api/state/:num` | 전화번호 검증 후 순위 반환, IP당 30req/min 제한 |
| 3.3 | 부스 현황 조회 | public | `GET /api/booths/:type` | 부스 점유 상태 |

### 대기열 관리 (official)

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 3.4 | 대기 등록 | chief | `POST /api/admin/register/:type` | 엔트리 검증(entry 서비스) → 활성 확인 → 페널티 확인 → 동시 등록 규칙(배터리+샤시 허용) → 삽입 → SSE (등록 시 SMS 미발송) |
| 3.5 | 대기 취소 | official | `POST /api/admin/cancel/:type` | 삭제 → 페널티 부과 → SSE → SMS (알림 순번에 새로 진입한 대기자에게) |
| 3.6 | 부스 입차 | official | `POST /api/admin/booths/:type/:boothNum/enter` | 큐에서 제거 → 부스 점유 → 로그 기록 → SSE → SMS |
| 3.7 | 부스 출차 | official | `POST /api/admin/booths/:type/:boothNum/exit` | 점유 해제 → 검사 이력 기록(재검 감지용) |
| 3.8 | 부스 활성 토글 | official | `PATCH /api/admin/booths/:type/:boothNum` | 점유 중 비활성화 방지 |
| 3.9 | 활성 페널티 조회 | official | `GET /api/admin/penalties` | 현재 연도에 적용 중인 취소 페널티 목록 |
| 3.10 | 페널티 취소 | official | `DELETE /api/admin/penalties/:type/:num` | 선택한 팀·검차의 적용 중인 취소 페널티 해제 |
| 3.11 | 페널티 취소 및 순번 복구 | official | `POST /api/admin/penalties/:type/:num/restore` | 페널티 해제 → 취소 당시 전화번호·접수시각으로 원래 정렬 위치 복구 → SSE |

### 설정 (chief)

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 3.12 | 우선순위 목록 조회 | chief | `GET /api/admin/priority/:type` | 검차별 팀 우선순위 정렬 목록 |
| 3.13 | 우선순위 설정 | chief | `POST /api/admin/priority/:type` | `{ num, priority }` |
| 3.14 | 우선순위 삭제 | chief | `DELETE /api/admin/priority/:type` | 개별 삭제 |
| 3.15 | 우선순위 전체 삭제 | chief | `DELETE /api/admin/priority/:type/all` | |
| 3.16 | 검사 이력 초기화 | chief | `DELETE /api/admin/history/:type` | 초검/재검 구분 초기화 |
| 3.17 | 정렬 규칙 토글 | chief | `PUT /api/admin/inspection/:type/ignore` | 우선순위/초검재검 무시 플래그 |
| 3.18 | 부스 수 설정 | chief | `PATCH /api/admin/booths/:type/config` | 점유 중 부스 축소 방지 |
| 3.19 | 검차 활성 토글 | chief | `PATCH /api/admin/inspection/:type` | SSE 브로드캐스트 |
| 3.20 | 검차 표시 토글 | chief | `PATCH /api/admin/inspection/:type/visibility` | 등록 페이지 노출 제어 |
| 3.21 | 취소 페널티 설정 | chief | `PATCH /api/admin/settings/cancel-penalty` | 0~60분 |

### SMS 설정

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 3.22 | SMS 토글 | chief | `PATCH /api/admin/settings/sms` | 환경변수 필요 |
| 3.23 | SMS 알림 순번 조회 | official | `GET /api/admin/settings/sms-rank` | |
| 3.24 | SMS 알림 순번 설정 | chief | `PATCH /api/admin/settings/sms-rank` | 1~10 |

### 통계

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 3.25 | 기간 조회 | official | `GET /api/admin/stats/timerange` | |
| 3.26 | 전체 팀 통계 | official | `GET /api/admin/stats` | 등록/취소/입차 횟수, 총 점유 시간 |
| 3.27 | 팀별 타임라인 | official | `GET /api/admin/stats/:num` | 이벤트 타임라인 + 요약 |

### 추가 조회 및 실시간

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 3.28 | 전체 부스 현황 조회 | public | `GET /api/booths/all` | 모든 검차 유형의 부스 상태 일괄 조회 |
| 3.29 | 전체 검차 목록 조회 | official | `GET /api/admin/all` | 비활성 포함 전체 검차 유형 목록 |
| 3.30 | 대기열 조회 | official | `GET /api/admin/inspection/:type` | 정렬된 대기열 목록 (우선순위/초검·재검/시간순) |
| 3.31 | 부스 목록 조회 | official | `GET /api/admin/booths/:type` | 검차별 부스 설정 및 점유 현황 |
| 3.32 | SMS 설정 조회 | official | `GET /api/admin/settings/sms` | SMS 활성화 상태 반환 |
| 3.33 | 취소 페널티 조회 | official | `GET /api/admin/settings/cancel-penalty` | 현재 페널티 시간(분) 반환 |
| 3.34 | SSE 실시간 업데이트 | public | `GET /api/events` | 검차 활성 상태, 대기열, 부스, 페널티 목록 변경 실시간 스트림. 공개 스트림의 `penalties` 이벤트는 상세 정보 없이 재조회 신호만 전달 |

### 내부 서비스 연동

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 3.35 | 엔트리 삭제 연동 | 내부 | `DELETE /api/internal/team/:num?year=` | 대기열, current, 우선순위, 페널티, 이력, 부스 점유 해제 |

---

## 4. Inspection 서비스

### 템플릿 관리

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 4.1 | 템플릿 조회 | official | `GET /api/sheet/template?year=` | 4단계 계층 트리: 카테고리 > 소분류 > 그룹 > 항목 |
| 4.2 | 노드 추가 | chief | `POST /api/sheet/template` | level, parent_id, answer_type(passfail/number/text/checktable), unit, pdf_include, excluded_types |
| 4.3 | 노드 수정 | chief | `PUT /api/sheet/template/:id` | 이전 연도 수정 방지 |
| 4.3a | 카테고리 표시 유형 설정 | chief | `PUT /api/sheet/template/:id` (`excluded_types`) | 카테고리별로 차량 유형 체크박스. 체크 해제한 유형 **이름**을 제외 목록에 저장하므로 기본은 전체 표시이고, 유형을 새로 추가하면 기존 카테고리에 자동 표시된다 |
| 4.4 | 노드 삭제 | chief | `DELETE /api/sheet/template/:id` | FK 캐스케이드로 하위 + 답변 삭제 |
| 4.5 | 순서 변경 | chief | `POST /api/sheet/template/reorder` | 일괄 sort_order 갱신 |
| 4.6 | 연도간 복사 | chief | `POST /api/sheet/template/copy` | 대상 연도 비어있어야 함, parent_id 리맵핑 |
| 4.7 | JSON 가져오기 | chief | `POST /api/sheet/template/import` | 중첩 JSON → 기존 삭제 후 일괄 삽입 |
| 4.8 | JSON 내보내기 | official | SheetTemplate.vue | 전체 템플릿 계층 구조 JSON 파일로 다운로드 (클라이언트사이드) |

### 검차 시트 작성

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 4.9 | 요약 대시보드 | official | `GET /api/sheet/summary?year=` | 전체 팀 × 카테고리 PASS/FAIL 매트릭스. 카테고리 열은 유형이 섞인 목록에서 공유하므로 유지하고, 해당 유형에 표시하지 않는 카테고리는 그 팀의 칸만 비운다(성적표도 동일) |
| 4.9a | 팀 시트 카테고리 필터 | official | SheetDetail.vue | 팀의 `entry.type`이 카테고리 `excluded_types`에 있으면 탭을 완전히 숨긴다. 유형 미지정 팀은 전체 표시. 탭 번호는 템플릿 원본 순서를 유지해 인쇄된 시트와 어긋나지 않는다 |
| 4.10 | 답변 일괄 조회 | official | `GET /api/sheet/bulk-answers?year=&item_ids=` | 특정 항목들의 전체 팀 답변 |
| 4.11 | 팀 시트 조회 | official | `GET /api/sheet/data/:year/:num` | 답변, 카테고리 결과, 검사자 |
| 4.12 | 답변 입력 | official | `PUT /api/sheet/answer` | 문항별 version UPSERT, stale base_version은 409, versioned SSE 브로드캐스트 |
| 4.13 | 메모 입력 | official | `PUT /api/sheet/memo` | 답변과 독립된 memo version UPSERT, stale base_version은 409, versioned SSE 브로드캐스트 |
| 4.14 | 카테고리 결과 설정 | official | `PUT /api/sheet/category-result` | PASS/FAIL/"", SSE 브로드캐스트 |
| 4.15 | 검사자 지정 | official | `PUT /api/sheet/inspector` | UPSERT, SSE 브로드캐스트 |

### 실시간 및 인쇄

| # | 흐름 | 역할 | API/컴포넌트 | 설명 |
|---|------|------|-------------|------|
| 4.16 | SSE 실시간 업데이트 | official | `GET /api/sheet/events` | 답변, 메모, 카테고리 결과, 검사자 변경 실시간 스트림 |
| 4.17 | 검차 시트 인쇄 | official | SheetTemplatePrint.vue | `/template/print?year=` 라우트, 브라우저 인쇄 기능으로 PDF 출력 |

---

## 5. Traffic 서비스

### 경기 기록

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 5.1 | 기록 테이블 목록 | admin | `GET /api/records` | |
| 5.2 | 기록 조회 | admin | `GET /api/records/:name` | rowid, time, num, univ, team, type, result, detail, cones, oc, invalidated, scoreboard |
| 5.3 | 기록 추가 | admin | `POST /api/records` | 테이블명 자동 접두사 "FSK {year} ", 미존재 시 CREATE TABLE, SSE |
| 5.4 | 기록 필드 수정 | admin | `PATCH /api/records/:name/:rowid` | invalidated/scoreboard/detail/cones/oc/result(정수, -1=DNF), 무효화↔전광판 연동, SSE |
| 5.5 | 기록 테이블 삭제 | admin | `DELETE /api/records/:name` | DROP TABLE, SSE |
| 5.5a | 성적 반영 여부 조회/토글 | admin | `GET /api/records/visibility`, `PUT /api/records/:name/visibility` | 기록 파일별 성적 반영(visibility) 토글, `record-visibility` SSE |
| 5.5b | 연도별 기록 일괄 조회 | admin | `GET /api/records/year/:year` | visibility 필터 적용, score 집계용 |
| 5.6 | 전광판 조회 | admin | ScoreboardView.vue | scoreboard=true 레코드 필터링, SSE 실시간 갱신, 종목별 최신/최고/상위 5 기록 |

### 컨트롤러 데이터

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 5.7 | 컨트롤러 로그 조회 | admin | `GET /api/controllers` | |
| 5.8 | 컨트롤러 로그 업로드 | admin | `POST /api/controllers` | 시리얼 하드웨어 상태 저장 |
| 5.9 | 컨트롤러 로그 전체 삭제 | admin | `DELETE /api/controllers` | |

### 경기 모드

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 5.10 | 경기 모드 조회 | admin | `GET /api/event-modes` | 가속/스키드패드/오토크로스/내구 (`EVENT_TYPES`) |
| 5.11 | 경기 모드 토글 | admin | `PUT /api/event-modes/:type` | 비활성 시 네비게이션/성적 테이블에서 숨김, SSE |

### 무선(LoRa) 계측

마스터 노드에 USB로 연결된 브리지 PC가 센서 raw 이벤트·진단·신호등 상태를 서버로 push하고, 서버가 권위 상태(경기별 세션: arm·팀/이벤트 선택·신호등·lease)를 보유해 모든 admin 클라이언트가 SSE로 동일하게 본다. 경기 기록은 **서버 기록 엔진**이 ingest 이벤트로 직접 계산·저장한다(가속·오토크로스=출발→도착, 스키드패드=lap2+lap4, 내구=랩 누적 총합 1건). 테이블: `wireless_event`(멱등 raw 이벤트), `wireless_mapping`(센서→경기·역할), `wireless_light`(신호등·debounce·owner_event), `wireless_session`(경기별 arm/선택/lease). 모든 엔드포인트 admin (단 `/api/time`은 public).

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 5.18 | 브리지 배치 ingest | admin | `POST /api/wireless/ingest` | events/telemetry 배치(각 ≤200). `(node_id, ev_seq, master_tick)` 멱등. 신규 이벤트는 기록 엔진 거쳐 armed 경기 기록 자동 저장(`records` 브로드캐스트). 보안 관측(`sec_drop`/`provisioned=0`) 시 `wireless.security` 로그. `wireless:event`/`wireless:telemetry`/`wireless:bridge` SSE |
| 5.19 | 신호등 상태 보고 | admin | `POST /api/wireless/light` | 브리지가 물리 신호등 색 보고, `wireless:light` SSE |
| 5.20 | 실제 신호등 경기 지정 | admin | `PUT /api/wireless/physical-event` | SSR 물리 신호등을 사용할 경기(owner_event) 지정, null=전부 가상 |
| 5.21 | 디바운스 설정 | admin | `PUT /api/wireless/debounce` | 센서 디바운스 창(0~5000ms, 기본 300) 저장·공유 |
| 5.22 | 센서 매핑 | admin | `GET/PUT/DELETE /api/wireless/mapping[/:node_id]` | 센서→경기·역할(start/finish/lane1~9) upsert, `wireless:mapping` SSE |
| 5.23 | 경기 arm/disarm | admin | `POST /api/wireless/arm` | green=arm(기록 엔진 런 리셋)/red/off. lease 점유자 있으면 409. `wireless:session` SSE |
| 5.24 | 팀·이벤트 선택 | admin | `POST /api/wireless/select` | 경기에 팀/이벤트명 귀속(검증), lease 점유자만, `wireless:session` SSE |
| 5.25 | DNF 저장 | admin | `POST /api/wireless/dnf` | 진행 경기 DNF(result -1) 저장, lease 점유자만 |
| 5.26 | 물리 신호등 원격 제어 | admin | `POST /api/wireless/command` | 서버→브리지(`wireless:command`)→시리얼 다운링크. 물리 지정 경기+브리지 online+lease 필요 |
| 5.27 | 독점 제어 lease | admin | `POST/DELETE /api/wireless/lease/:event` | 경기별 독점 제어권 획득/갱신(heartbeat)/해제(admin 강제 회수), `wireless:session` SSE |
| 5.28 | 종합 스냅샷/백필 | admin | `GET /api/wireless/state`, `GET /api/wireless/events?since=` | 신선 로드용 스냅샷, 늦게 합류한 클라의 raw 이벤트 백필 |
| 5.29 | 서버 시각 동기화 | public | `GET /api/time` | 서버 epoch ms 반환, 클라 라이브 클럭 오프셋 추정(인증 면제) |
| 5.30 | 브리지 오프라인 즉시 보고 | admin | `POST /api/wireless/bridge/offline` | 종료 직전 오프라인 보고(15초 무수신 감지 대기 없이) |

### 매뉴얼 모드 (프런트엔드)

| # | 흐름 | 역할 | 컴포넌트 | 설명 |
|---|------|------|----------|------|
| 5.12 | 가속 측정 | admin | StartFinishView | 매뉴얼 모드 → 녹색등 → 센서1(출발) → 센서2(도착) → 자동 저장 |
| 5.13 | 스키드패드 측정 | admin | SkidpadView | 센서1 × 4회 → lap2 + lap4 합산 저장 |
| 5.14 | 오토크로스 측정 | admin | StartFinishView | 매뉴얼 모드 → 녹색등 → 센서1(출발) → 센서2(도착) → 자동 저장 (가속과 동형) |

### 실시간 및 내보내기

| # | 흐름 | 역할 | API/컴포넌트 | 설명 |
|---|------|------|-------------|------|
| 5.16 | SSE 실시간 업데이트 | admin | `GET /api/events` | 기록 추가/수정/삭제, 성적 반영 토글, 경기 모드 변경, 무선(`wireless:*`) 실시간 스트림. init: `{ recordFiles, eventModes, recordVisibility, wireless }` |
| 5.17 | 기록 CSV/XLSX 내보내기 | admin | RecordView.vue | 클라이언트 사이드에서 선택된 기록 테이블을 CSV/XLSX로 다운로드 |

---

## 6. Score 서비스

### 성적 집계

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 6.1 | 성적 대시보드 조회 | admin | `GET /api/score?year=` | entry + inspection + traffic + endurance/에너지 자동점수 + 수동점수 + 페널티/점수 설정 집계 |
| 6.2 | 수동 점수 입력 | admin | `PUT /api/score/manual` | 보고서/가점/감점, SSE. 에너지는 수동 입력 불가 |

### 페널티·점수 설정

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 6.3 | 페널티 설정 | admin | `PUT /api/score/penalty` | 종목별 콘터치/코스이탈/출발지연 (초) |
| 6.4 | 점수 설정 | admin | `PUT /api/score/setting` | 종목별 총점/완주점수/컷오프%, 보고서·에너지 총점, 에너지 거리/연료 환산 기준 |

### 내구

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 6.5 | 내구 기록 조회 | admin | `GET /api/score/endurance?year=` | 팀별 드라이버1·2 시간, 페널티, 상태, 에너지 계측값·오피셜 판정. C/E 구분은 엔트리 차량 유형에서 자동 판별 |
| 6.6 | 내구 필드 수정 | admin | `PUT /api/score/endurance` | 내구 필드와 연료 소비/추가 주유/순사용 전력/에너지 DSQ 수정, SSE 후 엔트리의 `C-Formula`/`E-Formula` 유형에 따라 전체 상대점수 재계산 |

### 실시간 및 내보내기

| # | 흐름 | 역할 | API/컴포넌트 | 설명 |
|---|------|------|-------------|------|
| 6.7 | SSE 실시간 업데이트 | admin | `GET /api/score/events` | 화이트리스트 재전파(entry: entries, inspection: category-result/answer, traffic: records/record-visibility/event-mode) + 재연결 시 refresh + manual-score/penalty/setting/endurance 로컬 이벤트 |
| 6.8 | 성적 대시보드 내보내기 | admin | ScoreBoard.vue | 전체 성적표 CSV/XLSX 클라이언트 사이드 다운로드 |
| 6.9 | 내구 데이터 내보내기 | admin | EnduranceInput.vue | 내구 및 에너지 계측·판정 데이터 CSV/XLSX 클라이언트 사이드 다운로드 |

---

## 7. Documents 서비스

### 학생 흐름

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 7.1 | 세션 목록 조회 | student | `GET /api/sessions` | student_team에서 팀 조회 → 해당 팀 세션 + 최근 제출 상태 |
| 7.2 | 세션 상세 조회 | student | `GET /api/sessions/:id` | 팀 소속 확인, 제출 이력 + 파일 목록 |
| 7.3 | 파일 제출 | student | `POST /api/sessions/:id/submit` | 멀티파트, 시간 검증(start~late_end), 확장자 검증, 용량 제한 검증(max_file_size), 이전 제출 교체, 최대 100파일 |
| 7.4 | 제출 파일 다운로드 | student | `GET /api/submissions/:subId/files/:fileId` | 팀 소속 확인, 경로 순회 방지 (PDF/텍스트/이미지/AV inline, 그 외 attachment) |
| 7.4a | 제출물 zip 다운로드 | student | `GET /api/submissions/:subId/zip` | 자기 팀 제출물 전체 zip |

### 관리자 흐름

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 7.5 | 전체 세션 목록 | chief | `GET /api/admin/sessions?year=` | 연도 필터 |
| 7.6 | 세션 생성 | chief | `POST /api/admin/sessions` | 이름, 공지, 시작/마감/지각마감, 파일 제한, 확장자, 대상 팀 |
| 7.7 | 세션 수정 | chief | `PUT /api/admin/sessions/:id` | 팀 변경 시 제거된 팀의 제출 + 파일 삭제 |
| 7.8 | 세션 삭제 | chief | `DELETE /api/admin/sessions/:id` | FK 캐스케이드, 파일 디렉토리 정리 |
| 7.9 | 제출 현황 조회 | chief | `GET /api/admin/sessions/:id/status` | 팀별 제출/미제출/지각 상태 (`submissionCount` 누적 제출 횟수, 직전 1건 `prevSubmission`) |
| 7.10 | 관리자 파일 다운로드 | chief | `GET /api/admin/submissions/:subId/files/:fileId` | 팀 소속 확인 없이 다운로드 |
| 7.10a | 제출물 zip 다운로드 | chief | `GET /api/admin/submissions/:subId/zip` | 단일 제출물 zip (팀 라벨 포함 파일명) |
| 7.10b | 세션 아카이브 | chief | `GET /api/admin/sessions/:id/archive` | 세션 전체 아카이브 zip (팀별 폴더, 팀별 최신 제출) |
| 7.10c | 연도 아카이브 | chief | `GET /api/admin/years/:year/archive` | 연도 전체 아카이브 zip (세션/팀별 폴더) |
| 7.10d | 연도 파일 삭제 | chief | `DELETE /api/admin/years/:year/files` | 연도별 파일 데이터 삭제(제출 기록은 유지), `{ sessions, files }` |

### 학생-팀 매핑

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 7.11 | 학생 목록 조회 | chief | `GET /api/admin/students` | auth 서비스에서 student 목록 조회 |
| 7.12 | 매핑 목록 조회 | chief | `GET /api/admin/student-teams?year=` | |
| 7.13 | 매핑 추가 | chief | `POST /api/admin/student-teams` | `{ email, team_num, year }`, 팀당 1명 |
| 7.14 | 매핑 삭제 | chief | `DELETE /api/admin/student-teams/:email/:year` | |

### 내부 서비스 연동

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 7.15 | 엔트리 번호 동기화 | 내부 | `PATCH /api/internal/team-num` | entry 서비스에서 번호 변경 시 student_team, session_team, submission + 파일 디렉토리 일괄 갱신. 파일 작업 실패 시 202 `pending_file_work` → 30초 주기 백그라운드 워커 재시도 |
| 7.16 | 엔트리 삭제 연동 | 내부 | `DELETE /api/internal/team/:num?year=` | student_team, session_team, submission, 파일 삭제 |

---

## 8. Course 서비스

RTK GPS 기반 코스 콘 위치 관리 + 로버 원격 운용. **코스/콘/메모 CRUD와 SSE(`/api/events`)는 chief**, **스냅샷·코스 삭제·로버 운용·GPS는 admin**, **로버/수신기 기기 인입 엔드포인트는 `X-Internal-Service`(INTERNAL_SECRET) 검증**(admin JWT로도 불가한 internal-strict, 또는 internal/admin 겸용).

### 코스 관리 (chief)

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 8.1 | 코스 목록 조회 | chief | `GET /api/courses` | 전체 코스 목록 + 콘 개수 반환 |
| 8.2 | 코스 생성 | chief | `POST /api/courses` | `{ name }` → UNIQUE 제약 |
| 8.3 | 코스 이름 수정 | chief | `PATCH /api/courses/:id` | `{ name }` → 중복 이름 방지 |
| 8.3a | 진행 방향/시작 콘 설정 | chief | `PATCH /api/courses/:id/direction` | `{ reverse?, start_cone_id? }` 저장, `courses`(type=direction) SSE |
| 8.3b | 코스 내보내기/가져오기 | chief | `GET /api/courses/:id/export`, `POST /api/courses/import` | 코스+콘 JSON 다운로드 / JSON으로 일괄 생성(트랜잭션) |
| 8.4 | 코스 삭제 | **admin** | `DELETE /api/courses/:id` | CASCADE로 콘·스냅샷 함께 삭제 (파괴적이라 admin) |

### 콘 관리 (chief)

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 8.5 | 콘 목록 조회 | chief | `GET /api/courses/:id/cones` | 특정 코스의 콘 목록 |
| 8.6 | 콘 추가 | chief | `POST /api/courses/:id/cones` | `{ lat, lng, alt?, side }` side: "left"\|"center"\|"right" |
| 8.7 | 콘 수정 | chief | `PATCH /api/cones/:id` | 위치(lat, lng) 또는 방향(side) 변경 |
| 8.8 | 콘 삭제 | chief | `DELETE /api/cones/:id` | 단일 콘 삭제 |
| 8.8a | 콘 전체 삭제 | chief | `DELETE /api/courses/:id/cones` | 코스의 콘 일괄 삭제 |

### 메모 스티커 (chief)

지도 주석 메모. 중심 좌표(lat/lng) + 실측 크기(width/height, m) + 회전(rotation, deg)로 지리 좌표에 고정된다(줌/회전에도 코스 위 같은 자리). course 삭제 시 CASCADE.

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 8.8b | 메모 목록 조회 | chief | `GET /api/courses/:id/memos` | 코스의 메모 목록 |
| 8.8c | 메모 추가 | chief | `POST /api/courses/:id/memos` | `{ lat, lng, width, height, rotation?, content? }` (width/height 0 초과 100000 m 이하, content ≤5000자), `memos` SSE |
| 8.8d | 메모 수정 | chief | `PATCH /api/memos/:id` | 이동/크기/회전/내용 변경, `memos` SSE |
| 8.8e | 메모 삭제 | chief | `DELETE /api/memos/:id` | 단일 메모 삭제, `memos` SSE |

### 코스 스냅샷 (admin)

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 8.8f | 스냅샷 목록 | admin | `GET /api/courses/:id/snapshots` | 코스 스냅샷 목록(최신 100) |
| 8.8g | 스냅샷 저장 | admin | `POST /api/courses/:id/snapshots` | 현재 콘 상태 스냅샷(콘 없으면 400) |
| 8.8h | 스냅샷 복원 | admin | `POST /api/courses/:id/snapshots/:sid/restore` | 콘 상태 복원 — **복원 직전 자동 스냅샷**(안전망), 시작 콘 초기화 |
| 8.8i | 스냅샷 삭제 | admin | `DELETE /api/courses/:id/snapshots/:sid` | 스냅샷 삭제 |

### Rover GPS 연동

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 8.9 | 기기 SSE 연결 | 내부 (INTERNAL_SECRET) | `GET /api/rover/stream?device=gps\|rover` | 로버·GPS 수신기가 서버에 SSE 연결 유지, 명령 이벤트 수신 대기. `device=gps`는 수신기 **별도 슬롯**(로버와 동시 연결, 서로 안 밀어냄). X-Internal-Service 필수(admin JWT 불가) |
| 8.10 | 기기 위치 전송 | 내부/admin | `POST /api/rover/position?device=gps\|rover` | 기기가 현재 좌표 전송. `request_id` 있으면 좌표 요청 해소, 활성 소스일 때만 `rover` 라이브 이벤트 브로드캐스트 |
| 8.11 | 로버 좌표 요청 | admin | `POST /api/rover/request` | 관리자 버튼 클릭 → 서버가 로버에 SSE 이벤트 전송 → 로버 응답 대기 (5초 타임아웃) |
| 8.12 | 로버/수신기 좌표로 콘 등록 | admin | 8.11 → 8.6 | 좌표 수신(수신기 연결 시 우선, 없으면 로버) 후 현재 선택된 방향(L/R)으로 콘 등록 (프론트엔드 연동) |

### GPS 수신기 — 소스 선택 + base station 측량점 (admin)

콘 좌표 캡처는 GPS 수신기(연결 시) 우선, 없으면 로버 사용. 로버의 RTK 보정 소스는 NGII(공용 NTRIP)와 **수신기 base station**(측량점에 고정한 수신기가 RTCM3 생성 → 서버 릴레이 → 로버) 중 선택. 수신기의 "캡처 소스"·"base station" 역할은 상호배타.

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 8.12a | GPS 소스 설정 조회/변경 | admin | `GET/PUT /api/gps/config` | `ntrip_source`(ngii\|base)·`active_base_point_id`. base면 측량 완료된 점 필수, 수신기에 `base-activate`/`base-stop`·로버에 `ntrip-source` 즉시 전송 |
| 8.12b | 측량점 관리 | admin | `GET/POST/DELETE /api/gps/survey-points[/:id]` | 측량점 추가(이름만)·목록·삭제. 활성 base 삭제 시 409 |
| 8.12c | 측량 시작/취소 | admin | `POST /api/gps/survey-points/:id/survey[/cancel]` | 수신기 측량(NGII rtk_fixed 위치 평균, duration 10~1800s). 미연결 503, base 모드 409. 수신기가 `base/survey-result`로 결과 보고 → `gps:survey_result` 브로드캐스트 |
| 8.12d | base RTCM 릴레이 | 내부 | `POST /api/rover/base/rtcm`, `POST /api/rover/base/survey-result` | 수신기(base)가 RTCM3 청크·측량 결과 전송 → 로버로 SSE `rtcm` 릴레이(로버 미연결이면 드롭) |

### 로버 제어

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 8.13 | 경로 계산 | admin | 프론트엔드 | 시작점 클릭 → Nearest Neighbor TSP + 2-opt 최적화 (회전 페널티 포함) → 지도에 polyline + S/E 마커 + 예상 거리 표시 |
| 8.14 | 경로 실행 | admin | `POST /api/rover/execute` | 계산된 waypoint 배열을 로버에 SSE `execute-path` 이벤트로 전송. body에 `course_id` 있으면 실행 직전 자동 스냅샷(best-effort). 현재 EMERGENCY_STOP 래치 상태면 409 거부 |
| 8.15 | 비상정지 | admin | `POST /api/rover/stop` | 로버에 SSE `emergency-stop` 이벤트 즉시 전송. 미션 레코드는 보존 |
| 8.15a | 비상정지 해제 | admin | `POST /api/rover/clear-emergency` | SSE `clear-emergency` 이벤트. 보존된 미션이 그대로 남아 "이어서 실행" 가능 |
| 8.15b | 미션 종료 | admin | `POST /api/rover/end-mission` | 보존된 미션을 명시적으로 마감 (운영자가 path 폐기 시 자동 호출) |
| 8.16 | 수동 제어 | admin | `POST /api/rover/control` | 조이스틱 UI로 throttle/steering(-100~100) 50ms 간격 전송, SSE `manual-control` 이벤트 |

### 카메라 & VR 텔레오퍼레이션

저지연 카메라는 WebRTC(H.264, `mediamtx` 릴레이, WHIP/WHEP)가 기본 경로이고 MJPEG은 폴백이다. 로버 perception이 두 스트림을 publish한다: `rover-2d`(모노/깊이 컴포지트), `rover-vr`(스테레오 SBS). 각 스트림은 해당 뷰어가 있을 때만 인코딩된다(`camera/control` SSE의 `webrtc-2d-on`/`webrtc-vr-on`/`mjpeg-on` 게이팅).

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 8.18 | 2D 라이브 카메라 | admin | `GET /api/rover/camera/hold?mode=2d` + WHEP `rover-2d` | 카메라 버튼(로버 미연결 시 비활성, 항상 표시) → WebRTC로 **직행**. hold SSE가 로버에 `webrtc-2d-on`을 걸어 publish 시작, 브라우저는 `/course/api/rtc/rover-2d/whep`로 재생. 8초 내 미연결/드롭 시에만 MJPEG(`/api/rover/camera/stream`) 폴백. 같은 줄의 VR 버튼은 `/vr`로 이동(로버 미연결에도 활성) |
| 8.19 | 깊이 맵(거리맵) | admin | `POST /api/rover/camera/depth` | 카메라 버튼이 세 모드를 순환: 꺼짐 → 일반 2D → 깊이 오버레이 → 꺼짐(별도 버튼 없음). 양안 깊이 컴포지트를 로버가 렌더해 `rover-2d`(및 MJPEG)로 송출. 2D 뷰어(MJPEG 또는 WebRTC hold)가 있어야 적용, 마지막 2D 뷰어 이탈 시 자동 해제 |
| 8.20 | VR 텔레오퍼레이션 | admin | `/vr` (WebXR) + `GET /api/rover/camera/hold?mode=vr` + WHEP `rover-vr` | WebXR 헤드셋에서 스테레오 SBS를 눈별 분할 재생. 오른쪽 스틱(Y=throttle, X=steering) 수동 주행, 트리거=펌프, A=비상정지 토글, B=재개. 헤드-락 전투기식 HUD(배터리·속도·GPS 상태/좌표·throttle/steering·링크 상태) + 컴포트 비네트. 화면 왼쪽에 로버 중심 미니맵(`/api/rover/map-tile` 위성 타일, `rover:status` 위치 실시간), 왼쪽 컨트롤러 X/Y로 미니맵 줌 |
| 8.21 | 장애물 자동 팝오픈 | admin | (프론트) `rover:obstacle` SSE | 주행 중 장애물 감지 브로드캐스트 수신 시 2D 카메라 패널을 자동으로 열어 운영자가 즉시 확인 |

### SSE 실시간 동기화

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 8.17 | SSE 연결 | admin | `GET /api/events` | 연결 시 `init` 이벤트로 코스 목록 전송, 이후 `courses`/`cones`/`rover` 이벤트 브로드캐스트 |

---

## 9. Calendar 서비스

대회 일정 관리. 조회는 public(role 기반 필터링), CUD는 chief+.

### 일정 관리

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 9.1 | 일정 목록 조회 | public | `GET /api/events` | `timeMin`~`timeMax` 범위의 이벤트 조회, 사용자 role에 따라 필터링 |
| 9.2 | 일정 생성 | chief | `POST /api/events` | `{ title, start, end, description?, location?, allDay?, role? }` → 이벤트 생성, role 기본값 "official" |
| 9.3 | 일정 수정 | chief | `PUT /api/events/:id` | 이벤트 내용 수정 |
| 9.4 | 일정 삭제 | chief | `DELETE /api/events/:id` | 이벤트 삭제 |

### 구독

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 9.5 | iCal 구독 URL 조회 | student | `GET /api/events/subscribe` | 사용자 role 기반 서명된 iCal 구독 URL 반환 |
| 9.6 | iCal 피드 | public | `GET /api/events/ical` | `?role=&sig=` HMAC-SHA256 서명 검증 후 role 기반 필터링된 iCalendar 피드 반환 |

### 프론트엔드 뷰

- **월간 뷰** (month-grid): 달력 형태로 일정 표시, 날짜 클릭 시 일정 추가 (chief+)
- **리스트 뷰** (month-agenda): 리스트 형태로 일정 표시, 모바일 기본 뷰
- 이벤트 클릭 시 상세/편집 모달 (chief+만 편집 가능)

---

## 10. Email 서비스

이메일/SMS 관리 서비스. Brevo API로 이메일, Naver Cloud SENS로 SMS 전송. 설정 관리는 admin, 내부 서비스 연동은 X-Internal-Service 헤더로 인증.

### 이메일 전송

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 10.1 | 이메일 전송 | admin | `POST /api/send` | `{ subject, htmlContent, recipients[] }` → Brevo API로 개별 전송, 수신자별 성공/실패 로깅 |
| 10.2 | 내부 이메일 전송 | 내부 | `POST /api/internal/send` | 다른 서비스(auth, documents)에서 호출, `source` 필드로 발신 서비스 식별 |
| 10.3 | 테스트 이메일 | admin | `POST /api/test-email` | `{ recipient }` → 단일 수신자에게 테스트 메일 전송, Brevo 설정 검증용 |
| 10.4 | 테스트 SMS | admin | `POST /api/test-sms` | `{ recipient }` → 단일 수신자에게 테스트 SMS 전송, Naver Cloud 설정 검증용 |

### 설정

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 10.5 | 설정 조회 | admin | `GET /api/config` | Brevo/SMS 설정 조회, 민감 키는 마스킹 (`****`) |
| 10.6 | 설정 변경 | admin | `PUT /api/config` | `{ key, value }[]` 일괄 저장, 마스킹된 값은 스킵 |
| 10.7 | 설정 초기화 | admin | `POST /api/config/reset` | `{ group }` → brevo/sms 그룹별 설정 초기화 |
| 10.8 | 이메일 활성/비활성 | admin | `PUT /api/config` | `email_enabled` 키로 전체 이메일 전송 토글 (FALSE 시 503) |

### 전송 기록 및 통계

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 10.9 | 전송 기록 조회 | admin | `GET /api/emails` | `?page=&limit=` 페이지네이션, 최신순 |
| 10.10 | 수신자 기록 조회 | admin | `GET /api/emails/:emailId/recipients` | 이메일별 수신자 목록 및 개별 전송 상태 |
| 10.11 | 통계 조회 | admin | `GET /api/stats` | 오늘/전체 전송 건수, 성공/실패 집계 |

### 내부 서비스 연동

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 10.12 | SMS 설정 조회 | 내부 | `GET /api/internal/sms-config` | Queue 서비스에서 SMS 발송용 설정(access key, secret, service ID, sender) 조회 |

---

## 11. 서비스 간 연동 흐름

### Score 집계 체인

```
Score → Entry: 엔트리 목록 조회
Score → Inspection: 카테고리 결과 + 템플릿(코너 웨이트 항목) 조회
Score → Traffic: 기록 + 경기 모드 조회
Score → Score DB: 내구, 수동 점수, 페널티/점수 설정
```

Score 서비스는 entry, inspection, traffic의 SSE 엔드포인트를 구독하여 변경사항을 실시간으로 재전파합니다 (`entry:*`, `inspection:*`, `traffic:*` 접두사).

### Queue 엔트리 검증

```
Queue → Entry: POST /api/admin/register 시 엔트리 존재 확인
```

### Auth 사용자 검증

```
모든 비-auth 서비스 → Auth: JWT 검증 시 AUTH_SERVER로 역할 동기화
```

Fail-close 방식: auth 서비스 무응답 또는 에러 시 세션 무효화.

### Auth 로그 집계

```
Auth → Entry, Queue, Inspection, Traffic, Score, Documents, Calendar, Course, Email: /api/logs 엔드포인트로 로그 수집
```

### Documents 학생 조회

```
Documents → Auth: GET /api/admin/students로 학생 목록 조회
```

### Email 연동

```
Auth → Email: POST /api/internal/send (계정 등록 알림)
Documents → Email: POST /api/internal/send (서류 제출 알림, 마감 알림, 미제출 알림, 열린 세션 알림)
Queue → Email: GET /api/internal/sms-config (SMS 설정 조회, 5분 주기 갱신)
```

### Entry → Documents 팀 번호 동기화

```
Entry → 5개 서비스: 번호 변경을 durable lifecycle_outbox에 기록 후 queue/documents/inspection/score/traffic의 PATCH /api/internal/team-num으로 재시도 전달 (실패분은 dead-letter → /api/admin/lifecycle-outbox에서 복구)
```

### Entry 삭제 → Queue/Documents 정리

```
Entry → 5개 서비스: 삭제 이벤트를 durable outbox에 기록 후 queue/documents/inspection/score/traffic의 DELETE /api/internal/team/:num으로 재시도 전달
Documents는 student_team/session_team/submission/파일까지 정리
```
