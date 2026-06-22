/* 센서 디바운스 — 이벤트 자체 시각(tick, ms) 기준.
 *
 * 포토게이트는 물체가 한 번 지나가도 빔 차단/복귀(+기계·광학 바운스)로 2~3개 이벤트를
 * ~30~150ms 안에 쏜다. 타이밍 계측에선 이 "한 번의 통과 = 여러 이벤트"를 한 번으로 접어야
 * 랩타임이 정확하다.
 *
 * 비교축이 핵심이다: 도착 시각(벽시계 Date.now())이 아니라 이벤트의 캡처 시각(tick)으로
 * 비교해야 한다. 무선 경로는 브리지 버퍼링·SSE 지연·재전송·재연결 백필로 클라이언트 도착
 * 간격이 실제 캡처 간격과 크게 달라진다 — 50ms 간격으로 캡처된 두 엣지가 도착은 1초 넘게
 * 벌어질 수 있어, 벽시계 디바운스는 이를 못 접고 가짜 짧은 랩을 만든다. tick 델타로 보면
 * 도착 타이밍과 무관하게 한 통과의 엣지를 확실히 접는다.
 *
 * state는 { [sensor]: lastAcceptedTick } 맵(녹색등/리셋 시 비운다). 같은 센서에서 직전 채택
 * tick과 windowMs 미만이면 같은 통과로 보고 거른다(false). 통과 시 state를 갱신하고 true.
 * abs를 쓰는 이유: 엣지가 도착 순서상 뒤바뀌어도(재전송/재정렬) 한쪽만 채택되도록.
 * 마스터 시계 리셋 등으로 tick이 크게 뒤로 점프하면 델타가 windowMs 이상이라 정상 채택된다.
 */
export function acceptSensorTick(state, sensor, tick, windowMs) {
  const last = state[sensor];
  if (last != null && Math.abs(tick - last) < windowMs) return false;
  state[sensor] = tick;
  return true;
}
