export function createCourseValidation({ logger }) {
  /* ============================================
   Validation 헬퍼
   ============================================ */
  function validateCourseName(name) {
    if (name === undefined || name === null || typeof name !== "string" || name.trim() === "") {
      return { valid: false, error: "코스 이름이 비어 있습니다." };
    }
    const trimmed = name.trim();
    if (trimmed.length > 100) {
      return { valid: false, error: "코스 이름이 너무 깁니다. (최대 100자)" };
    }
    return { valid: true, value: trimmed };
  }

  function validateCoordinate(lat, lng) {
    if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      return { valid: false, error: "위도가 올바르지 않습니다. (-90 ~ 90)" };
    }
    if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return { valid: false, error: "경도가 올바르지 않습니다. (-180 ~ 180)" };
    }
    return { valid: true };
  }

  // 고도(MSL, m)는 선택값. 없으면(null/undefined) null로 저장하고, 있으면 지표면에서
  // 로버가 닿을 수 있는 합리적 범위의 유한수만 허용한다. value에 정규화된 값을 담아
  // 호출부가 그대로 저장하도록 한다.
  function validateAltitude(alt) {
    if (alt === undefined || alt === null) return { valid: true, value: null };
    if (typeof alt !== "number" || !Number.isFinite(alt) || alt < -1000 || alt > 10000) {
      return { valid: false, error: "고도가 올바르지 않습니다. (-1000 ~ 10000 m)" };
    }
    return { valid: true, value: alt };
  }

  function validateSide(side) {
    if (side !== "left" && side !== "right" && side !== "center") {
      return { valid: false, error: "콘 방향이 올바르지 않습니다. (left, right 또는 center)" };
    }
    return { valid: true };
  }

  // 메모의 실측 가로/세로 크기(m). 드래그로 조절되는 값이라 양의 유한수만 허용하고,
  // 코스 규모를 훌쩍 넘는 값(오조작·클라이언트 버그)은 거른다.
  function validateMemoDimension(v, label) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 100000) {
      return { valid: false, error: `메모 ${label}가 올바르지 않습니다. (0 초과 100000 m 이하)` };
    }
    return { valid: true, value: v };
  }

  // 메모 회전 각도(deg). 없으면 0, 있으면 유한수만 허용하고 [0,360)으로 정규화한다.
  function validateMemoRotation(v) {
    if (v === undefined || v === null) return { valid: true, value: 0 };
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { valid: false, error: "메모 회전 각도가 올바르지 않습니다." };
    }
    return { valid: true, value: ((v % 360) + 360) % 360 };
  }

  // 메모 본문. 비어 있어도 되지만 무한정 커지지 않도록 상한을 둔다.
  function validateMemoContent(content) {
    if (content === undefined || content === null) return { valid: true, value: "" };
    if (typeof content !== "string")
      return { valid: false, error: "메모 내용이 올바르지 않습니다." };
    if (content.length > 5000)
      return { valid: false, error: "메모 내용이 너무 깁니다. (최대 5000자)" };
    return { valid: true, value: content };
  }

  function validateRouteMarkerLabel(label) {
    if (label === undefined || label === null) return { valid: true, value: "" };
    if (typeof label !== "string")
      return { valid: false, error: "주행 마커 이름이 올바르지 않습니다." };
    const value = label.trim();
    if (value.length > 50)
      return { valid: false, error: "주행 마커 이름이 너무 깁니다. (최대 50자)" };
    return { valid: true, value };
  }

  /* ============================================
   API 라우트: 주행 순서 마커
   ============================================ */

  function rejectRouteRequest(req, res, status, action, message, course = null, context = {}) {
    logger.warn(req, action, { error: message, ...context }, course?.name);
    return res.status(status).send(message);
  }

  return {
    validateCourseName,
    validateCoordinate,
    validateAltitude,
    validateSide,
    validateMemoDimension,
    validateMemoRotation,
    validateMemoContent,
    validateRouteMarkerLabel,
    rejectRouteRequest,
  };
}
