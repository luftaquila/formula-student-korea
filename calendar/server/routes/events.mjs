export function registerEventsRoutes({
  app,
  logger,
  normalizeRangeBound,
  kstDateFromUtcIso,
  dbRun,
  db,
  canSeeAudience,
  toEventResponse,
  validateEventInput,
}) {
  // List events (public access, filtered by user role)
  app.get("/api/events", (req, res) => {
    const { timeMin, timeMax } = req.query;
    if (!timeMin || !timeMax) {
      logger.warn(req, "event.list", { error: "timeMin and timeMax are required" });
      return res.status(400).send("timeMin과 timeMax가 필요합니다.");
    }

    const normalizedMin = normalizeRangeBound(String(timeMin), false);
    const normalizedMax = normalizeRangeBound(String(timeMax), true);
    if (!normalizedMin || !normalizedMax) {
      logger.warn(req, "event.list", { error: "invalid timeMin/timeMax", timeMin, timeMax });
      return res.status(400).send("올바르지 않은 시간 범위입니다.");
    }
    const minAllDayDate = kstDateFromUtcIso(normalizedMin);
    const maxAllDayDate = kstDateFromUtcIso(normalizedMax);

    const result = dbRun(() =>
      db
        .prepare(
          `
      SELECT * FROM (
        SELECT * FROM events WHERE all_day = 0 AND end >= ? AND start <= ?
        UNION ALL
        SELECT * FROM events WHERE all_day = 1 AND end >= ? AND start <= ?
      )
      ORDER BY start
    `,
        )
        .all(normalizedMin, normalizedMax, minAllDayDate, maxAllDayDate),
    );

    if (!result.success) {
      logger.warn(req, "event.list", { error: result.internalError || result.error });
      return res.status(result.status).json({ error: result.error });
    }

    const events = result.result
      .filter((event) => canSeeAudience(req.user, event.role))
      .map(toEventResponse);
    res.json(events);
  });

  // Create event
  app.post("/api/events", (req, res) => {
    const { title } = req.body;
    const valid = validateEventInput(req, res, "event.create", null);
    if (!valid) return;
    const { role, start, end, allDay } = valid;

    const description = req.body.description || "";
    const location = req.body.location || "";

    const result = dbRun(() =>
      db
        .prepare(
          "INSERT INTO events (title, description, location, start, end, all_day, role) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(title, description, location, start, end, allDay ? 1 : 0, role),
    );

    if (!result.success) {
      logger.warn(req, "event.create", {
        error: result.internalError || result.error,
        title,
        start,
        end,
      });
      return res.status(result.status).json({ error: result.error });
    }

    const event = db
      .prepare("SELECT * FROM events WHERE id = ?")
      .get(result.result.lastInsertRowid);
    logger.log(req, "event.create", { title, start, end, allDay, role }, `${event.id}`);
    res.status(201).json(toEventResponse(event));
  });

  // Update event
  app.put("/api/events/:id", (req, res) => {
    const { id } = req.params;
    const { title } = req.body;
    const valid = validateEventInput(req, res, "event.update", id);
    if (!valid) return;
    const { role, start, end, allDay } = valid;

    const existing = db.prepare("SELECT id, role FROM events WHERE id = ?").get(id);
    if (!existing) return res.status(404).send("일정을 찾을 수 없습니다.");

    const description = req.body.description || "";
    const location = req.body.location || "";

    const result = dbRun(() =>
      db
        .prepare(
          "UPDATE events SET title = ?, description = ?, location = ?, start = ?, end = ?, all_day = ?, role = ? WHERE id = ?",
        )
        .run(title, description, location, start, end, allDay ? 1 : 0, role, id),
    );

    if (!result.success) {
      logger.warn(
        req,
        "event.update",
        { error: result.internalError || result.error, title, start, end },
        id,
      );
      return res.status(result.status).json({ error: result.error });
    }

    const event = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
    logger.log(req, "event.update", { title, start, end, allDay, role }, id);
    res.json(toEventResponse(event));
  });

  // Delete event
  app.delete("/api/events/:id", (req, res) => {
    const { id } = req.params;

    const existing = db.prepare("SELECT title, role FROM events WHERE id = ?").get(id);
    if (!existing) return res.status(404).send("일정을 찾을 수 없습니다.");

    const result = dbRun(() => db.prepare("DELETE FROM events WHERE id = ?").run(id));

    if (!result.success) {
      logger.warn(req, "event.delete", { error: result.internalError || result.error }, id);
      return res.status(result.status).json({ error: result.error });
    }

    logger.log(req, "event.delete", { title: existing.title }, id);
    res.status(204).end();
  });
}
