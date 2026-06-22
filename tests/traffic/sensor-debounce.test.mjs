import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acceptSensorTick } from "../../traffic/web/src/composables/sensorDebounce.js";

const WINDOW = 1000; // SENSOR_COOLDOWN_MS

describe("acceptSensorTick (sensor debounce, tick-based)", () => {
  it("accepts the first trigger on a sensor", () => {
    const state = {};
    assert.equal(acceptSensorTick(state, 1, 100000, WINDOW), true);
    assert.equal(state[1], 100000);
  });

  it("collapses a multi-edge crossing cluster to one (the 0.065s bug)", () => {
    // 한 통과 = 빔 차단/복귀로 ~30~150ms 안에 2~3개 엣지. 첫 엣지만 채택, 나머지 무시.
    const state = {};
    assert.equal(acceptSensorTick(state, 1, 100000, WINDOW), true); // edge1
    assert.equal(acceptSensorTick(state, 1, 100065, WINDOW), false); // +65ms 바운스
    assert.equal(acceptSensorTick(state, 1, 100139, WINDOW), false); // +139ms 세 번째 엣지
    assert.equal(state[1], 100000, "기준은 첫 엣지 tick 유지");
  });

  it("accepts the next real crossing once it is >= window away", () => {
    const state = {};
    acceptSensorTick(state, 1, 100000, WINDOW); // 통과 N
    assert.equal(acceptSensorTick(state, 1, 100065, WINDOW), false); // 바운스
    // 실제 다음 랩(수초 뒤)
    assert.equal(acceptSensorTick(state, 1, 175000, WINDOW), true);
    assert.equal(state[1], 175000);
  });

  it("debounces per sensor independently (accel start=1, finish=2)", () => {
    const state = {};
    assert.equal(acceptSensorTick(state, 1, 100000, WINDOW), true); // start
    assert.equal(acceptSensorTick(state, 2, 100010, WINDOW), true); // finish 10ms 뒤라도 다른 센서 → 채택
    assert.equal(acceptSensorTick(state, 2, 100050, WINDOW), false); // finish 바운스는 무시
  });

  it("treats arrival order as irrelevant — a reordered earlier edge is still collapsed", () => {
    // 재전송/재정렬로 늦은 tick이 먼저 도착해도 한쪽만 채택(abs 비교).
    const state = {};
    assert.equal(acceptSensorTick(state, 1, 100065, WINDOW), true); // edge2가 먼저 도착
    assert.equal(acceptSensorTick(state, 1, 100000, WINDOW), false); // edge1이 뒤에 도착 → 같은 통과
  });

  it("accepts after a large backward jump (master clock reset)", () => {
    const state = {};
    acceptSensorTick(state, 1, 5_000_000, WINDOW);
    // 마스터 재부팅으로 tick이 작은 값으로 리셋 → 델타가 window 이상이라 정상 채택
    assert.equal(acceptSensorTick(state, 1, 1000, WINDOW), true);
    assert.equal(state[1], 1000);
  });

  it("boundary: exactly window away is accepted (only strictly-closer is dropped)", () => {
    const state = {};
    acceptSensorTick(state, 1, 100000, WINDOW);
    assert.equal(acceptSensorTick(state, 1, 100000 + WINDOW, WINDOW), true);
  });
});
