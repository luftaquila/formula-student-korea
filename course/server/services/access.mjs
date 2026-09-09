import { createSecretChecker } from "../../../shared/server/express-setup.mjs";
import { access } from "../../../shared/common/access-control.js";

export function createCourseAccess() {
  /* ============================================
   Express 앱 설정
   ============================================ */
  // Timing-safe internal secret check (shared helper)
  const isInternalSecret = createSecretChecker(process.env.INTERNAL_SECRET);

  // 로버 전용 시크릿(선택적). 설정되면 로버 라우트에서 X-Rover-Secret 헤더로도 인증할 수 있다.
  // isInternalRequest는 로버 라우트 게이트에서만 사용되므로(course authRoleFn) 이 시크릿의 권한은
  // 로버 엔드포인트로 자동 한정된다 — 필드 장비(pilot/perception/GPS)가 전 서비스 admin인
  // INTERNAL_SECRET을 소지하지 않아도 되어, 물리 장비 탈취 시 유출 반경이 course 로버 경로로 좁혀진다.
  // 미설정 시 checker가 항상 false라 기존 INTERNAL_SECRET 동작과 동일(하위 호환).
  const isRoverSecret = createSecretChecker(process.env.ROVER_SECRET);

  function isInternalRequest(req) {
    return (
      isInternalSecret(req.headers["x-internal-service"]) ||
      isRoverSecret(req.headers["x-rover-secret"])
    );
  }

  function roleFn(req) {
    // Normalize before matching: Express 5 routing is case-insensitive and
    // trailing-slash-insensitive by default, so `/API/rover/camera` and
    // `/api/rover/camera/` reach the same handlers. A raw `req.path ===` gate
    // would NOT match those variants and would fall through to "admin", letting
    // a logged-in admin browser bypass the internal-strict rover endpoints
    // (seize the rover/camera-control slot, inject frames). Canonicalize the
    // path the same way the router does so the gate can't be slipped.
    const p = (req.path || "/").toLowerCase().replace(/\/+$/, "") || "/";
    if (p === "/api/health") return null;
    if (
      ["GET", "HEAD"].includes(req.method) &&
      (p === "/public" || p === "/env-config.js" || /^\/api\/public\/courses(?:\/[^/]+)?$/.test(p))
    )
      return null;
    if (/^\/api\/courses\/[^/]+\/publication$/.test(p)) return access.permission("course.manage");
    // Rover-only endpoints. /api/rover/stream is internal-strict — falling
    // back to "admin" let any logged-in operator open the SSE in a browser
    // and clobber the single roverClient slot, which silently kicked the
    // real rover off and routed subsequent calibrate-* events to the
    // browser response. Symptom on the operator side: cal start button
    // does nothing despite RTK-fixed + IDLE. Internal-only closes the door.
    if (
      p === "/api/rover/stream" ||
      // Camera control SSE + frame upload are rover→server only. Internal-strict
      // (deny browsers) for the same reason as /stream: a browser must not be
      // able to occupy the single camera-control slot or inject frames.
      p === "/api/rover/camera/control" ||
      p === "/api/rover/camera" ||
      // Obstacle reports come from the perception node only. Internal-strict so a
      // browser can't spoof an obstacle to pause a running mission + raise a false
      // operator alarm.
      p === "/api/rover/obstacle" ||
      p === "/api/rover/mission-report" ||
      // Base-station RTCM relay + survey result come from the GPS receiver only.
      // Internal-strict so a browser can't inject fake RTCM corrections into the
      // rover or forge a surveyed base coordinate.
      p === "/api/rover/base/rtcm" ||
      p === "/api/rover/base/survey-result" ||
      // Calibration progress is reported by the perception node only.
      p === "/api/rover/calibration-progress"
    ) {
      return isInternalRequest(req) ? null : access.deny;
    }
    // Remaining device reports are also ingestion endpoints. They used to admit
    // an admin browser for diagnostics, but doing so makes a human session an
    // alternate device credential and bypasses the service-grant model.
    if (
      req.method === "POST" &&
      (p === "/api/rover/position" ||
        p === "/api/rover/telemetry" ||
        p === "/api/rover/waypoint_reached" ||
        p === "/api/rover/waypoint_skipped" ||
        p === "/api/rover/spray_result" ||
        p === "/api/rover/antenna_calibration_result" ||
        p === "/api/rover/wheel_calibration_result" ||
        p === "/api/rover/logs")
    ) {
      return isInternalRequest(req) ? null : access.deny;
    }
    // Rover control, mission history, GPS management and course editing use
    // independent grants. The frontend mirrors these gates, but this is the
    // enforcing boundary.
    if (p.startsWith("/api/rover")) return access.permission("rover.operate");
    if (p.startsWith("/api/missions")) return access.permission("rover.operate");
    // GPS receiver source selection and base-station survey share rover operation.
    if (p.startsWith("/api/gps")) return access.permission("rover.operate");
    if (p === "/api/logs") return access.anyOf(access.admin, access.internal);
    if (/^\/vr(?:\/|$)/.test(p)) return access.permission("rover.operate");
    // Snapshots overwrite the whole course on restore and can be deleted, so they
    // require course management above plain course operation.
    if (/^\/api\/courses\/\d+\/snapshots/.test(p)) return access.permission("course.manage");
    // Deleting a course cascade-wipes its cones AND every snapshot of it (both
    // FK to course(id) ON DELETE CASCADE) — irreversible, so it follows the same
    // course-management boundary. Create/rename and cone editing are operation.
    if (req.method === "DELETE" && /^\/api\/courses\/\d+$/.test(p))
      return access.permission("course.manage");
    return access.permission("course.operate");
  }

  return { roleFn };
}
