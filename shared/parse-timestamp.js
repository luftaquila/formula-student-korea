/**
 * 저장된 DB 타임스탬프 문자열을 Date로 파싱한다.
 * 이미 `...Z` 또는 숫자 오프셋(`+09:00`)이 붙은 값은 그대로, 공백 구분
 * `YYYY-MM-DD HH:MM:SS` 레거시 값은 UTC로 해석한다.
 * @param {*} value
 * @returns {Date|null} 파싱 실패 시 null
 */
export function parseDbTimestamp(value) {
  const s = String(value || "");
  if (!s) return null;
  const d = new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}
