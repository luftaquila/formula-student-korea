import { parseLegacyTimestamp } from "../../../../../shared/server/db-setup.mjs";
import { parseDbTimestamp } from "../../../../../shared/common/parse-timestamp.js";

export function createDocumentDates() {
  /* ============================================
   헬퍼
   ============================================ */
  function now() {
    return new Date().toISOString();
  }

  /** "YYYY-MM-DD HH:MM" 또는 ISO-like 입력 → UTC ISO(zone 없으면 UTC로 해석). 실패 시 null */
  const normalizeTimestamp = (str) => parseLegacyTimestamp(str);

  /** UTC DB date string → KST display "YYYY-MM-DD HH:MM" */
  function toKST(utcStr) {
    if (!utcStr) return "";
    const d = parseDbTimestamp(utcStr);
    if (!d) return "";
    d.setHours(d.getHours() + 9);
    return d.toISOString().replace("T", " ").slice(0, 16);
  }

  /** Subtract hours from UTC date string → UTC date string */
  function subtractHours(utcStr, hours) {
    const d = parseDbTimestamp(utcStr);
    if (!d) return "";
    d.setHours(d.getHours() - hours);
    return d.toISOString();
  }

  return { now, normalizeTimestamp, toKST, subtractHours };
}
