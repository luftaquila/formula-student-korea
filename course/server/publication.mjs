// FSK-only course publication. A row in course_publication makes the course's
// geometry readable anonymously; the shared course schema knows nothing of it.
export function createCoursePublication(db) {
  const publishedIds = db.prepare("SELECT course_id FROM course_publication");
  const isPublished = db.prepare("SELECT 1 FROM course_publication WHERE course_id = ?");

  const decorateCourse = (course) => course && { ...course, is_public: isPublished.get(course.id) ? 1 : 0 };
  function decorateCourses(courses) {
    const published = new Set(publishedIds.all().map((row) => row.course_id));
    return courses.map((course) => ({ ...course, is_public: published.has(course.id) ? 1 : 0 }));
  }
  function decorateEvent(event, payload) {
    if (event !== "courses") return payload;
    return {
      ...payload,
      ...(payload.course ? { course: decorateCourse(payload.course) } : {}),
      courses: decorateCourses(payload.courses),
    };
  }

  return { decorateCourse, decorateCourses, decorateEvent };
}

export function registerPublicationRoutes(app, { db, logger, service, publication, broadcast }) {
  const list = db.prepare(`SELECT c.id, c.name, COUNT(cn.id) AS cone_count
    FROM course c JOIN course_publication p ON p.course_id = c.id
    LEFT JOIN cone cn ON cn.course_id = c.id GROUP BY c.id ORDER BY c.id`);
  // Keep this projection explicit: adding an operational column must never
  // make it public, and public requests must not read the memo table at all.
  const detail = db.transaction((id) => {
    const course = db.prepare(`SELECT c.id, c.name, c.reverse, c.start_cone_id
      FROM course c JOIN course_publication p ON p.course_id = c.id WHERE c.id = ?`).get(id);
    if (!course) return null;
    const cones = db.prepare("SELECT id, lat, lng, alt, side FROM cone WHERE course_id = ? ORDER BY id").all(id);
    const markers = db.prepare("SELECT id, lat, lng, label FROM route_marker WHERE course_id = ? ORDER BY id").all(id);
    const steps = db.prepare("SELECT marker_id FROM route_step WHERE course_id = ? ORDER BY position").all(id).map((row) => row.marker_id);
    return { course, cones, route: { markers, steps } };
  });
  const publish = db.prepare("INSERT OR IGNORE INTO course_publication (course_id) VALUES (?)");
  const unpublish = db.prepare("DELETE FROM course_publication WHERE course_id = ?");

  function failed(req, res, action, error, target, status = 500) {
    logger.warn(req, action, { error: error?.message || String(error) }, target);
    return res.status(status).send("Server error.");
  }

  app.get("/api/public/courses", (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(list.all());
    } catch (error) {
      failed(req, res, "course.public.list", error);
    }
  });

  app.get("/api/public/courses/:id", (req, res) => {
    res.set("Cache-Control", "no-store");
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).send("Invalid course ID.");
    let result;
    try {
      result = detail(id);
    } catch (error) {
      return failed(req, res, "course.public.read", error, id);
    }
    if (!result) {
      logger.warn(req, "course.public.read", { error: "course_unavailable" }, id);
      return res.status(404).send("Published course not found.");
    }
    res.json(result);
  });

  app.patch("/api/courses/:id/publication", (req, res) => {
    const id = Number(req.params.id);
    const isPublic = req.body?.is_public;
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).send("Invalid course ID.");
    if (typeof isPublic !== "boolean") return res.status(400).send("Publication must be true or false.");
    let result;
    try {
      result = db.transaction(() => {
        const before = publication.decorateCourse(service.reads.getCourse(id));
        if (!before) return null;
        (isPublic ? publish : unpublish).run(id);
        return { before, after: publication.decorateCourse(service.reads.getCourse(id)) };
      })();
    } catch (error) {
      return failed(req, res, "course.publication", error, id);
    }
    if (!result) {
      logger.warn(req, "course.publication", { error: "course_not_found", is_public: isPublic }, id);
      return res.status(404).send("Course not found.");
    }
    const { before, after } = result;
    logger.log(req, "course.publication", {
      before: { is_public: !!before.is_public }, after: { is_public: !!after.is_public },
    }, id);
    broadcast("courses", publication.decorateEvent("courses", {
      type: "publication", course: after, courses: service.reads.listCourses(),
    }));
    res.json(after);
  });
}
