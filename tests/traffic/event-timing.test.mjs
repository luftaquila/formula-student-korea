import { describe, it } from "node:test";
import assert from "node:assert";
import {
  TIMING_RULES,
  ruleFor,
  shouldLatchStart,
  shouldIgnore,
  lapTime,
  formatLapMs,
  formatEnduranceDetail,
  enduranceTotal,
} from "../../traffic/lib/event-timing.mjs";

describe("event-timing rules", () => {
  it("accel/autocross are start→finish, skidpad/endurance are single-sensor", () => {
    assert.deepEqual(ruleFor("accel"), { startSensor: 1, latchStart: true });
    assert.deepEqual(ruleFor("autocross"), { startSensor: 1, latchStart: true });
    assert.equal(ruleFor("skidpad").singleSensor, true);
    assert.equal(ruleFor("endurance").singleSensor, true); // 내구: 단일 센서 멀티랩(표시 전용)
    assert.equal(ruleFor("gymkhana"), null); // 폐지된 경기
    assert.equal(ruleFor(undefined), null);
  });

  it("shouldLatchStart: only on start sensor when start not yet set", () => {
    const r = TIMING_RULES.accel;
    assert.equal(shouldLatchStart(r, 1, false), true); // 출발 센서, 미설정 → 래치
    assert.equal(shouldLatchStart(r, 1, true), false); // 이미 설정됨
    assert.equal(shouldLatchStart(r, 2, false), false); // 도착 센서는 t0 아님
    assert.equal(shouldLatchStart(null, 1, false), false); // 규칙 없음
  });

  it("shouldIgnore: skidpad ignores non-start sensors, start/finish ignores none", () => {
    assert.equal(shouldIgnore(TIMING_RULES.skidpad, 1), false);
    assert.equal(shouldIgnore(TIMING_RULES.skidpad, 2), true);
    assert.equal(shouldIgnore(TIMING_RULES.endurance, 2), true); // 내구도 단일 센서
    assert.equal(shouldIgnore(TIMING_RULES.accel, 2), false);
    assert.equal(shouldIgnore(null, 2), false);
  });

  it("lapTime: uses startTick when set, falls back to greenTick", () => {
    assert.equal(lapTime(5000, 1000, 200), 4000); // finish - start
    assert.equal(lapTime(5000, null, 200), 4800); // start 미설정 → green 폴백
    assert.equal(lapTime(5000, 0, 200), 5000); // startTick=0도 유효(0 != null)
  });

  it("endurance formatters: lap detail + total (클라·서버 공유)", () => {
    assert.equal(formatLapMs(62531), "01:02.531");
    assert.equal(formatLapMs(0), "00:00.000");
    assert.equal(formatLapMs(-5), "00:00.000"); // 음수 가드
    assert.equal(formatEnduranceDetail([42531, 41882]), "00:42.531 / 00:41.882");
    assert.equal(formatEnduranceDetail([]), "");
    assert.equal(enduranceTotal([42531, 41882, 1000]), 85413);
    assert.equal(enduranceTotal([]), 0);
  });
});
