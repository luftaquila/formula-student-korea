/**
 * 전화번호 입력값을 하이픈 포맷으로 변환 (입력 중 실시간 포매팅용)
 * @param {string} value - 입력값
 * @returns {string} 포맷된 전화번호 (e.g. "010-1234-5678")
 */
export function formatPhone(value) {
  const digits = value.replace(/[^0-9]/g, "").slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 11)}`;
}

/**
 * 저장된 전화번호를 하이픈 포맷으로 변환 (표시용)
 * @param {string} phone - 11자리 전화번호
 * @returns {string} 포맷된 전화번호 (e.g. "010-1234-5678")
 */
export function displayPhone(phone) {
  return phone.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3");
}
