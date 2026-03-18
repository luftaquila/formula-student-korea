# 비즈니스 흐름 문서

전체 7개 서비스의 비즈니스 흐름을 서비스별로 정리한 문서입니다.

> **공통 엔드포인트**: 모든 7개 서비스는 `GET /api/health` (public, 헬스체크)와 `GET /api/logs` (admin, 로컬 서비스 로그 조회) 엔드포인트를 공통으로 노출합니다.

## 목차

- [1. Auth 서비스](#1-auth-서비스)
- [2. Entry 서비스](#2-entry-서비스)
- [3. Queue 서비스](#3-queue-서비스)
- [4. Inspection 서비스](#4-inspection-서비스)
- [5. Traffic 서비스](#5-traffic-서비스)
- [6. Score 서비스](#6-score-서비스)
- [7. Documents 서비스](#7-documents-서비스)
- [8. 서비스 간 연동 흐름](#8-서비스-간-연동-흐름)

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
| 1.6 | 사용자 일괄 추가 | admin | `POST /api/users/bulk` | `{ users: [{ email, role?, memo? }] }` → 중복 스킵, 기본 역할 student |
| 1.7 | 사용자 목록 조회 | admin | `GET /api/users` | ADMIN_EMAIL 보호 플래그 포함 |
| 1.8 | 사용자 수정 | admin | `PATCH /api/users/:id` | 역할/메모/활성 변경, ADMIN_EMAIL 강등·비활성화 방지, 마지막 admin 삭제 방지 |
| 1.9 | 일괄 활성/비활성 | admin | `PATCH /api/users/bulk` | `{ ids, active }`, ADMIN_EMAIL 보호 |
| 1.10 | 일괄 삭제 | admin | `DELETE /api/users/bulk` | `{ ids }`, ADMIN_EMAIL 보호 |
| 1.11 | 사용자 삭제 | admin | `DELETE /api/users/:id` | ADMIN_EMAIL 보호, 마지막 admin 삭제 방지 |

### 운영 연락처

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 1.12 | 연락처 조회 | official | `GET /api/ops-contacts` | official+ 사이드바에 표시 |
| 1.13 | 연락처 추가 | admin | `POST /api/ops-contacts` | `{ name, phone }` |
| 1.14 | 연락처 삭제 | admin | `DELETE /api/ops-contacts/:id` | |

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

---

## 2. Entry 서비스

### 엔트리 관리

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 2.1 | 연도 목록 조회 | public | `GET /api/years` | entry_YYYY 테이블 스캔, 내림차순 |
| 2.2 | 엔트리 목록 조회 | public | `GET /api/entries?year=` | JSON 또는 download 파라미터로 CSV |
| 2.3 | 엔트리 추가 | admin | `POST /api/entries?year=` | `{ num, univ, team, type? }`, type은 vehicle_types에 존재해야 함 |
| 2.4 | 엔트리 수정 | admin | `PATCH /api/entries/:num?year=` | 번호 변경 시 리넘버링 포함 |
| 2.5 | 엔트리 삭제 | admin | `DELETE /api/entries/:num?year=` | |
| 2.6 | 엔트리 전체 삭제 | admin | `DELETE /api/entries?year=` | 연도별 전체 초기화 |
| 2.7 | 엔트리 일괄 업로드 | admin | `POST /api/entries/bulk?year=` | JSON 문자열로 전체 교체, 트랜잭션 |

### 차량 유형

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 2.8 | 차량 유형 조회 | public | `GET /api/vehicle-types` | sort_order 순 |
| 2.9 | 차량 유형 추가 | admin | `POST /api/vehicle-types` | `{ name }`, UNIQUE 제약 |
| 2.10 | 차량 유형 삭제 | admin | `DELETE /api/vehicle-types/:id` | 삭제 시 전 연도 엔트리의 type=NULL로 갱신 |

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
| 3.4 | 대기 등록 | official | `POST /api/admin/register/:type` | 엔트리 검증(entry 서비스) → 활성 확인 → 페널티 확인 → 동시 등록 규칙(배터리+샤시 허용) → 삽입 → SSE → SMS |
| 3.5 | 대기 취소 | official | `POST /api/admin/cancel/:type` | 삭제 → 페널티 부과 → SSE → SMS |
| 3.6 | 부스 입차 | official | `POST /api/admin/booths/:type/:boothNum/enter` | 큐에서 제거 → 부스 점유 → 로그 기록 → SSE → SMS |
| 3.7 | 부스 출차 | official | `POST /api/admin/booths/:type/:boothNum/exit` | 점유 해제 → 검사 이력 기록(재검 감지용) |
| 3.8 | 부스 활성 토글 | official | `PATCH /api/admin/booths/:type/:boothNum` | 점유 중 비활성화 방지 |

### 설정 (chief)

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 3.9 | 우선순위 설정 | chief | `POST /api/admin/priority/:type` | `{ num, priority }` |
| 3.10 | 우선순위 삭제 | chief | `DELETE /api/admin/priority/:type` | 개별 삭제 |
| 3.11 | 우선순위 전체 삭제 | chief | `DELETE /api/admin/priority/:type/all` | |
| 3.12 | 검사 이력 초기화 | chief | `DELETE /api/admin/history/:type` | 초검/재검 구분 초기화 |
| 3.13 | 정렬 규칙 토글 | chief | `PUT /api/admin/inspection/:type/ignore` | 우선순위/초검재검 무시 플래그 |
| 3.14 | 부스 수 설정 | chief | `PATCH /api/admin/booths/:type/config` | 점유 중 부스 축소 방지 |
| 3.15 | 검차 활성 토글 | chief | `PATCH /api/admin/inspection/:type` | SSE 브로드캐스트 |
| 3.16 | 검차 표시 토글 | chief | `PATCH /api/admin/inspection/:type/visibility` | 등록 페이지 노출 제어 |
| 3.17 | 취소 페널티 설정 | chief | `PATCH /api/admin/settings/cancel-penalty` | 0~60분 |

### SMS 설정

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 3.18 | SMS 토글 | official | `PATCH /api/admin/settings/sms` | 환경변수 필요 |
| 3.19 | SMS 알림 순번 조회 | official | `GET /api/admin/settings/sms-rank` | |
| 3.20 | SMS 알림 순번 설정 | official | `PATCH /api/admin/settings/sms-rank` | 1~10 |

### 통계

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 3.21 | 기간 조회 | official | `GET /api/admin/stats/timerange` | |
| 3.22 | 전체 팀 통계 | official | `GET /api/admin/stats` | 등록/취소/입차 횟수, 총 점유 시간 |
| 3.23 | 팀별 타임라인 | official | `GET /api/admin/stats/:num` | 이벤트 타임라인 + 요약 |

### 추가 조회 및 실시간

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 3.24 | 전체 부스 현황 조회 | public | `GET /api/booths/all` | 모든 검차 유형의 부스 상태 일괄 조회 |
| 3.25 | 전체 검차 목록 조회 | official | `GET /api/admin/all` | 비활성 포함 전체 검차 유형 목록 |
| 3.26 | 대기열 조회 | official | `GET /api/admin/inspection/:type` | 정렬된 대기열 목록 (우선순위/초검·재검/시간순) |
| 3.27 | 부스 목록 조회 | official | `GET /api/admin/booths/:type` | 검차별 부스 설정 및 점유 현황 |
| 3.28 | SMS 설정 조회 | official | `GET /api/admin/settings/sms` | SMS 활성화 상태 반환 |
| 3.29 | 취소 페널티 조회 | official | `GET /api/admin/settings/cancel-penalty` | 현재 페널티 시간(분) 반환 |
| 3.30 | SSE 실시간 업데이트 | public | `GET /api/events` | 검차 활성 상태, 대기열, 부스 변경 실시간 스트림 |

---

## 4. Inspection 서비스

### 템플릿 관리

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 4.1 | 템플릿 조회 | official | `GET /api/sheet/template?year=` | 4단계 계층 트리: 카테고리 > 소분류 > 그룹 > 항목 |
| 4.2 | 노드 추가 | admin | `POST /api/sheet/template` | level, parent_id, answer_type(passfail/number/text/checktable) |
| 4.3 | 노드 수정 | admin | `PUT /api/sheet/template/:id` | 이전 연도 수정 방지 |
| 4.4 | 노드 삭제 | admin | `DELETE /api/sheet/template/:id` | FK 캐스케이드로 하위 + 답변 삭제 |
| 4.5 | 순서 변경 | admin | `POST /api/sheet/template/reorder` | 일괄 sort_order 갱신 |
| 4.6 | 연도간 복사 | admin | `POST /api/sheet/template/copy` | 대상 연도 비어있어야 함, parent_id 리맵핑 |
| 4.7 | JSON 가져오기 | admin | `POST /api/sheet/template/import` | 중첩 JSON → 기존 삭제 후 일괄 삽입 |

### 검차 시트 작성

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 4.8 | 요약 대시보드 | official | `GET /api/sheet/summary?year=` | 전체 팀 × 카테고리 PASS/FAIL 매트릭스 |
| 4.9 | 답변 일괄 조회 | official | `GET /api/sheet/bulk-answers?year=&item_ids=` | 특정 항목들의 전체 팀 답변 |
| 4.10 | 팀 시트 조회 | official | `GET /api/sheet/data/:year/:num` | 답변, 카테고리 결과, 검사자 |
| 4.11 | 답변 입력 | official | `PUT /api/sheet/answer` | UPSERT, SSE 브로드캐스트 |
| 4.12 | 메모 입력 | official | `PUT /api/sheet/memo` | UPSERT, SSE 브로드캐스트 |
| 4.13 | 카테고리 결과 설정 | official | `PUT /api/sheet/category-result` | PASS/FAIL/"", SSE 브로드캐스트 |
| 4.14 | 검사자 지정 | official | `PUT /api/sheet/inspector` | UPSERT, SSE 브로드캐스트 |

### 실시간 및 인쇄

| # | 흐름 | 역할 | API/컴포넌트 | 설명 |
|---|------|------|-------------|------|
| 4.15 | SSE 실시간 업데이트 | official | `GET /api/sheet/events` | 답변, 메모, 카테고리 결과, 검사자 변경 실시간 스트림 |
| 4.16 | 검차 시트 인쇄 | official | SheetTemplatePrint.vue | `/template/print?year=` 라우트, 브라우저 인쇄 기능으로 PDF 출력 |

---

## 5. Traffic 서비스

### 경기 기록

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 5.1 | 기록 테이블 목록 | admin | `GET /api/records` | |
| 5.2 | 기록 조회 | admin | `GET /api/records/:name` | rowid, time, num, univ, team, type, result, detail, cones, oc, invalidated, scoreboard |
| 5.3 | 기록 추가 | admin | `POST /api/records` | 테이블명 자동 접두사 "FSK {year} ", 미존재 시 CREATE TABLE, SSE |
| 5.4 | 기록 필드 수정 | admin | `PATCH /api/records/:name/:rowid` | invalidated/scoreboard/detail/cones/oc, 무효화↔전광판 연동, SSE |
| 5.5 | 기록 테이블 삭제 | admin | `DELETE /api/records/:name` | DROP TABLE, SSE |

### 컨트롤러 데이터

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 5.6 | 컨트롤러 로그 조회 | admin | `GET /api/controllers` | |
| 5.7 | 컨트롤러 로그 업로드 | admin | `POST /api/controllers` | 시리얼 하드웨어 상태 저장 |
| 5.8 | 컨트롤러 로그 전체 삭제 | admin | `DELETE /api/controllers` | |

### 경기 모드

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 5.9 | 경기 모드 조회 | admin | `GET /api/event-modes` | 가속/스키드패드/오토크로스/짐카나 |
| 5.10 | 경기 모드 토글 | admin | `PUT /api/event-modes/:type` | 비활성 시 네비게이션/성적 테이블에서 숨김, SSE |

### 매뉴얼 모드 (프런트엔드)

| # | 흐름 | 역할 | 컴포넌트 | 설명 |
|---|------|------|----------|------|
| 5.11 | 가속 측정 | admin | AccelView | 매뉴얼 모드 → 녹색등 → 센서1(출발) → 센서2(도착) → 자동 저장 |
| 5.12 | 스키드패드 측정 | admin | SkidpadView | 센서1 × 4회 → lap2 + lap4 합산 저장 |
| 5.13 | 오토크로스 측정 | admin | AutocrossView | 녹색등 기준 → 센서1 × 2회 → 두 번째 통과 저장 |
| 5.14 | 짐카나 측정 | admin | GymkhanaView | 센서1(레인1) + 센서2(레인2) 독립 측정, 팀 중복 방지 |

### 실시간 및 내보내기

| # | 흐름 | 역할 | API/컴포넌트 | 설명 |
|---|------|------|-------------|------|
| 5.15 | SSE 실시간 업데이트 | admin | `GET /api/events` | 기록 추가/수정/삭제, 경기 모드 변경 실시간 스트림 |
| 5.16 | 기록 CSV/XLSX 내보내기 | admin | RecordView.vue | 클라이언트 사이드에서 선택된 기록 테이블을 CSV/XLSX로 다운로드 |

---

## 6. Score 서비스

### 성적 집계

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 6.1 | 성적 대시보드 조회 | admin | `GET /api/score?year=` | entry + inspection + traffic + endurance + 수동점수 + 페널티/점수 설정 집계 |
| 6.2 | 수동 점수 입력 | admin | `PUT /api/score/manual` | 보고서/에너지/가점/감점, SSE |

### 페널티·점수 설정

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 6.3 | 페널티 설정 | admin | `PUT /api/score/penalty` | 종목별 콘터치/코스이탈/출발지연 (초) |
| 6.4 | 점수 설정 | admin | `PUT /api/score/setting` | 종목별 총점/완주점수/컷오프% |

### 내구

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 6.5 | 내구 기록 조회 | admin | `GET /api/score/endurance?year=` | 팀별 드라이버1·2 시간, 페널티, 상태 |
| 6.6 | 내구 필드 수정 | admin | `PUT /api/score/endurance` | status(DNS/DNF/DSQ), 시간, 콘, 코스이탈 등, SSE |

### 실시간 및 내보내기

| # | 흐름 | 역할 | API/컴포넌트 | 설명 |
|---|------|------|-------------|------|
| 6.7 | SSE 실시간 업데이트 | admin | `GET /api/score/events` | inspection:*/traffic:* 재전파 + manual-score/penalty/setting/endurance 로컬 이벤트 |
| 6.8 | 성적 대시보드 내보내기 | admin | ScoreBoard.vue | 전체 성적표 CSV/XLSX 클라이언트 사이드 다운로드 |
| 6.9 | 내구 데이터 내보내기 | admin | EnduranceInput.vue | 내구 데이터 CSV/XLSX 클라이언트 사이드 다운로드 |

---

## 7. Documents 서비스

### 학생 흐름

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 7.1 | 세션 목록 조회 | student | `GET /api/sessions` | student_team에서 팀 조회 → 해당 팀 세션 + 최근 제출 상태 |
| 7.2 | 세션 상세 조회 | student | `GET /api/sessions/:id` | 팀 소속 확인, 제출 이력 + 파일 목록 |
| 7.3 | 파일 제출 | student | `POST /api/sessions/:id/submit` | 멀티파트, 시간 검증(start~late_end), 확장자 검증, 이전 제출 교체, 최대 100파일 |
| 7.4 | 제출 파일 다운로드 | student | `GET /api/submissions/:subId/files/:fileId` | 팀 소속 확인, 경로 순회 방지 |

### 관리자 흐름

| # | 흐름 | 역할 | API | 설명 |
|---|------|------|-----|------|
| 7.5 | 전체 세션 목록 | chief | `GET /api/admin/sessions?year=` | 연도 필터 |
| 7.6 | 세션 생성 | chief | `POST /api/admin/sessions` | 이름, 공지, 시작/마감/지각마감, 파일 제한, 확장자, 대상 팀 |
| 7.7 | 세션 수정 | chief | `PUT /api/admin/sessions/:id` | 팀 변경 시 제거된 팀의 제출 + 파일 삭제 |
| 7.8 | 세션 삭제 | chief | `DELETE /api/admin/sessions/:id` | FK 캐스케이드, 파일 디렉토리 정리 |
| 7.9 | 제출 현황 조회 | chief | `GET /api/admin/sessions/:id/status` | 팀별 제출/미제출/지각 상태 |
| 7.10 | 관리자 파일 다운로드 | chief | `GET /api/admin/submissions/:subId/files/:fileId` | 팀 소속 확인 없이 다운로드 |

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
| 7.15 | 엔트리 번호 동기화 | 내부 | `PATCH /api/internal/team-num` | entry 서비스에서 번호 변경 시 student_team, session_team, submission + 파일 디렉토리 일괄 갱신 |

---

## 8. 서비스 간 연동 흐름

### Score 집계 체인

```
Score → Entry: 엔트리 목록 조회
Score → Inspection: 카테고리 결과 + 템플릿(코너 웨이트 항목) 조회
Score → Traffic: 기록 + 경기 모드 조회
Score → Score DB: 내구, 수동 점수, 페널티/점수 설정
```

Score 서비스는 inspection과 traffic의 SSE 엔드포인트를 구독하여 변경사항을 실시간으로 재전파합니다 (`inspection:*`, `traffic:*` 접두사).

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
Auth → Entry, Queue, Inspection, Traffic, Score, Documents: /api/logs 엔드포인트로 로그 수집
```

### Documents 학생 조회

```
Documents → Auth: GET /api/admin/students로 학생 목록 조회
```

### Entry → Documents 팀 번호 동기화

```
Entry → Documents: PATCH /api/entries/:num에서 번호 변경 시 Documents PATCH /api/internal/team-num 호출 (실패 시 207 반환)
```
