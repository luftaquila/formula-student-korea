export function registerCoursesRoutes({
  app,
  dbRun,
  getCourses,
  validateCourseName,
  db,
  logger,
  broadcastEvent,
  getCourseById,
  getConeById,
  getCones,
  getCourseRoute,
  getMemos,
  validateCoordinate,
  validateSide,
  validateAltitude,
  validateMemoDimension,
  validateMemoRotation,
  validateMemoContent,
  validateRouteMarkerLabel,
  rejectRouteRequest,
}) {
  /* ============================================
   API 라우트: /api/courses
   ============================================ */

  // GET /api/courses - 코스 목록 조회
  app.get("/api/courses", (req, res) => {
    const result = dbRun(() => getCourses());
    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });

  // POST /api/courses - 코스 생성
  app.post("/api/courses", (req, res) => {
    const validation = validateCourseName(req.body.name);
    if (!validation.valid) return res.status(400).send(validation.error);

    const result = dbRun(() => {
      db.prepare(
        "INSERT INTO course (name, created_at, updated_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      ).run(validation.value);
      return db.prepare("SELECT * FROM course WHERE id = last_insert_rowid()").get();
    });

    if (!result.success) {
      if (result.error?.includes("UNIQUE")) {
        logger.warn(
          req,
          "course.create",
          { error: result.internalError || result.error },
          validation.value,
        );
        return res.status(400).send("이미 존재하는 코스 이름입니다.");
      }
      logger.warn(
        req,
        "course.create",
        { error: result.internalError || result.error },
        validation.value,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "course.create", null, validation.value);
    broadcastEvent("courses", { type: "create", course: result.result, courses: getCourses() });
    res.status(201).json(result.result);
  });

  // PATCH /api/courses/:id - 코스 이름 수정
  app.patch("/api/courses/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

    const course = getCourseById(id);
    if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

    const validation = validateCourseName(req.body.name);
    if (!validation.valid) return res.status(400).send(validation.error);

    const result = dbRun(() => {
      db.prepare(
        "UPDATE course SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      ).run(validation.value, id);
      return db.prepare("SELECT * FROM course WHERE id = ?").get(id);
    });

    if (!result.success) {
      if (result.error?.includes("UNIQUE")) {
        logger.warn(
          req,
          "course.rename",
          { error: result.internalError || result.error },
          course.name,
        );
        return res.status(400).send("이미 존재하는 코스 이름입니다.");
      }
      logger.warn(
        req,
        "course.rename",
        { error: result.internalError || result.error },
        course.name,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "course.rename", { before: course.name, after: validation.value }, course.name);
    broadcastEvent("courses", { type: "rename", course: result.result, courses: getCourses() });
    res.json(result.result);
  });

  // PATCH /api/courses/:id/direction - 코스 진행 방향/시작 콘 저장 (모든 클라이언트 공유).
  // reverse·start_cone_id 중 요청에 담긴 것만 갱신한다. start_cone_id는 이 코스에 속한
  // 콘이어야 하며 null이면 자동 시작 게이트로 되돌린다.
  app.patch("/api/courses/:id/direction", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

    const course = getCourseById(id);
    if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

    const sets = [];
    const params = [];
    const detail = {};

    if ("reverse" in req.body) {
      if (typeof req.body.reverse !== "boolean") {
        return res.status(400).send("진행 방향(reverse)은 true 또는 false여야 합니다.");
      }
      sets.push("reverse = ?");
      params.push(req.body.reverse ? 1 : 0);
      detail.reverse = req.body.reverse;
    }

    if ("start_cone_id" in req.body) {
      const sc = req.body.start_cone_id;
      if (sc !== null) {
        if (!Number.isInteger(sc)) return res.status(400).send("시작 콘 ID가 올바르지 않습니다.");
        const cone = getConeById(sc);
        if (!cone || cone.course_id !== id) {
          return res.status(400).send("시작 콘이 이 코스에 속하지 않습니다.");
        }
      }
      sets.push("start_cone_id = ?");
      params.push(sc);
      detail.start_cone_id = sc;
    }

    if (sets.length === 0) return res.status(400).send("변경할 항목이 없습니다.");

    const result = dbRun(() => {
      db.prepare(
        `UPDATE course SET ${sets.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      ).run(...params, id);
      return db.prepare("SELECT * FROM course WHERE id = ?").get(id);
    });

    if (!result.success) {
      logger.warn(
        req,
        "course.direction",
        { error: result.internalError || result.error, ...detail },
        course.name,
      );
      return res.status(result.status).send(result.error);
    }
    if (!result.result) {
      // The course was deleted between the existence check and the UPDATE, so the
      // UPDATE matched 0 rows and the follow-up SELECT returned nothing. Report it
      // as gone rather than sending an empty body the client can't parse.
      logger.warn(
        req,
        "course.direction",
        { error: "course removed mid-update", ...detail },
        course.name,
      );
      return res.status(404).send("코스를 찾을 수 없습니다.");
    }

    logger.log(req, "course.direction", detail, course.name);
    broadcastEvent("courses", { type: "direction", course: result.result, courses: getCourses() });
    res.json(result.result);
  });

  // GET /api/courses/:id/export - 코스 JSON 다운로드
  app.get("/api/courses/:id/export", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

    const course = getCourseById(id);
    if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

    const cones = getCones(id);
    // Preserve the now-canonical travel direction and start cone. The start cone is
    // exported by its position in the cones array (cone ids are reassigned on
    // import), so a re-import restores it to the same physical cone.
    const startIndex =
      course.start_cone_id != null ? cones.findIndex((c) => c.id === course.start_cone_id) : -1;
    const route = getCourseRoute(id);
    const routeMarkerIndex = new Map(route.markers.map((marker, index) => [marker.id, index]));
    const data = {
      name: course.name,
      reverse: !!course.reverse,
      start_cone_index: startIndex >= 0 ? startIndex : null,
      cones: cones.map((c) => ({ lat: c.lat, lng: c.lng, alt: c.alt, side: c.side })),
      memos: getMemos(id).map((m) => ({
        lat: m.lat,
        lng: m.lng,
        width: m.width,
        height: m.height,
        rotation: m.rotation,
        content: m.content,
      })),
      route_markers: route.markers.map((marker) => ({
        lat: marker.lat,
        lng: marker.lng,
        label: marker.label,
      })),
      route_steps: route.steps.map((markerId) => routeMarkerIndex.get(markerId)),
    };

    logger.log(
      req,
      "course.export",
      {
        cone_count: cones.length,
        route_marker_count: route.markers.length,
        route_step_count: route.steps.length,
      },
      course.name,
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(course.name)}.json"`,
    );
    res.json(data);
  });

  // POST /api/courses/import - JSON으로 코스 추가
  app.post("/api/courses/import", (req, res) => {
    const { name, cones } = req.body;

    const nameValidation = validateCourseName(name);
    if (!nameValidation.valid) {
      logger.warn(req, "course.import", { error: nameValidation.error }, name);
      return res.status(400).send(nameValidation.error);
    }

    if (!Array.isArray(cones)) {
      logger.warn(req, "course.import", { error: "올바르지 않은 콘 데이터입니다." }, name);
      return res.status(400).send("올바르지 않은 콘 데이터입니다.");
    }

    for (const cone of cones) {
      const cv = validateCoordinate(cone.lat, cone.lng);
      if (!cv.valid) {
        logger.warn(req, "course.import", { error: cv.error }, name);
        return res.status(400).send(cv.error);
      }
      const sv = validateSide(cone.side);
      if (!sv.valid) {
        logger.warn(req, "course.import", { error: sv.error }, name);
        return res.status(400).send(sv.error);
      }
      const av = validateAltitude(cone.alt);
      if (!av.valid) {
        logger.warn(req, "course.import", { error: av.error }, name);
        return res.status(400).send(av.error);
      }
    }

    // 메모는 선택 항목(예전 파일엔 없음). 있으면 각 필드를 콘과 같은 방식으로 검증한다.
    const memos = Array.isArray(req.body.memos) ? req.body.memos : [];
    for (const memo of memos) {
      const cv = validateCoordinate(memo.lat, memo.lng);
      if (!cv.valid) {
        logger.warn(req, "course.import", { error: cv.error }, name);
        return res.status(400).send(cv.error);
      }
      const wv = validateMemoDimension(memo.width, "너비");
      if (!wv.valid) {
        logger.warn(req, "course.import", { error: wv.error }, name);
        return res.status(400).send(wv.error);
      }
      const hv = validateMemoDimension(memo.height, "높이");
      if (!hv.valid) {
        logger.warn(req, "course.import", { error: hv.error }, name);
        return res.status(400).send(hv.error);
      }
      const rv = validateMemoRotation(memo.rotation);
      if (!rv.valid) {
        logger.warn(req, "course.import", { error: rv.error }, name);
        return res.status(400).send(rv.error);
      }
      const cnv = validateMemoContent(memo.content);
      if (!cnv.valid) {
        logger.warn(req, "course.import", { error: cnv.error }, name);
        return res.status(400).send(cnv.error);
      }
    }

    const routeMarkers = req.body.route_markers === undefined ? [] : req.body.route_markers;
    const routeSteps = req.body.route_steps === undefined ? [] : req.body.route_steps;
    if (
      !Array.isArray(routeMarkers) ||
      !Array.isArray(routeSteps) ||
      routeMarkers.length > 200 ||
      routeSteps.length > 500
    ) {
      logger.warn(req, "course.import", { error: "올바르지 않은 주행 마커 데이터입니다." }, name);
      return res.status(400).send("올바르지 않은 주행 마커 데이터입니다.");
    }
    for (const marker of routeMarkers) {
      const cv = validateCoordinate(marker.lat, marker.lng);
      if (!cv.valid) {
        logger.warn(req, "course.import", { error: cv.error }, name);
        return res.status(400).send(cv.error);
      }
      const lv = validateRouteMarkerLabel(marker.label);
      if (!lv.valid) {
        logger.warn(req, "course.import", { error: lv.error }, name);
        return res.status(400).send(lv.error);
      }
    }
    if (
      routeSteps.some(
        (index) => !Number.isInteger(index) || index < 0 || index >= routeMarkers.length,
      )
    ) {
      logger.warn(
        req,
        "course.import",
        { error: "주행 순서가 존재하지 않는 마커를 참조합니다." },
        name,
      );
      return res.status(400).send("주행 순서가 존재하지 않는 마커를 참조합니다.");
    }

    const reverse = req.body.reverse ? 1 : 0;
    const startIndex = req.body.start_cone_index;
    const result = dbRun(() => {
      return db.transaction(() => {
        db.prepare(
          "INSERT INTO course (name, created_at, updated_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        ).run(nameValidation.value);
        const courseId = db
          .prepare("SELECT id FROM course WHERE id = last_insert_rowid()")
          .get().id;
        const insert = db.prepare(
          "INSERT INTO cone (course_id, lat, lng, alt, side, created_at, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        );
        const coneIds = [];
        for (const cone of cones)
          coneIds.push(
            insert.run(
              courseId,
              cone.lat,
              cone.lng,
              typeof cone.alt === "number" ? cone.alt : null,
              cone.side,
            ).lastInsertRowid,
          );
        // Restore travel direction + start cone (array index → the newly-inserted cone id).
        const startId =
          Number.isInteger(startIndex) && startIndex >= 0 && startIndex < coneIds.length
            ? coneIds[startIndex]
            : null;
        db.prepare("UPDATE course SET reverse = ?, start_cone_id = ? WHERE id = ?").run(
          reverse,
          startId,
          courseId,
        );
        if (memos.length) {
          const memoInsert = db.prepare(
            "INSERT INTO memo (course_id, lat, lng, width, height, rotation, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
          );
          for (const memo of memos) {
            memoInsert.run(
              courseId,
              memo.lat,
              memo.lng,
              memo.width,
              memo.height,
              validateMemoRotation(memo.rotation).value,
              typeof memo.content === "string" ? memo.content : "",
            );
          }
        }
        const markerIds = [];
        if (routeMarkers.length) {
          const markerInsert = db.prepare(
            "INSERT INTO route_marker (course_id, lat, lng, label) VALUES (?, ?, ?, ?)",
          );
          for (const marker of routeMarkers) {
            markerIds.push(
              Number(
                markerInsert.run(
                  courseId,
                  marker.lat,
                  marker.lng,
                  validateRouteMarkerLabel(marker.label).value,
                ).lastInsertRowid,
              ),
            );
          }
          const stepInsert = db.prepare(
            "INSERT INTO route_step (course_id, position, marker_id) VALUES (?, ?, ?)",
          );
          routeSteps.forEach((markerIndex, position) =>
            stepInsert.run(courseId, position, markerIds[markerIndex]),
          );
        }
        return {
          course: db.prepare("SELECT * FROM course WHERE id = ?").get(courseId),
          cones: getCones(courseId),
          memos: getMemos(courseId),
          route: getCourseRoute(courseId),
        };
      })();
    });

    if (!result.success) {
      const msg = result.error?.includes("UNIQUE")
        ? "이미 존재하는 코스 이름입니다."
        : result.error;
      logger.warn(req, "course.import", { error: result.internalError || msg }, name);
      if (result.error?.includes("UNIQUE"))
        return res.status(400).send("이미 존재하는 코스 이름입니다.");
      return res.status(result.status).send(result.error);
    }

    logger.log(
      req,
      "course.import",
      {
        cone_count: cones.length,
        memo_count: memos.length,
        route_marker_count: routeMarkers.length,
        route_step_count: routeSteps.length,
      },
      nameValidation.value,
    );
    broadcastEvent("courses", {
      type: "create",
      course: result.result.course,
      courses: getCourses(),
    });
    broadcastEvent("cones", {
      type: "add",
      courseId: result.result.course.id,
      cones: result.result.cones,
    });
    if (result.result.memos.length) {
      broadcastEvent("memos", {
        type: "add",
        courseId: result.result.course.id,
        memos: result.result.memos,
      });
    }
    if (result.result.route.markers.length) {
      broadcastEvent("route", {
        type: "import",
        courseId: result.result.course.id,
        ...result.result.route,
      });
    }
    res.status(201).json(result.result.course);
  });

  // DELETE /api/courses/:id - 코스 삭제 (콘도 CASCADE 삭제)
  app.delete("/api/courses/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

    const course = getCourseById(id);
    if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

    const activeMission = db
      .prepare(
        `SELECT id,lifecycle_state,plan_hash FROM mission
    WHERE course_id=? AND lifecycle_state IN
    ('ready','starting','running','pausing','paused','interrupted','resuming')
    ORDER BY id DESC LIMIT 1`,
      )
      .get(id);
    if (activeMission) {
      logger.warn(
        req,
        "course.delete",
        {
          error: "active_mission_course",
          reason: "active_mission_course",
          course_id: id,
          mission_id: activeMission.id,
          mission_state: activeMission.lifecycle_state,
          plan_hash: activeMission.plan_hash,
        },
        course.name,
      );
      return res.status(409).json({
        message: "진행 중인 미션이 사용하는 코스는 삭제할 수 없습니다.",
        reason: "active_mission_course",
        mission_id: activeMission.id,
      });
    }

    const result = dbRun(() =>
      db.transaction(() => {
        // course 삭제는 최신 스키마에서 여러 편집 자산을 cascade하고 완료된 미션 기록은
        // 보존한 채 연결만 끊는다. 삭제 전 범위를 같은 트랜잭션에서 세어 감사 로그가
        // 실제 적용 결과와 어긋나지 않게 한다.
        const cascade = {
          cones: db.prepare("SELECT COUNT(*) AS count FROM cone WHERE course_id = ?").get(id).count,
          memos: db.prepare("SELECT COUNT(*) AS count FROM memo WHERE course_id = ?").get(id).count,
          route_markers: db
            .prepare("SELECT COUNT(*) AS count FROM route_marker WHERE course_id = ?")
            .get(id).count,
          route_steps: db
            .prepare("SELECT COUNT(*) AS count FROM route_step WHERE course_id = ?")
            .get(id).count,
          snapshots: db
            .prepare("SELECT COUNT(*) AS count FROM course_snapshot WHERE course_id = ?")
            .get(id).count,
          mission_presets: db
            .prepare("SELECT COUNT(*) AS count FROM mission_route_preset WHERE course_id = ?")
            .get(id).count,
          mission_preset_items: db
            .prepare(
              `SELECT COUNT(*) AS count
        FROM mission_route_preset_item item
        JOIN mission_route_preset preset ON preset.id = item.preset_id
        WHERE preset.course_id = ?`,
            )
            .get(id).count,
        };
        const detached = {
          missions: db.prepare("SELECT COUNT(*) AS count FROM mission WHERE course_id = ?").get(id)
            .count,
          mission_waypoints: db
            .prepare(
              `SELECT COUNT(*) AS count
        FROM mission_waypoint waypoint
        JOIN cone ON cone.id = waypoint.cone_id
        WHERE cone.course_id = ?`,
            )
            .get(id).count,
        };
        db.prepare("DELETE FROM course WHERE id = ?").run(id);
        return { cascade, detached };
      })(),
    );
    if (!result.success) {
      logger.warn(
        req,
        "course.delete",
        { error: result.internalError || result.error },
        course.name,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "course.delete", { course_id: id, ...result.result }, course.name);
    broadcastEvent("courses", { type: "delete", courseId: id, courses: getCourses() });
    res.status(200).send();
  });

  app.get("/api/courses/:id/route", (req, res) => {
    const courseId = parseInt(req.params.id, 10);
    if (isNaN(courseId))
      return rejectRouteRequest(req, res, 400, "course_route.read", "올바르지 않은 코스 ID입니다.");
    const course = getCourseById(courseId);
    if (!course)
      return rejectRouteRequest(
        req,
        res,
        404,
        "course_route.read",
        "코스를 찾을 수 없습니다.",
        null,
        { course_id: courseId },
      );
    const result = dbRun(() => getCourseRoute(courseId));
    if (!result.success) {
      logger.warn(
        req,
        "course_route.read",
        {
          error: result.internalError || result.error,
          course_id: courseId,
        },
        course.name,
      );
      return res.status(result.status).send(result.error);
    }
    res.json(result.result);
  });

  app.put("/api/courses/:id/route/steps", (req, res) => {
    const courseId = parseInt(req.params.id, 10);
    if (isNaN(courseId))
      return rejectRouteRequest(
        req,
        res,
        400,
        "course_route.update",
        "올바르지 않은 코스 ID입니다.",
      );
    const course = getCourseById(courseId);
    if (!course)
      return rejectRouteRequest(
        req,
        res,
        404,
        "course_route.update",
        "코스를 찾을 수 없습니다.",
        null,
        { course_id: courseId },
      );
    const steps = req.body?.steps;
    if (!Array.isArray(steps) || steps.length > 500 || steps.some((id) => !Number.isInteger(id))) {
      return rejectRouteRequest(
        req,
        res,
        400,
        "course_route.update",
        "주행 순서가 올바르지 않습니다. (정수 마커 ID, 최대 500단계)",
        course,
        { requested: steps },
      );
    }
    const markers = db.prepare("SELECT id FROM route_marker WHERE course_id = ?").all(courseId);
    const allowed = new Set(markers.map((row) => row.id));
    if (steps.some((id) => !allowed.has(id)))
      return rejectRouteRequest(
        req,
        res,
        400,
        "course_route.update",
        "다른 코스이거나 존재하지 않는 주행 마커가 포함되어 있습니다.",
        course,
        { requested: steps },
      );
    const before = getCourseRoute(courseId).steps;
    const result = dbRun(() =>
      db.transaction(() => {
        db.prepare("DELETE FROM route_step WHERE course_id = ?").run(courseId);
        const insert = db.prepare(
          "INSERT INTO route_step (course_id, position, marker_id) VALUES (?, ?, ?)",
        );
        steps.forEach((markerId, position) => insert.run(courseId, position, markerId));
        return getCourseRoute(courseId);
      })(),
    );
    if (!result.success) {
      logger.warn(
        req,
        "course_route.update",
        { error: result.internalError || result.error, before, requested: steps },
        course.name,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "course_route.update", { before, after: steps }, course.name);
    broadcastEvent("route", { type: "steps", courseId, ...result.result });
    res.json(result.result);
  });
}
