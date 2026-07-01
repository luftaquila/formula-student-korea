/* Wireless event helpers.
 *
 * 경기별 타이밍 RULE은 `traffic/lib/event-timing.mjs`(순수 모듈)에 있고, 유선 store(serial)·
 * 무선 store(wireless)가 그 규칙을 공유한다. 이 모듈은 경기 키·표시 이름과
 * 센서-role → 센서 인덱스 매핑만 담는다(라우팅용).
 */
export const WIRELESS_EVENTS = ["accel", "skidpad", "autocross", "endurance"];

export const EVENT_TYPE = {
  accel: "가속",
  skidpad: "스키드패드",
  autocross: "오토크로스",
  endurance: "내구",
};

// 역할(role) → 센서 인덱스(1/2). 매핑은 서버에 저장되고, 뷰 로직은 인덱스로 동작.
export function roleToSensor(eventKey, role) {
  // accel/autocross: 출발/도착 2센서. skidpad/endurance: 단일 센서.
  if (eventKey === "accel" || eventKey === "autocross") return role === "finish" ? 2 : 1;
  return 1; // skidpad/endurance: 단일 센서
}
