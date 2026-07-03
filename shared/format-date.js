import { parseDbTimestamp } from "./parse-timestamp.js";

// DB UTC 타임스탬프를 ko-KR 로캘 문자열로 변환한다. 파싱 실패/빈 값은 "-".
export function formatDate(value) {
  const date = parseDbTimestamp(value);
  return date ? date.toLocaleString("ko-KR") : "-";
}

// 바이트 수를 사람이 읽는 단위 문자열로 변환한다. 0/null/undefined는 "-".
export function formatSize(bytes) {
  if (!bytes) return "-";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}
