export function formatBoothElapsed(booth, now = Date.now()) {
  const enteredAt = Number(booth?.entered_at);
  if (!Number.isFinite(enteredAt)) return "00:00";

  const pausedAt = booth.timer_paused_at == null ? null : Number(booth.timer_paused_at);
  const end = Number.isFinite(pausedAt) ? pausedAt : now;
  const pausedMs = Math.max(0, Number(booth.timer_paused_ms) || 0);
  const diff = Math.max(0, Math.floor((end - enteredAt - pausedMs) / 1000));
  const min = Math.floor(diff / 60).toString().padStart(2, "0");
  const sec = (diff % 60).toString().padStart(2, "0");
  return `${min}:${sec}`;
}
