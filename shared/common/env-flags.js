// 불리언 환경변수 파싱. env 값은 항상 문자열이므로 "false"/"0"도 truthy가 되는
// 함정을 막는다. "1"/"true"/"yes"/"on"(대소문자 무시)만 활성으로 간주하고,
// 그 외("false", "0", "", undefined)는 모두 비활성.
export function isEnvEnabled(value) {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}
