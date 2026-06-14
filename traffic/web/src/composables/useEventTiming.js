/* Per-event timing rules for the wireless system.
 *
 * These are the SAME rules the legacy (wired) event views implement inline
 * (AccelView/SkidpadView/AutocrossView/GymkhanaView), lifted out so the wireless
 * store can run them against per-event state that persists across navigation
 * (multiple events run concurrently). The legacy views are left untouched.
 *
 * A `slot` is the per-event reactive state held by the wireless store:
 *   { green:{active,tick,timestamp}, start:{tick,timestamp}, records:[],
 *     clockDisplay, lastSensorTrigger:{}, run:<freshRun>, config:{...} }
 * Ticks are integer milliseconds (master ticks rounded at routing).
 */
import { msToClockStr } from "../stores/serial";

export const WIRELESS_EVENTS = ["accel", "skidpad", "autocross", "gymkhana"];

export const EVENT_TYPE = {
  accel: "가속",
  skidpad: "스키드패드",
  autocross: "오토크로스",
  gymkhana: "짐카나",
};

export const EVENT_TITLE = {
  accel: "Acceleration",
  skidpad: "Skidpad",
  autocross: "Autocross",
  gymkhana: "Gymkhana",
};

// 역할(role) -> 센서 인덱스(1/2). 매핑은 서버에 저장되고, 뷰 로직은 인덱스로 동작.
export function roleToSensor(eventKey, role) {
  if (eventKey === "accel") return role === "finish" ? 2 : 1; // start->1, finish->2
  if (eventKey === "gymkhana") return role === "lane2" ? 2 : 1; // lane1->1, lane2->2
  return 1; // skidpad / autocross: 단일 센서
}

// 이벤트별 1회 런(run)의 초기 상태(녹색등마다 리셋).
export function freshRun(eventKey) {
  switch (eventKey) {
    case "accel": return { startRecord: null, displayRecord: null, savedRecord: null };
    case "skidpad": return { lapTimes: [], lastTick: null, lap2Time: null, savedRecord: null };
    case "autocross": return { displayRecords: [], savedRecord: null };
    case "gymkhana": return { displayRecords: { 1: [], 2: [] }, savedRecords: { 1: null, 2: null } };
    default: return {};
  }
}

export function freshConfig() {
  return { eventName: "", team: null, teamLane1: null, teamLane2: null };
}

// 이벤트·센서별 선택된 엔트리 번호.
function teamNum(eventKey, config, sensor) {
  if (eventKey === "gymkhana") return sensor === 1 ? config.teamLane1 : config.teamLane2;
  return config.team;
}

/* 한 센서 이벤트의 저장 로직(레거시 뷰 onSensor와 동일). ctx = { getEntry, addRecord, notify }.
 * 일반 부분(쿨다운 게이트, records push, 클럭 시작)은 store 라우팅에서 처리. */
