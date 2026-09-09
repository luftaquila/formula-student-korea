export function createCourseStore({ db }) {
  function getCourses() {
    return db
      .prepare(
        `
    SELECT c.id, c.name, c.created_at, c.updated_at, c.reverse, c.start_cone_id, c.is_public,
           COUNT(cn.id) AS cone_count
    FROM course c
    LEFT JOIN cone cn ON cn.course_id = c.id
    GROUP BY c.id
    ORDER BY c.id
  `,
      )
      .all();
  }

  function getCones(courseId) {
    return db.prepare("SELECT * FROM cone WHERE course_id = ? ORDER BY id").all(courseId);
  }

  function getMemos(courseId) {
    return db.prepare("SELECT * FROM memo WHERE course_id = ? ORDER BY id").all(courseId);
  }

  function getCourseById(id) {
    return db.prepare("SELECT * FROM course WHERE id = ?").get(id);
  }

  function getConeById(id) {
    return db.prepare("SELECT * FROM cone WHERE id = ?").get(id);
  }

  function getMemoById(id) {
    return db.prepare("SELECT * FROM memo WHERE id = ?").get(id);
  }

  function getRouteMarkerById(id) {
    return db.prepare("SELECT * FROM route_marker WHERE id = ?").get(id);
  }

  function getCourseRoute(courseId) {
    return {
      markers: db
        .prepare("SELECT * FROM route_marker WHERE course_id = ? ORDER BY id")
        .all(courseId),
      steps: db
        .prepare("SELECT marker_id FROM route_step WHERE course_id = ? ORDER BY position")
        .all(courseId)
        .map((row) => row.marker_id),
    };
  }

  /* ============================================
   API 라우트: /api/courses/:id/snapshots
   ============================================ */

  const insertSnapshot = db.prepare(
    "INSERT INTO course_snapshot (course_id, taken_at, actor, reason, cones_json) VALUES (?, ?, ?, ?, ?)",
  );

  const selectSnapshotsForCourse = db.prepare(
    `SELECT id, course_id, taken_at, actor, reason,
          json_array_length(cones_json) AS cone_count
   FROM course_snapshot WHERE course_id = ? ORDER BY taken_at DESC LIMIT 100`,
  );

  const selectSnapshotById = db.prepare(
    "SELECT id, course_id, taken_at, actor, reason, cones_json FROM course_snapshot WHERE id = ?",
  );

  function takeCourseSnapshot(courseId, actor, reason) {
    const cones = getCones(courseId);
    if (cones.length === 0) return null;
    const simplified = cones.map((c) => ({ lat: c.lat, lng: c.lng, alt: c.alt, side: c.side }));
    const info = insertSnapshot.run(
      courseId,
      Date.now(),
      actor || null,
      reason || null,
      JSON.stringify(simplified),
    );
    return Number(info.lastInsertRowid);
  }

  return {
    getCourses,
    getCones,
    getMemos,
    getCourseById,
    getConeById,
    getMemoById,
    getRouteMarkerById,
    getCourseRoute,
    selectSnapshotsForCourse,
    selectSnapshotById,
    takeCourseSnapshot,
  };
}
