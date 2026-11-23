import { access } from "../../../shared/common/access-control.js";

export function createCourseAccess() {
  function roleFn(req) {
    // Normalize before matching: Express 5 routing is case-insensitive and
    // trailing-slash-insensitive by default, so `/API/courses/1/` reaches the
    // same handlers as `/api/courses/1`. Canonicalize the path the same way the
    // router does so a gate can't be slipped with a path variant.
    const p = (req.path || "/").toLowerCase().replace(/\/+$/, "") || "/";
    if (p === "/api/health") return null;
    if (
      ["GET", "HEAD"].includes(req.method) &&
      (p === "/public" || p === "/env-config.js" || /^\/api\/public\/courses(?:\/[^/]+)?$/.test(p))
    )
      return null;
    if (/^\/api\/courses\/[^/]+\/publication$/.test(p)) return access.permission("course.manage");
    // Mission presets are course data edited only from the rover panel, and the
    // rover/GPS unit addresses are only useful to rover operators.
    if (/^\/api\/courses\/[^/]+\/mission-presets(?:\/[^/]+)?$/.test(p)) return access.permission("rover.operate");
    if (p === "/api/devices") return access.permission("rover.operate");
    if (p === "/api/logs") return access.anyOf(access.admin, access.internal);
    // Taking a snapshot only adds history (the console keeps one when a mission
    // starts); listing, restoring, and deleting snapshots require course
    // management because restore overwrites the whole course. The id segment is
    // matched loosely because the handlers parse it with parseInt: `1a` still
    // reaches course 1, so a digits-only gate could be slipped.
    if (req.method === "POST" && /^\/api\/courses\/[^/]+\/snapshots$/.test(p)) return access.permission("course.operate");
    if (/^\/api\/courses\/[^/]+\/snapshots/.test(p)) return access.permission("course.manage");
    // Deleting a course cascade-wipes its cones AND every snapshot of it (both
    // FK to course(id) ON DELETE CASCADE) — irreversible, so it follows the same
    // course-management boundary. Create/rename and cone editing are operation.
    if (req.method === "DELETE" && /^\/api\/courses\/[^/]+$/.test(p))
      return access.permission("course.manage");
    return access.permission("course.operate");
  }

  return { roleFn };
}