export async function onSensorRule(eventKey, slot, payload, ctx) {
  const { sensor, tick, greenTick } = payload;
  const run = slot.run;
  const cfg = slot.config;
  const name = (cfg.eventName || "").trim();
  const entryNum = teamNum(eventKey, cfg, sensor);
  const entry = entryNum != null ? ctx.getEntry(entryNum) : null;

  if (eventKey === "accel") {
    ctx.setCooldown(sensor);
    if (sensor === 1) {
      if (!run.startRecord) run.startRecord = { tick };
    } else if (sensor === 2 && run.startRecord) {
      if (run.displayRecord) return;
      const result = Math.round(tick - run.startRecord.tick);
      run.displayRecord = { result, time: msToClockStr(result) };
      if (!name || !entry) return;
      await ctx.addRecord(name, {
        time: new Date(), type: "가속",
        entry: { num: entry.num, univ: entry.univ, team: entry.team },
        result, detail: `${Math.round(run.startRecord.tick - greenTick)} ms delay`,
      });
      run.savedRecord = { result, time: msToClockStr(result) };
      ctx.notify(`기록 저장: ${msToClockStr(result)}`);
    }
    return;
  }

  if (eventKey === "skidpad") {
    if (sensor !== 1) return;
    const prevTick = run.lastTick ?? payload.startTick;
    if (prevTick === null || prevTick === undefined) { run.lastTick = tick; return; }
    const lapTime = Math.round(tick - prevTick);
    run.lastTick = tick;
    const lapNumber = run.lapTimes.length + 1;
    ctx.setCooldown(sensor);
    run.lapTimes.push({ lap: lapNumber, time: lapTime, display: msToClockStr(lapTime) });
    if (!name || !entry) return;
    if (lapNumber === 2) { run.lap2Time = lapTime; return; }
    if (lapNumber === 4 && run.lap2Time !== null && !run.savedRecord) {
      const total = run.lap2Time + lapTime;
      await ctx.addRecord(name, {
        time: new Date(), type: "스키드패드",
        entry: { num: entry.num, univ: entry.univ, team: entry.team },
        result: total, detail: `${msToClockStr(run.lap2Time)} / ${msToClockStr(lapTime)}`,
      });
      run.savedRecord = { total, lap2: run.lap2Time, lap4: lapTime };
      ctx.notify(`스키드패드 저장: ${msToClockStr(total)}`);
    }
    return;
  }

  if (eventKey === "autocross") {
    if (sensor !== 1) return;
    const result = Math.round(tick - greenTick);
    ctx.setCooldown(sensor);
    run.displayRecords.push({ result, time: msToClockStr(result) });
    if (run.displayRecords.length === 1) return;
    if (run.savedRecord) return;
    if (!name || !entry) return;
    const first = run.displayRecords[0];
    await ctx.addRecord(name, {
      time: new Date(), type: "오토크로스",
      entry: { num: entry.num, univ: entry.univ, team: entry.team },
      result, detail: `${first.result} ms delay`,
    });
    run.savedRecord = { result, time: msToClockStr(result) };
    ctx.notify(`기록 저장: ${msToClockStr(result)}`);
    return;
  }

  if (eventKey === "gymkhana") {
    const result = Math.round(tick - greenTick);
    ctx.setCooldown(sensor);
    run.displayRecords[sensor].push({ result, time: msToClockStr(result) });
    if (run.displayRecords[sensor].length === 1) return;
    if (run.savedRecords[sensor]) return;
    if (!name || !entry) return;
    const first = run.displayRecords[sensor][0];
    await ctx.addRecord(name, {
      time: new Date(), type: "짐카나",
      entry: { num: entry.num, univ: entry.univ, team: entry.team },
      result, detail: `레인 ${sensor} / ${first.result} ms delay`,
    });
    run.savedRecords[sensor] = { result, time: msToClockStr(result) };
    ctx.notify(`${sensor}번 레인 기록 저장: ${msToClockStr(result)}`);
    return;
  }
}

// DNF 저장(레거시 핸들러와 동일). lane은 짐카나에서만 사용.
export async function dnfRule(eventKey, slot, ctx, lane = 1) {
  const cfg = slot.config;
  const name = (cfg.eventName || "").trim();
  const sensor = eventKey === "gymkhana" ? lane : 1;
  const entryNum = teamNum(eventKey, cfg, sensor);
  const entry = entryNum != null ? ctx.getEntry(entryNum) : null;
  if (!name || !entry) {
    ctx.notifyError("이벤트 이름과 팀을 선택하세요.");
    return false;
  }
  await ctx.addRecord(name, {
    time: new Date(), type: EVENT_TYPE[eventKey],
    entry: { num: entry.num, univ: entry.univ, team: entry.team },
    result: -1,
  });
  ctx.notify(eventKey === "gymkhana" ? `${lane}번 레인 DNF 기록 저장` : "DNF 기록 저장");
  return true;
}
