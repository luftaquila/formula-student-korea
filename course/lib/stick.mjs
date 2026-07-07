// Thumbstick response shaping for the VR teleop view.
//
// The Touch controller thumbstick is spring-loaded and small, so a raw linear
// map to [-100, 100] drives the rover badly:
//   * The controller has its own hardware/runtime dead zone (~0.2 on Quest), so
//     the first axis value it ever reports when you push is already ~0.2 — with a
//     plain ×100 map the output snaps straight to ~20, skipping 0..20 entirely.
//   * Near centre a linear map is twitchy: a small nudge is already a big command,
//     so fine adjustments are hard.
//
// shapeStick() fixes both:
//   1. Dead-zone RESCALE — anything at/under `deadzone` maps to 0, and the
//      remaining travel (deadzone..1) is rescaled back onto 0..1. Output leaves 0
//      *continuously* at the dead-zone edge instead of jumping. Set `deadzone` to
//      match the controller's hardware dead zone so the two zero-points coincide.
//   2. EXPO curve — a cubic blend so small deflections move gently (fine control
//      near centre) while full deflection still reaches ±1.
//
// The 2D on-screen joystick (MapView) deliberately stays linear: the finger
// positions the knob directly, so it provides its own precision and needs no
// shaping.

export const DEADZONE = 0.2; // match the Quest thumbstick hardware/rest dead zone
export const EXPO = 0.6;     // 0 = linear, →1 = softer near centre (full range kept)

// Map a raw stick axis in [-1, 1] to a shaped control value in [-1, 1].
export function shapeStick(v, { deadzone = DEADZONE, expo = EXPO } = {}) {
  if (!Number.isFinite(v)) return 0;
  const s = Math.sign(v);
  const m = Math.min(1, Math.abs(v));
  if (m <= deadzone) return 0;
  const n = (m - deadzone) / (1 - deadzone);        // 0..1 after the dead zone
  const curved = (1 - expo) * n + expo * n * n * n;  // expo blend, still 0..1
  return s * curved;
}
