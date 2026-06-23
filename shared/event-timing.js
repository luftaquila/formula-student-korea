/* 경기별 타이밍 규칙(순수 함수/상수). Vue·Pinia·DOM 비의존 — 클라 store와
 * (후속 단계의) 서버 기록 엔진이 동일 규칙을 공유한다. 컴포넌트가 아니라 로직을 재사용.
 *
 * 규칙은 "어느 센서가 t0(출발)인가 / 어느 센서를 무시하나 / 기록 시간 산식"만 담는다.
 * 상태는 호출자(store)가 소유하고, 이 모듈은 값 in → 값 out.
 */

// 경기 키 → 규칙.
//  - accel/autocross: 출발 센서(1)가 t0, 도착 센서(2) 통과로 기록(finish − start).
//  - skidpad: 단일 센서(1) 멀티랩(출발 센서 외 무시).
//  - endurance(내구): 단일 센서(1) 멀티랩(skidpad와 동일 규칙). 첫 통과 = t0, 이후 통과마다 1랩.
//    기록은 1건에 이어붙인다(result=총합, detail=랩 목록). score는 내구를 traffic 기록에서
//    제외하고 score_endurance로 별도 채점하므로 성적과는 연동되지 않는다.
// green은 전 경기 "arm"일 뿐 t0가 아니다(센서가 t0). 미등록 경기는 null.
export const TIMING_RULES = {
  accel: { startSensor: 1, latchStart: true },
  autocross: { startSensor: 1, latchStart: true },
  skidpad: { startSensor: 1, latchStart: true, singleSensor: true },
  endurance: { startSensor: 1, latchStart: true, singleSensor: true },
};

export function ruleFor(mode) {
  return TIMING_RULES[mode] || null;
}

// start를 래치해야 하는가: 규칙상 출발 센서이고 아직 start 미설정.
export function shouldLatchStart(rule, sensor, hasStart) {
  return !!rule?.latchStart && sensor === rule.startSensor && !hasStart;
}

// 이 센서를 기록에서 무시하는가(skidpad: 출발 센서 외 무시).
export function shouldIgnore(rule, sensor) {
  return !!rule?.singleSensor && sensor !== rule.startSensor;
}

// 기록 시간(ms 단위 tick): startTick 있으면 그 기준, 없으면 greenTick 폴백.
export function lapTime(tick, startTick, greenTick) {
  return startTick != null ? tick - startTick : tick - greenTick;
}

/* ── 내구 기록 포맷(클라·서버 공유) ──────────────────────────────────
 * 내구는 랩이 여러 개라 기록 1건에 이어붙인다: result = 랩 총합(ms), detail = 랩 목록.
 * 유선(EnduranceView)과 서버 기록 엔진이 같은 함수를 써 동일 문자열을 만든다.
 */
// ms → "MM:SS.mmm" (index.mjs clockStr / serial msToClockStr과 동일 규칙, self-contained).
export function formatLapMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  ms = Math.round(ms);
  const m = String(Math.floor(ms / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  const f = String(ms % 1000).padStart(3, "0");
  return `${m}:${s}.${f}`;
}

// 랩 시간(ms) 배열 → detail 문자열. 스키드패드 detail 컨벤션과 동일하게 " / " 구분.
export function formatEnduranceDetail(lapsMs) {
  return (lapsMs || []).map(formatLapMs).join(" / ");
}

// 랩 시간(ms) 배열 → 총합(ms).
export function enduranceTotal(lapsMs) {
  return (lapsMs || []).reduce((sum, ms) => sum + ms, 0);
}
