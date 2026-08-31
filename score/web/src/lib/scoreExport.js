import { calculateAdjustedResult } from "../../../lib/adjusted-result.mjs";

export const SCORE_EXPORT_RUN_LIMIT = 4;

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

export function buildEventExportHeaders(eventType, {
  runLimit = SCORE_EXPORT_RUN_LIMIT,
  recordLabel = "최고 기록",
} = {}) {
  return [
    `${eventType} 점수`,
    `${eventType} ${recordLabel}`,
    ...Array.from({ length: runLimit }, (_, index) => `${eventType} 기록 ${index + 1}`),
  ];
}

export function buildEventExportCells({ eventType, record, score, penalty, runLimit = SCORE_EXPORT_RUN_LIMIT }) {
  const cells = [score ?? "", formatScoreResult(calculateAdjustedResult(eventType, record, penalty), record?.status)];
  if (runLimit === 0) return cells;

  const runs = (record?.allRuns || []).slice(0, runLimit);

  for (let index = 0; index < runLimit; index++) {
    const run = runs[index];
    cells.push(run ? formatScoreResult(calculateAdjustedResult(eventType, run, penalty), run.status) : "");
  }
  return cells;
}
