export function formatScoreResult(result, status = null) {
  if (status) return status;
  if (result == null) return "-";
  const ms = Number(result);
  if (Number.isNaN(ms)) return String(result);
  const totalRounded = Math.round(Math.abs(ms));
  const millis = String(totalRounded % 1000).padStart(3, "0");
  const secs = Math.floor(totalRounded / 1000) % 60;
  const mins = Math.floor(totalRounded / 60000);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${millis}`;
}
