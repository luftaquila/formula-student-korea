import { createSSESubscriber } from "./sse-client.mjs";
import { serviceUrl } from "./services.mjs";

// entry 팀 상태의 다운스트림 클라이언트 — 영속 미러를 대체한다.
//
// 동작 원리: entry의 GET /api/internal/team-state?year= 스냅샷을 인메모리에 캐시하고
// (TTL + serve-stale-on-error), entry SSE `entries` 이벤트로 즉시 무효화하며, 마지막
// 스냅샷을 로컬 1행/연도 체크포인트 테이블에 통째로 저장해(동기화 프로토콜 없음, wholesale
// 교체) 재시작 내성을 얻는다. revision 시계·이벤트 순서·reconcile은 존재하지 않는다 —
// 스냅샷 자체가 항상 전체 진실이고, 수렴형 강제(enforcement)가 그 진실을 로컬 데이터에
// 멱등하게 적용한다.
//
// 캐시가 비어 있으면(부팅 직후 + entry 미가용 + 체크포인트 없음) "전원 활성"으로
// 동작한다 — 기존 미러의 absent-row-means-active 시맨틱과 동일하다. entry 데이터가
// 반드시 필요한 작업(등록·집계·num→id 해석)은 loaded 플래그를 보고 503으로 거절한다.
//
// registerBackfill(fn(year, state)): 연도별 1회, 첫 "사용 가능한"(팀이 있는) 스냅샷에서
//   플래그 기록과 같은 트랜잭션으로 실행 — 레거시 (year, num) 키 데이터에 team_id를 채운다.
// registerEnforcement(fn(year, state) -> postCommit?): 스냅샷 version이 마지막 적용
//   version과 다를 때 1 트랜잭션으로 실행 — tombstone cascade, 비활성 정리, 비정규화 갱신,
//   모르는 팀 로깅. 반환한 함수(또는 배열)는 커밋 후 실행된다(SSE 브로드캐스트용).
export function createTeamStateClient({
  db,
  logger,
  service,
  entryUrl,
  ttlMs = 30_000,
  fetchTimeoutMs = 5_000,
}) {
  const baseUrl = entryUrl || serviceUrl("entry");

  db.exec(`CREATE TABLE IF NOT EXISTS team_state_checkpoint (
    year INTEGER PRIMARY KEY,
    version INTEGER NOT NULL,
    applied_version INTEGER NOT NULL DEFAULT -1,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS team_id_backfill (
    year INTEGER PRIMARY KEY,
    completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);

  const cache = new Map();    // year -> state
  const inflight = new Map(); // year -> Promise<state>
  let backfillFn = null;
  let enforcementFn = null;
  let sse = null;

  const throttleMap = new Map();
  function throttled(key, ms = 300_000) {
    const now = Date.now();
    const last = throttleMap.get(key) || 0;
    if (now - last < ms) return false;
    throttleMap.set(key, now);
    return true;
  }

  function emptyState() {
    return {
      loaded: false,
      version: -1,
      fetchedAt: 0,
      teams: new Map(),
      byNum: new Map(),
      inactiveNums: [],
      inactiveNumsJson: "[]",
      tombstones: [],
    };
  }

  function buildState(snapshot) {
    const teams = new Map();
    const byNum = new Map();
    const inactiveNums = [];
    for (const [idStr, t] of Object.entries(snapshot.teams || {})) {
      const id = Number(idStr);
      const team = { id, num: t.num, univ: t.univ, team: t.team, type: t.type ?? null, active: !!t.active };
      teams.set(id, team);
      byNum.set(t.num, team);
      if (!team.active) inactiveNums.push(t.num);
    }
    return {
      loaded: true,
      version: snapshot.version,
      fetchedAt: Date.now(),
      teams,
      byNum,
      inactiveNums,
      inactiveNumsJson: JSON.stringify(inactiveNums),
      tombstones: snapshot.tombstones || [],
    };
  }

  // 스냅샷을 체크포인트에 기록하고 백필·강제를 실행한다. 전부 한 트랜잭션 —
  // applied_version 갱신이 강제 실행과 원자적이어야 재실행/미실행이 갈리지 않는다.
  function applySnapshot(year, snapshot) {
    const state = buildState(snapshot);
    db.transaction(() => {
      const existing = db.prepare("SELECT applied_version FROM team_state_checkpoint WHERE year = ?").get(year);
      db.prepare(`INSERT INTO team_state_checkpoint (year, version, applied_version, payload, fetched_at)
        VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(year) DO UPDATE SET version = excluded.version, payload = excluded.payload,
          fetched_at = excluded.fetched_at`).run(year, snapshot.version, existing?.applied_version ?? -1, JSON.stringify(snapshot));
      runHooks(year, state);
    })();
    cache.set(year, state);
    return state;
  }

  // 백필(1회) + 강제(version 변경 시). 호출자는 트랜잭션 안이다.
  function runHooks(year, state) {
    const postCommit = [];
    if (backfillFn && state.teams.size > 0
      && !db.prepare("SELECT 1 FROM team_id_backfill WHERE year = ?").get(year)) {
      // 빈 스냅샷으로는 백필을 확정하지 않는다 — entry가 그 연도 데이터를 복원하기 전에
      // 플래그가 서버리면 레거시 행이 영영 NULL로 남는다.
      backfillFn(year, state);
      db.prepare("INSERT INTO team_id_backfill (year) VALUES (?)").run(year);
    }
    const cp = db.prepare("SELECT applied_version FROM team_state_checkpoint WHERE year = ?").get(year);
    if (enforcementFn && cp && cp.applied_version !== state.version) {
      const r = enforcementFn(year, state);
      for (const f of [].concat(r || [])) {
        if (typeof f === "function") postCommit.push(f);
      }
      db.prepare("UPDATE team_state_checkpoint SET applied_version = ? WHERE year = ?").run(state.version, year);
    }
    // 트랜잭션 커밋 후 실행 (SSE 브로드캐스트가 롤백된 상태를 알리지 않게)
    if (postCommit.length) {
      queueMicrotask(() => {
        for (const f of postCommit) {
          try { f(); } catch (e) { logger?.warn(null, `${service}.team_state_post_commit`, { error: e.message }); }
        }
      });
    }
  }

  // 체크포인트에서 복원 (프로세스당 연도당 1회, fetch 실패·이전 경로)
  function restoreFromCheckpoint(year) {
    const row = db.prepare("SELECT version, payload FROM team_state_checkpoint WHERE year = ?").get(year);
    if (!row) return null;
    let snapshot;
    try { snapshot = JSON.parse(row.payload); }
    catch { return null; }
    const state = buildState(snapshot);
    state.fetchedAt = 0; // 낡은 것으로 표시 → 다음 getState가 재조회 시도
    db.transaction(() => runHooks(year, state))();
    cache.set(year, state);
    return state;
  }

  async function fetchSnapshot(year) {
    const res = await fetch(`${baseUrl}/api/internal/team-state?year=${year}`, {
      headers: { "X-Internal-Service": process.env.INTERNAL_SECRET || "" },
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
    if (!res.ok) throw new Error(`entry team-state ${res.status}`);
    return res.json();
  }

  // 연도 스냅샷 강제 재조회. 실패 시 기존 캐시/체크포인트로 폴백(serve-stale).
  async function refresh(year) {
    const y = Number(year);
    if (inflight.has(y)) return inflight.get(y);
    const p = (async () => {
      try {
        const snapshot = await fetchSnapshot(y);
        return applySnapshot(y, snapshot);
      } catch (e) {
        if (throttled(`fetch:${y}`, 60_000)) {
          logger?.warn(null, `${service}.team_state_fetch`, { error: e.message, year: y });
        }
        return cache.get(y) || restoreFromCheckpoint(y) || getOrInitEmpty(y);
      } finally {
        inflight.delete(y);
      }
    })();
    inflight.set(y, p);
    return p;
  }

  function getOrInitEmpty(year) {
    let state = cache.get(year);
    if (!state) {
      state = emptyState();
      cache.set(year, state);
    }
    return state;
  }

  // TTL 안이면 캐시, 만료면 재조회(실패 시 stale 반환). entry 데이터가 필수인 경로용.
  async function getState(year) {
    const y = Number(year);
    const state = cache.get(y) || restoreFromCheckpoint(y);
    if (state && Date.now() - state.fetchedAt < ttlMs) return state;
    return refresh(y);
  }

  // 동기 핫패스용: 캐시(없으면 체크포인트 복원)를 즉시 반환하고, 낡았으면 백그라운드 갱신.
  function getStateSync(year) {
    const y = Number(year);
    const state = cache.get(y) || restoreFromCheckpoint(y) || getOrInitEmpty(y);
    if (Date.now() - state.fetchedAt >= ttlMs && !inflight.has(y)) {
      refresh(y).catch(() => {});
    }
    return state;
  }

  function resolveTeamId(year, num) {
    const state = getStateSync(year);
    if (!state.loaded) return null;
    return state.byNum.get(Number(num))?.id ?? null;
  }

  // 미로드·빈 캐시·미지의 팀 = 활성 (기존 미러의 absent-row-means-active와 동일).
  function isActive(year, num) {
    const state = getStateSync(year);
    if (!state.loaded) return true;
    const team = state.byNum.get(Number(num));
    return team ? team.active : true;
  }

  function checkpointYears() {
    return db.prepare("SELECT year FROM team_state_checkpoint").all().map((r) => r.year);
  }

  function start() {
    // 부팅 fetch(비차단): 체크포인트가 있는 연도 + 현재 연도
    const years = new Set([...checkpointYears(), new Date().getFullYear()]);
    for (const y of years) refresh(y).catch(() => {});

    sse = createSSESubscriber({
      name: `${service}-team-state`,
      url: `${baseUrl}/api/events`,
      headers: () => ({ "X-Internal-Service": process.env.INTERNAL_SECRET || "" }),
      allowedEvents: new Set(["entries"]),
      onEvent: (evName, data) => {
        const y = Number(data?.year);
        if (!Number.isInteger(y)) return;
        // 이미 반영한 버전이면 재조회 생략
        const cached = cache.get(y);
        if (cached && Number.isInteger(data.version) && cached.version >= data.version) return;
        if (cache.has(y) || y === new Date().getFullYear()) refresh(y).catch(() => {});
      },
      // 재연결 = 끊긴 동안의 이벤트 유실 가능 → 아는 연도 전부 재조회
      onReconnect: () => {
        for (const y of cache.keys()) refresh(y).catch(() => {});
      },
      onWarn: (kind, detail) => {
        if (throttled(`sse:${kind}`, 60_000)) {
          logger?.warn(null, `${service}.team_state_sse_${kind}`, detail);
        }
      },
    });
    sse.start();
  }

  function stop() {
    sse?.stop();
    sse = null;
  }

  return {
    getState,
    getStateSync,
    refresh,
    resolveTeamId,
    isActive,
    registerBackfill: (fn) => { backfillFn = fn; },
    registerEnforcement: (fn) => { enforcementFn = fn; },
    throttled,
    start,
    stop,
  };
}
