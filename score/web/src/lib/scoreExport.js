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

function adjustedResult(record, penalty = {}) {
  if (!record || record.status || record.result == null) return null;
  return Number(record.result)
    + (Number(record.cones) || 0) * (Number(penalty.cone_penalty) || 0) * 1000
    + (Number(record.oc) || 0) * (Number(penalty.oc_penalty) || 0) * 1000;
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

export function buildEventExportCells({ record, score, penalty, runLimit = SCORE_EXPORT_RUN_LIMIT }) {
  const cells = [score ?? "", formatScoreResult(adjustedResult(record, penalty), record?.status)];
  if (runLimit === 0) return cells;

  const runs = (record?.allRuns || []).slice(0, runLimit);

  for (let index = 0; index < runLimit; index++) {
    const run = runs[index];
    cells.push(run ? formatScoreResult(adjustedResult(run, penalty), run.status) : "");
  }
  return cells;
}
