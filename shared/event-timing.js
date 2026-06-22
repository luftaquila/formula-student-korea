/* 경기별 타이밍 규칙(순수 함수/상수). Vue·Pinia·DOM 비의존 — 클라 store와
 * (후속 단계의) 서버 기록 엔진이 동일 규칙을 공유한다. 컴포넌트가 아니라 로직을 재사용.
 *
 * 규칙은 "어느 센서가 t0(출발)인가 / 어느 센서를 무시하나 / 기록 시간 산식"만 담는다.
 * 상태는 호출자(store)가 소유하고, 이 모듈은 값 in → 값 out.
 */

// 경기 키 → 규칙.
//  - accel/autocross: 출발 센서(1)가 t0, 도착 센서(2) 통과로 기록(finish − start).
//  - skidpad: 단일 센서(1) 멀티랩(출발 센서 외 무시).
// green은 전 경기 "arm"일 뿐 t0가 아니다(센서가 t0). 미등록 경기는 null.
export const TIMING_RULES = {
  accel: { startSensor: 1, latchStart: true },
  autocross: { startSensor: 1, latchStart: true },
  skidpad: { startSensor: 1, latchStart: true, singleSensor: true },
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
