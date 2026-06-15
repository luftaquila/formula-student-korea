/* Wireless event helpers.
 *
 * The per-event timing RULES live in the (reused) wired event views
 * (AccelView/SkidpadView/AutocrossView/GymkhanaView) — wireless mode renders the
 * same components with a wireless `source` facade, so the logic is identical by
 * construction. This module only holds the event keys and the sensor-role → role
 * index mapping the wireless store needs to route incoming events.
 */
export const WIRELESS_EVENTS = ["accel", "skidpad", "autocross", "gymkhana"];

export const EVENT_TYPE = {
  accel: "가속",
  skidpad: "스키드패드",
  autocross: "오토크로스",
  gymkhana: "짐카나",
};

// 역할(role) → 센서 인덱스(1/2). 매핑은 서버에 저장되고, 뷰 로직은 인덱스로 동작.
export function roleToSensor(eventKey, role) {
  if (eventKey === "accel") return role === "finish" ? 2 : 1; // start→1, finish→2
  if (eventKey === "gymkhana") return role === "lane2" ? 2 : 1; // lane1→1, lane2→2
  return 1; // skidpad / autocross: 단일 센서
}
