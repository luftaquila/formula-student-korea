export function createQueueValidation({ inspections }) {
  /* ============================================
   Validation 헬퍼
   ============================================ */
  function validatePhone(phone) {
    if (!phone || !/^010\d{8}$/.test(phone)) {
      return { valid: false, error: "전화번호가 올바르지 않습니다." };
    }
    return { valid: true, value: phone };
  }

  function validateInspection(type) {
    if (!Object.hasOwn(inspections, type)) {
      return { valid: false, error: "검차 종류가 올바르지 않습니다." };
    }
    return { valid: true, value: type };
  }

  function validatePriority(priority) {
    const parsed = Number(priority);
    // 상한(999999)을 둬 비정상적으로 큰 정수가 정렬 키로 들어오는 것을 막는다(기본값 999).
    if (
      priority === "" ||
      priority === undefined ||
      Number.isNaN(parsed) ||
      parsed < 0 ||
      parsed > 999999 ||
      !Number.isInteger(parsed)
    ) {
      return { valid: false, error: "우선순위는 0 이상 999999 이하의 정수여야 합니다." };
    }
    return { valid: true, value: parsed };
  }

  return { validatePhone, validateInspection, validatePriority };
}
