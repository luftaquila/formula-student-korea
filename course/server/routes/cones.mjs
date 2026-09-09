export function registerConesRoutes({
  app,
  getCourseById,
  dbRun,
  getCones,
  validateCoordinate,
  validateAltitude,
  validateSide,
  db,
  logger,
  broadcastEvent,
  getCourses,
  getConeById,
}) {
  /* ============================================
   API 라우트: /api/courses/:id/cones
   ============================================ */

  // GET /api/courses/:id/cones - 코스의 콘 목록 조회
  app.get("/api/courses/:id/cones", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

    const course = getCourseById(id);
    if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

    const result = dbRun(() => getCones(id));
    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });

  // POST /api/courses/:id/cones - 콘 추가
  app.post("/api/courses/:id/cones", (req, res) => {
    const courseId = parseInt(req.params.id, 10);
    if (isNaN(courseId)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

    const course = getCourseById(courseId);
    if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

    const { lat, lng, side, alt } = req.body;

    const coordValidation = validateCoordinate(lat, lng);
    if (!coordValidation.valid) return res.status(400).send(coordValidation.error);

    const altValidation = validateAltitude(alt);
    if (!altValidation.valid) return res.status(400).send(altValidation.error);

    const sideValidation = validateSide(side);
    if (!sideValidation.valid) return res.status(400).send(sideValidation.error);

    const result = dbRun(() => {
      db.prepare(
        "INSERT INTO cone (course_id, lat, lng, alt, side, created_at, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      ).run(courseId, lat, lng, altValidation.value, side);
      return db.prepare("SELECT * FROM cone WHERE id = last_insert_rowid()").get();
    });

    if (!result.success) {
      logger.warn(req, "cone.create", { error: result.internalError || result.error }, course.name);
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "cone.create", { lat, lng, alt: altValidation.value, side }, course.name);
    broadcastEvent("cones", {
      type: "add",
      courseId,
      cone: result.result,
      cones: getCones(courseId),
    });
    res.status(201).json(result.result);
  });

  // DELETE /api/courses/:id/cones - 코스의 모든 콘 삭제 (전체 삭제).
  // Destructive bulk wipe: a single audit entry (vs. N per-cone deletes) and one
  // SSE broadcast. Course-operation allowed, matching per-cone/multi-select delete — an editor
  // can already clear every cone one by one.
  app.delete("/api/courses/:id/cones", (req, res) => {
    const courseId = parseInt(req.params.id, 10);
    if (isNaN(courseId)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

    const course = getCourseById(courseId);
    if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

    const count = getCones(courseId).length;
    const hadStart = course.start_cone_id != null;
    const result = dbRun(() =>
      db.transaction(() => {
        db.prepare("DELETE FROM cone WHERE course_id = ?").run(courseId);
        // Wiping every cone also invalidates the designated start cone.
        if (hadStart)
          db.prepare("UPDATE course SET start_cone_id = NULL WHERE id = ?").run(courseId);
      })(),
    );

    if (!result.success) {
      logger.warn(
        req,
        "cone.delete_all",
        { error: result.internalError || result.error, count },
        course.name,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "cone.delete_all", { count }, course.name);
    broadcastEvent("cones", { type: "clear", courseId, cones: [] });
    if (hadStart)
      broadcastEvent("courses", {
        type: "start_reset",
        course: getCourseById(courseId),
        courses: getCourses(),
      });
    res.status(200).json({ deleted: count });
  });

  /* ============================================
   API 라우트: /api/cones/:id
   ============================================ */

  // PATCH /api/cones/:id - 콘 수정 (위치, 방향)
  app.patch("/api/cones/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).send("올바르지 않은 콘 ID입니다.");

    const cone = getConeById(id);
    if (!cone) return res.status(404).send("콘을 찾을 수 없습니다.");

    const setClauses = [];
    const values = [];

    if (req.body.lat !== undefined || req.body.lng !== undefined) {
      const lat = req.body.lat !== undefined ? req.body.lat : cone.lat;
      const lng = req.body.lng !== undefined ? req.body.lng : cone.lng;
      const coordValidation = validateCoordinate(lat, lng);
      if (!coordValidation.valid) return res.status(400).send(coordValidation.error);
      if (req.body.lat !== undefined) {
        setClauses.push("lat = ?");
        values.push(lat);
      }
      if (req.body.lng !== undefined) {
        setClauses.push("lng = ?");
        values.push(lng);
      }
    }

    if (req.body.alt !== undefined) {
      const altValidation = validateAltitude(req.body.alt);
      if (!altValidation.valid) return res.status(400).send(altValidation.error);
      setClauses.push("alt = ?");
      values.push(altValidation.value);
    }

    if (req.body.side !== undefined) {
      const sideValidation = validateSide(req.body.side);
      if (!sideValidation.valid) return res.status(400).send(sideValidation.error);
      setClauses.push("side = ?");
      values.push(req.body.side);
    }

    if (setClauses.length === 0) {
      return res.status(400).send("수정할 필드가 없습니다.");
    }

    setClauses.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");

    const result = dbRun(() => {
      values.push(id);
      db.prepare(`UPDATE cone SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
      return db.prepare("SELECT * FROM cone WHERE id = ?").get(id);
    });

    if (!result.success) {
      const updateCourse = getCourseById(cone.course_id);
      logger.warn(
        req,
        "cone.update",
        { error: result.internalError || result.error },
        updateCourse?.name,
      );
      return res.status(result.status).send(result.error);
    }

    const updateCourse = getCourseById(cone.course_id);
    logger.log(
      req,
      "cone.update",
      {
        before: { lat: cone.lat, lng: cone.lng, alt: cone.alt, side: cone.side },
        after: {
          lat: result.result.lat,
          lng: result.result.lng,
          alt: result.result.alt,
          side: result.result.side,
        },
      },
      updateCourse?.name,
    );
    broadcastEvent("cones", {
      type: "update",
      courseId: cone.course_id,
      cone: result.result,
      cones: getCones(cone.course_id),
    });
    res.json(result.result);
  });

  // DELETE /api/cones/:id - 콘 삭제
  app.delete("/api/cones/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).send("올바르지 않은 콘 ID입니다.");

    const cone = getConeById(id);
    if (!cone) return res.status(404).send("콘을 찾을 수 없습니다.");

    // If this cone is its course's designated start, clear it in the same tx so the
    // shared start_cone_id never dangles at a now-deleted cone.
    const wasStart = getCourseById(cone.course_id)?.start_cone_id === id;
    const result = dbRun(() =>
      db.transaction(() => {
        db.prepare("DELETE FROM cone WHERE id = ?").run(id);
        if (wasStart)
          db.prepare("UPDATE course SET start_cone_id = NULL WHERE id = ?").run(cone.course_id);
      })(),
    );
    if (!result.success) {
      const delCourse = getCourseById(cone.course_id);
      logger.warn(
        req,
        "cone.delete",
        { error: result.internalError || result.error },
        delCourse?.name,
      );
      return res.status(result.status).send(result.error);
    }

    const delCourse = getCourseById(cone.course_id);
    logger.log(
      req,
      "cone.delete",
      { lat: cone.lat, lng: cone.lng, side: cone.side },
      delCourse?.name,
    );
    broadcastEvent("cones", {
      type: "delete",
      courseId: cone.course_id,
      coneId: id,
      cones: getCones(cone.course_id),
    });
    if (wasStart)
      broadcastEvent("courses", { type: "start_reset", course: delCourse, courses: getCourses() });
    res.status(200).send();
  });
}
