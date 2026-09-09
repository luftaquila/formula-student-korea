export function registerMarkersRoutes({
  app,
  rejectRouteRequest,
  getCourseById,
  validateCoordinate,
  validateRouteMarkerLabel,
  db,
  dbRun,
  getCourseRoute,
  logger,
  broadcastEvent,
  getRouteMarkerById,
}) {
  app.post("/api/courses/:id/route/markers", (req, res) => {
    const courseId = parseInt(req.params.id, 10);
    if (isNaN(courseId))
      return rejectRouteRequest(
        req,
        res,
        400,
        "route_marker.create",
        "올바르지 않은 코스 ID입니다.",
      );
    const course = getCourseById(courseId);
    if (!course)
      return rejectRouteRequest(
        req,
        res,
        404,
        "route_marker.create",
        "코스를 찾을 수 없습니다.",
        null,
        { course_id: courseId },
      );
    const body = req.body || {};
    const coord = validateCoordinate(body.lat, body.lng);
    if (!coord.valid)
      return rejectRouteRequest(req, res, 400, "route_marker.create", coord.error, course, {
        lat: body.lat,
        lng: body.lng,
      });
    const label = validateRouteMarkerLabel(body.label);
    if (!label.valid)
      return rejectRouteRequest(req, res, 400, "route_marker.create", label.error, course);
    const markerCount = db
      .prepare("SELECT COUNT(*) AS n FROM route_marker WHERE course_id = ?")
      .get(courseId).n;
    if (markerCount >= 200)
      return rejectRouteRequest(
        req,
        res,
        400,
        "route_marker.create",
        "주행 마커는 코스당 최대 200개까지 만들 수 있습니다.",
        course,
        { marker_count: markerCount },
      );
    const result = dbRun(() => {
      const info = db
        .prepare("INSERT INTO route_marker (course_id, lat, lng, label) VALUES (?, ?, ?, ?)")
        .run(courseId, body.lat, body.lng, label.value);
      const marker = db
        .prepare("SELECT * FROM route_marker WHERE id = ?")
        .get(info.lastInsertRowid);
      return { marker, route: getCourseRoute(courseId) };
    });
    if (!result.success) {
      logger.warn(
        req,
        "route_marker.create",
        { error: result.internalError || result.error, lat: body.lat, lng: body.lng },
        course.name,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(
      req,
      "route_marker.create",
      { marker_id: result.result.marker.id, lat: body.lat, lng: body.lng, label: label.value },
      course.name,
    );
    broadcastEvent("route", { type: "marker_add", courseId, ...result.result.route });
    res.status(201).json(result.result.marker);
  });

  app.patch("/api/route/markers/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id))
      return rejectRouteRequest(
        req,
        res,
        400,
        "route_marker.update",
        "올바르지 않은 주행 마커 ID입니다.",
      );
    const marker = getRouteMarkerById(id);
    if (!marker)
      return rejectRouteRequest(
        req,
        res,
        404,
        "route_marker.update",
        "주행 마커를 찾을 수 없습니다.",
        null,
        { marker_id: id },
      );
    const course = getCourseById(marker.course_id);
    const body = req.body || {};
    const sets = [],
      values = [];
    if (body.lat !== undefined || body.lng !== undefined) {
      const lat = body.lat ?? marker.lat,
        lng = body.lng ?? marker.lng;
      const coord = validateCoordinate(lat, lng);
      if (!coord.valid)
        return rejectRouteRequest(req, res, 400, "route_marker.update", coord.error, course, {
          marker_id: id,
          lat,
          lng,
        });
      if (body.lat !== undefined) {
        sets.push("lat = ?");
        values.push(body.lat);
      }
      if (body.lng !== undefined) {
        sets.push("lng = ?");
        values.push(body.lng);
      }
    }
    if (body.label !== undefined) {
      const label = validateRouteMarkerLabel(body.label);
      if (!label.valid)
        return rejectRouteRequest(req, res, 400, "route_marker.update", label.error, course, {
          marker_id: id,
        });
      sets.push("label = ?");
      values.push(label.value);
    }
    if (!sets.length)
      return rejectRouteRequest(
        req,
        res,
        400,
        "route_marker.update",
        "수정할 필드가 없습니다.",
        course,
        { marker_id: id },
      );
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    const result = dbRun(() => {
      db.prepare(`UPDATE route_marker SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
      return { marker: getRouteMarkerById(id), route: getCourseRoute(marker.course_id) };
    });
    if (!result.success) {
      logger.warn(
        req,
        "route_marker.update",
        { error: result.internalError || result.error, marker_id: id },
        course?.name,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(
      req,
      "route_marker.update",
      {
        marker_id: id,
        before: { lat: marker.lat, lng: marker.lng, label: marker.label },
        after: {
          lat: result.result.marker.lat,
          lng: result.result.marker.lng,
          label: result.result.marker.label,
        },
      },
      course?.name,
    );
    broadcastEvent("route", {
      type: "marker_update",
      courseId: marker.course_id,
      ...result.result.route,
    });
    res.json(result.result.marker);
  });

  app.delete("/api/route/markers/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id))
      return rejectRouteRequest(
        req,
        res,
        400,
        "route_marker.delete",
        "올바르지 않은 주행 마커 ID입니다.",
      );
    const marker = getRouteMarkerById(id);
    if (!marker)
      return rejectRouteRequest(
        req,
        res,
        404,
        "route_marker.delete",
        "주행 마커를 찾을 수 없습니다.",
        null,
        { marker_id: id },
      );
    const course = getCourseById(marker.course_id);
    const before = getCourseRoute(marker.course_id);
    const result = dbRun(() =>
      db.transaction(() => {
        db.prepare("DELETE FROM route_marker WHERE id = ?").run(id);
        // ON DELETE CASCADE removes visits; compact positions to keep exports stable.
        const steps = db
          .prepare("SELECT marker_id FROM route_step WHERE course_id = ? ORDER BY position")
          .all(marker.course_id);
        db.prepare("DELETE FROM route_step WHERE course_id = ?").run(marker.course_id);
        const insert = db.prepare(
          "INSERT INTO route_step (course_id, position, marker_id) VALUES (?, ?, ?)",
        );
        steps.forEach((row, position) => insert.run(marker.course_id, position, row.marker_id));
        return getCourseRoute(marker.course_id);
      })(),
    );
    if (!result.success) {
      logger.warn(
        req,
        "route_marker.delete",
        {
          error: result.internalError || result.error,
          marker_id: id,
          visit_count: before.steps.filter((x) => x === id).length,
        },
        course?.name,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(
      req,
      "route_marker.delete",
      {
        marker_id: id,
        lat: marker.lat,
        lng: marker.lng,
        label: marker.label,
        removed_visits: before.steps.filter((x) => x === id).length,
      },
      course?.name,
    );
    broadcastEvent("route", {
      type: "marker_delete",
      courseId: marker.course_id,
      ...result.result,
    });
    res.status(200).json(result.result);
  });
}
