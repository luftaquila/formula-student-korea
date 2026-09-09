export function registerSnapshotsRoutes({
  app,
  getCourseById,
  selectSnapshotsForCourse,
  getCones,
  dbRun,
  takeCourseSnapshot,
  logger,
  selectSnapshotById,
  db,
  validateCoordinate,
  broadcastEvent,
  getCourses,
}) {
  app.get("/api/courses/:id/snapshots", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");
    const course = getCourseById(id);
    if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");
    res.json({ snapshots: selectSnapshotsForCourse.all(id) });
  });

  app.post("/api/courses/:id/snapshots", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");
    const course = getCourseById(id);
    if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");
    const cones = getCones(id);
    if (cones.length === 0) return res.status(400).send("콘이 없는 코스는 스냅샷할 수 없습니다.");

    const actor = req.user ? `${req.user.name || ""} <${req.user.email || ""}>` : null;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : null;

    const result = dbRun(() => takeCourseSnapshot(id, actor, reason));
    if (!result.success) {
      logger.warn(
        req,
        "course.snapshot.create",
        { error: result.internalError || result.error },
        course.name,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(
      req,
      "course.snapshot.create",
      { snapshot_id: result.result, cone_count: cones.length, reason },
      course.name,
    );
    res.status(201).json({ id: result.result });
  });

  app.post("/api/courses/:id/snapshots/:sid/restore", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const sid = parseInt(req.params.sid, 10);
    if (isNaN(id) || isNaN(sid)) return res.status(400).send("올바르지 않은 ID입니다.");
    const course = getCourseById(id);
    if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");
    const snap = selectSnapshotById.get(sid);
    if (!snap || snap.course_id !== id) return res.status(404).send("스냅샷을 찾을 수 없습니다.");

    let cones;
    try {
      cones = JSON.parse(snap.cones_json);
    } catch {
      return res.status(500).send("스냅샷 데이터가 손상되었습니다.");
    }
    if (!Array.isArray(cones)) return res.status(500).send("스냅샷 데이터가 손상되었습니다.");

    const actor = req.user ? `${req.user.name || ""} <${req.user.email || ""}>` : null;
    // Auto-snapshot current state as a safety net before overwriting.
    const safetyReason = `pre-restore of #${sid}`;
    const result = dbRun(() => {
      return db.transaction(() => {
        takeCourseSnapshot(id, actor, safetyReason);
        db.prepare("DELETE FROM cone WHERE course_id = ?").run(id);
        const insert = db.prepare(
          "INSERT INTO cone (course_id, lat, lng, alt, side, created_at, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        );
        // 방어심층: 스냅샷은 서버가 검증된 콘에서 생성하지만, 손상/조작된 행이 그대로 복원되지
        // 않도록 좌표를 재검증하고 유효한 콘만 재삽입한다. 이전 버전 스냅샷엔 alt가 없어 null 보존.
        let skippedCones = 0;
        for (const c of cones) {
          if (!validateCoordinate(c.lat, c.lng).valid) {
            skippedCones++;
            continue;
          }
          insert.run(id, c.lat, c.lng, typeof c.alt === "number" ? c.alt : null, c.side);
        }
        if (skippedCones)
          logger.warn(
            req,
            "course.snapshot.restore",
            { skipped_invalid_cones: skippedCones, snapshot_id: sid },
            course.name,
          );
        // Cones were replaced with fresh ids, so the designated start cone no longer
        // exists — reset to the auto start gate (snapshots carry no cone identity).
        db.prepare("UPDATE course SET start_cone_id = NULL WHERE id = ?").run(id);
        return getCones(id);
      })();
    });
    if (!result.success) {
      logger.warn(
        req,
        "course.snapshot.restore",
        { error: result.internalError || result.error, snapshot_id: sid },
        course.name,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(
      req,
      "course.snapshot.restore",
      { snapshot_id: sid, cone_count: cones.length },
      course.name,
    );
    broadcastEvent("cones", { type: "restore", courseId: id, cones: result.result });
    broadcastEvent("courses", {
      type: "start_reset",
      course: getCourseById(id),
      courses: getCourses(),
    });
    res.json({ cones: result.result });
  });

  app.delete("/api/courses/:id/snapshots/:sid", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const sid = parseInt(req.params.sid, 10);
    if (isNaN(id) || isNaN(sid)) return res.status(400).send("올바르지 않은 ID입니다.");
    const course = getCourseById(id);
    if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");
    const snap = selectSnapshotById.get(sid);
    if (!snap || snap.course_id !== id) return res.status(404).send("스냅샷을 찾을 수 없습니다.");

    const result = dbRun(() => db.prepare("DELETE FROM course_snapshot WHERE id = ?").run(sid));
    if (!result.success) {
      logger.warn(
        req,
        "course.snapshot.delete",
        { error: result.internalError || result.error, snapshot_id: sid },
        course.name,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "course.snapshot.delete", { snapshot_id: sid }, course.name);
    res.status(204).end();
  });
}
