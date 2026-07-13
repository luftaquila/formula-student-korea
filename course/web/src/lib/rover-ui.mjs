// Pure, reactivity-free rover status-strip presentation helpers, extracted from
// MapView.vue. No Vue refs and no side effects — each function takes a plain
// rover-status snapshot object, so these are safe to unit-test and reuse.

export const SPRAY_OUTCOME_SYMBOL = { success: "✓", cancelled: "⚠", timeout: "✕" };
export const SPRAY_OUTCOME_COLOR = { success: "#22c55e", cancelled: "#f59e0b", timeout: "#ef4444" };

export const DISCONNECT_REASON_LABEL = {
  sse_closed: "SSE LOST",
  write_failed: "SSE PUSH FAILED",
  replaced: "SESSION REPLACED",
};

export const BATTERY_WARN_PERCENT = 30;
export const BATTERY_CRIT_PERCENT = 20;

// Rover nav_state values that mean a mission is actively being driven.
export const ACTIVE_NAV_STATES = new Set(["CALIBRATING", "NAVIGATING", "SETTLING", "SPRAYING", "CAL_ANTENNA", "CAL_WHEELS"]);

// Fix-status tone. RTK is ok/warn, plain 3D is warn (no corrections),
// 2D / time-only / no-fix are all bad. Dead-reckoning variants are folded
// into no_fix at the rover, so they don't appear here.
export const FIX_STATUS_META = {
  rtk_fixed: { tone: "ok" },
  rtk_float: { tone: "warn" },
  "3d_fix": { tone: "warn" },
  "2d_fix": { tone: "bad" },
  time_only: { tone: "bad" },
  no_fix: { tone: "bad" },
};

// MCU status-flag bits (rover/mcu T-frame `flags`, see rover README).
// The MCU status LED encodes these by colour (red=e-stop, magenta=undervolt,
// yellow=heartbeat/batt-warn, orange=nav-GPS-lost); the chip only said
// "ERROR", so we decode them into a plain-English cause list.
export const MCU_FLAG = {
  ESTOP: 0x01,        // combined sw+hw E-stop latch
  HEARTBEAT: 0x02,    // Pi↔MCU heartbeat timeout (motors gated)
  UNDERVOLT: 0x04,    // battery ≤20 V (motors gated)
  BATT_WARN: 0x08,    // battery ≤22 V
  NAV_GPS_LOST: 0x40, // Pi-reported navigation GPS loss
  ESTOP_LINE: 0x80,   // raw physical E-stop button line
};

export function formatDurationSec(secs) {
  if (!isFinite(secs) || secs < 1) return null;
  if (secs < 60) return `~${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return s === 0 ? `~${m}m` : `~${m}m ${s}s`;
}

// Short, bullet-style English explanations for why the rover is in ERROR /
// EMERGENCY_STOP, decoded from MCU flags + GPS/NTRIP/battery state. Each row is
// [key, phrase, tone]; keys are unique so they survive the popover v-for :key.
export function roverFaultRows(s) {
  const rows = [];
  const flags = Number.isInteger(s.battery?.flags) ? s.battery.flags : 0;
  const estop = s.nav_state === "EMERGENCY_STOP";

  // E-stop (LED: red blink).
  if (estop || (flags & MCU_FLAG.ESTOP)) {
    rows.push((flags & MCU_FLAG.ESTOP_LINE)
      ? ["E-STOP", "Hardware E-stop button pressed", "bad"]
      : ["E-STOP", "Software E-stop (operator or server)", "bad"]);
  }
  // Pi↔MCU link (LED: yellow).
  if (flags & MCU_FLAG.HEARTBEAT) {
    rows.push(["LINK", "Pi↔MCU heartbeat timeout — motors gated", "bad"]);
  }
  // Battery (LED: magenta = undervolt, yellow = warn).
  if (flags & MCU_FLAG.UNDERVOLT) {
    rows.push(["BATTERY", "Undervolt cutoff (≤20 V) — motors gated", "bad"]);
  } else if (flags & MCU_FLAG.BATT_WARN) {
    rows.push(["BATTERY", "Low-battery warning (≤22 V)", "warn"]);
  } else if (s.battery?.percent != null && s.battery.percent <= BATTERY_CRIT_PERCENT) {
    rows.push(["BATTERY", `Battery critically low (${s.battery.percent}%)`, "bad"]);
  }
  // Navigation GPS loss (LED: orange blink). Infer from fix status too, since
  // the navigator can raise ERROR Pi-side before the MCU bit propagates.
  const fixBad = s.fix_status && s.fix_status !== "rtk_fixed";
  if ((flags & MCU_FLAG.NAV_GPS_LOST) || (s.nav_state === "ERROR" && fixBad)) {
    const fixLabel = s.fix_status ? s.fix_status.replace(/_/g, " ").toUpperCase() : "UNKNOWN";
    rows.push(["GPS", `RTK fix lost (now ${fixLabel}); holds until rtk_fixed`, "bad"]);
  }
  // NTRIP corrections offline — the usual root cause of an RTK-fix drop.
  if (s.ntrip_connected === false) {
    const err = s.ntrip?.last_error ? `: ${s.ntrip.last_error}` : "";
    rows.push(["NTRIP", `RTK corrections offline${err}`, "bad"]);
  }
  // Never leave a fault popover empty.
  if (rows.length === 0 && (s.nav_state === "ERROR" || estop)) {
    rows.push(["CAUSE", "Cause unclear — check rover logs", "warn"]);
  }
  return rows;
}
