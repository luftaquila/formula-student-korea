export function registerPublicCourseRoutes(app, { db, dbRun, logger, getCourseById, getCourses, broadcastEvent }) {
  const list = db.prepare(`SELECT c.id, c.name, COUNT(cn.id) AS cone_count
    FROM course c LEFT JOIN cone cn ON cn.course_id = c.id
    WHERE c.is_public = 1 GROUP BY c.id ORDER BY c.id`);
  // Keep this projection explicit: adding an operational column must never
  // make it public, and public requests must not read the memo table at all.
  const detail = db.transaction((id) => {
    const course = db.prepare(`SELECT id, name, reverse, start_cone_id
      FROM course WHERE id = ? AND is_public = 1`).get(id);
    if (!course) return null;
    const cones = db.prepare("SELECT id, lat, lng, alt, side FROM cone WHERE course_id = ? ORDER BY id").all(id);
    const markers = db.prepare("SELECT id, lat, lng, label FROM route_marker WHERE course_id = ? ORDER BY id").all(id);
    const steps = db.prepare("SELECT marker_id FROM route_step WHERE course_id = ? ORDER BY position").all(id).map((row) => row.marker_id);
    return { course, cones, route: { markers, steps } };
  });

  function failed(req, res, action, result, target) {
    logger.warn(req, action, { error: result.internalError || result.error }, target);
    return res.status(result.status).send(result.error);
  }

  app.get("/api/public/courses", (req, res) => {
    res.set("Cache-Control", "no-store");
    const result = dbRun(() => list.all());
    if (!result.success) return failed(req, res, "course.public.list", result);
    res.json(result.result);
  });

  app.get("/api/public/courses/:id", (req, res) => {
    res.set("Cache-Control", "no-store");
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).send("올바르지 않은 코스 ID입니다.");
    const result = dbRun(() => detail(id));
    if (!result.success) return failed(req, res, "course.public.read", result, id);
    if (!result.result) {
      logger.warn(req, "course.public.read", { error: "course_unavailable" }, id);
      return res.status(404).send("공개된 코스를 찾을 수 없습니다.");
    }
    res.json(result.result);
  });

  app.patch("/api/courses/:id/publication", (req, res) => {
    const id = Number(req.params.id);
    const isPublic = req.body?.is_public;
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).send("올바르지 않은 코스 ID입니다.");
    if (typeof isPublic !== "boolean") return res.status(400).send("공개 여부는 true 또는 false여야 합니다.");
    const result = dbRun(() => db.transaction(() => {
      const before = getCourseById(id);
      if (!before) return null;
      db.prepare(`UPDATE course SET is_public = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(Number(isPublic), id);
      return { before, after: getCourseById(id) };
    })());
    if (!result.success) return failed(req, res, "course.publication", result, id);
    if (!result.result) {
      logger.warn(req, "course.publication", { error: "course_not_found", is_public: isPublic }, id);
      return res.status(404).send("코스를 찾을 수 없습니다.");
    }
    const { before, after } = result.result;
    logger.log(req, "course.publication", {
      before: { is_public: !!before.is_public }, after: { is_public: !!after.is_public },
    }, id);
    broadcastEvent("courses", { type: "publication", course: after, courses: getCourses() });
    res.json(after);
  });

}
