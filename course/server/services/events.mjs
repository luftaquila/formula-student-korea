import { authorizePrincipal, access } from "../../../shared/common/access-control.js";

export function createCourseEvents({ app }) {
  // 연결에 service grants를 태깅해 rover 텔레메트리를 rover.operate 연결로만 좁힌다.
  // courses/cones/memos는 course.operate 연결에 전송된다. 권한은 연결 시점 스냅샷이므로
  // SSE 매니저가 주기적으로 재검증해 변경·삭제 시 metadata를 갱신하거나 연결을 종료한다.
  async function revalidateSseRole(meta) {
    const email = meta.email;
    if (!email) return meta; // 검증 불가 → 유지

    // 미들웨어가 쓰는 바로 그 검증기를 재사용한다. 여기서 HTTP 클라이언트를 다시 구현하면
    // 404-vs-non-ok 해석이 두 곳에 생기고 한쪽만 테스트로 덮인다(주입 여부 분기도 함께 사라진다).
    const result = await app.validateUser(email);
    if (!result?.valid) {
      if (result?.transient) throw new Error("transient"); // 일시 장애 → 연결 유지(fail-open)
      return null; // 삭제/비활성 → 연결 종료
    }
    // `?? meta.role` 폴백은 **주입된 검증기 전용**이다. 내장 경로는 여기 닿지 않는다 —
    // auth는 활성 사용자가 없으면 404를 주고(위에서 종료), 있으면 role이 NOT NULL이다.
    // 주입 stub이 role을 생략하면 예전 코드가 끊었을 연결을 유지하게 되므로, 그 차이를
    // 모르고 stub을 쓰지 않도록 남긴다.
    const role = result.role ?? meta.role;
    const permissions = Array.isArray(result.permissions)
      ? result.permissions
      : meta.permissions || [];
    const principal = { kind: "human", role, permissions };
    if (!authorizePrincipal(principal, access.permission("course.operate"))) return null;
    return { ...meta, role, permissions };
  }

  return { revalidateSseRole };
}
