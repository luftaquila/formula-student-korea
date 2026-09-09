/**
 * 엔트리 번호 입력값을 검증한다. 1 이상의 정수만 유효.
 * @param {*} num - 검증할 값 (문자열/숫자)
 * @returns {{ valid: true, value: number } | { valid: false, error: string }}
 */
export function validateEntryNum(num) {
  const parsed = Number(num);
  if (num === "" || num === undefined || Number.isNaN(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    return { valid: false, error: "올바르지 않은 엔트리 번호입니다." };
  }
  return { valid: true, value: parsed };
}

/**
 * 연도 입력값을 검증한다. 2000-2099 정수만 유효.
 * @param {*} year - 검증할 값 (문자열/숫자)
 * @returns {{ valid: true, value: number } | { valid: false, error: string }}
 */
export function validateYear(year) {
  const parsed = Number(year);
  if (year === "" || year == null || !Number.isInteger(parsed) || parsed < 2000 || parsed > 2099) {
    return { valid: false, error: "올바르지 않은 연도입니다." };
  }
  return { valid: true, value: parsed };
}
