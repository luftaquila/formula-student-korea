import { ref } from "vue";
import { request } from "../api.js";

// Shared manual-drive channel. Pushes { throttle, steering } to the rover at
// 20 Hz and auto-releases after 5 consecutive failures (~250 ms) — the same
// contract the MapView joystick uses, so the VR view and the 2D panel drive the
// rover identically. throttle/steering are clamped to [-100, 100] (the server
// clamps again). Read the latest input at any rate via setInput(); the 20 Hz
// timer decouples input sampling (pointer / XR frame) from the network push.
export function useRoverControl() {
  const throttle = ref(0);
  const steering = ref(0);
  const active = ref(false);
  const ok = ref(false); // last push succeeded (for a status readout)
  let timer = null;
  let failCount = 0;
  let onRelease = null;

  async function push() {
    try {
      await request("/api/rover/control", {
        method: "POST",
        body: JSON.stringify({ throttle: throttle.value, steering: steering.value }),
      });
      failCount = 0;
      ok.value = true;
    } catch {
      ok.value = false;
      failCount++;
      // 5 consecutive failures (~250 ms) → the rover is gone; release so a stale
      // command can't keep replaying, and let the caller surface it.
      if (failCount >= 5) {
        const cb = onRelease;
        stop();
        if (cb) cb();
      }
    }
  }

  function setInput(t, s) {
    throttle.value = clamp(t);
    steering.value = clamp(s);
  }

  function start(opts = {}) {
    onRelease = opts.onRelease || null;
    failCount = 0;
    if (timer) return;
    active.value = true;
    push();
    timer = setInterval(push, 50);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    const wasActive = active.value;
    active.value = false;
    throttle.value = 0;
    steering.value = 0;
    // One best-effort zero so the rover doesn't coast on the last non-zero
    // command after we stop the loop.
    if (wasActive) {
      request("/api/rover/control", {
        method: "POST",
        body: JSON.stringify({ throttle: 0, steering: 0 }),
      }).catch(() => {});
    }
  }

  return { throttle, steering, active, ok, setInput, start, stop };
}

function clamp(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-100, Math.min(100, Math.round(v)));
}
