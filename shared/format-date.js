import { parseDbTimestamp } from "./parse-timestamp.js";

// DB UTC 타임스탬프를 ko-KR 로캘 문자열로 변환한다. 파싱 실패/빈 값은 "-".
export function formatDate(value) {
  const date = parseDbTimestamp(value);
  return date ? date.toLocaleString("ko-KR") : "-";
}

// 좁은 표 열에서는 날짜와 시간을 각각 한 줄로 렌더링할 수 있게 분리한다.
export function formatDateLines(value) {
  const date = parseDbTimestamp(value);
  if (!date) return { date: "-", time: "" };
  return {
    date: date.toLocaleDateString("ko-KR"),
    time: date.toLocaleTimeString("ko-KR"),
  };
}

// 바이트 수를 사람이 읽는 단위 문자열로 변환한다. 0/null/undefined는 "-".
export function formatSize(bytes) {
  if (!bytes) return "-";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}
