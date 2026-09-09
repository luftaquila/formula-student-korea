export function registerMemosRoutes({
  app,
  getCourseById,
  dbRun,
  getMemos,
  validateCoordinate,
  validateMemoDimension,
  validateMemoRotation,
  validateMemoContent,
  db,
  logger,
  broadcastEvent,
  getMemoById,
}) {
  /* ============================================
   API 라우트: 메모 스티커
   ============================================ */

  // GET /api/courses/:id/memos - 코스의 메모 목록 조회
  app.get("/api/courses/:id/memos", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

    const course = getCourseById(id);
    if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

    const result = dbRun(() => getMemos(id));
    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });

  // POST /api/courses/:id/memos - 메모 추가
  app.post("/api/courses/:id/memos", (req, res) => {
    const courseId = parseInt(req.params.id, 10);
    if (isNaN(courseId)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

    const course = getCourseById(courseId);
    if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

    const { lat, lng, width, height, rotation, content } = req.body;

    const coordValidation = validateCoordinate(lat, lng);
    if (!coordValidation.valid) return res.status(400).send(coordValidation.error);
    const wV = validateMemoDimension(width, "너비");
    if (!wV.valid) return res.status(400).send(wV.error);
    const hV = validateMemoDimension(height, "높이");
    if (!hV.valid) return res.status(400).send(hV.error);
    const rV = validateMemoRotation(rotation);
    if (!rV.valid) return res.status(400).send(rV.error);
    const cV = validateMemoContent(content);
    if (!cV.valid) return res.status(400).send(cV.error);

    const result = dbRun(() => {
      db.prepare(
        "INSERT INTO memo (course_id, lat, lng, width, height, rotation, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      ).run(courseId, lat, lng, wV.value, hV.value, rV.value, cV.value);
      return db.prepare("SELECT * FROM memo WHERE id = last_insert_rowid()").get();
    });

    if (!result.success) {
      logger.warn(req, "memo.create", { error: result.internalError || result.error }, course.name);
      return res.status(result.status).send(result.error);
    }

    logger.log(
      req,
      "memo.create",
      { lat, lng, width: wV.value, height: hV.value, rotation: rV.value },
      course.name,
    );
    broadcastEvent("memos", {
      type: "add",
      courseId,
      memo: result.result,
      memos: getMemos(courseId),
    });
    res.status(201).json(result.result);
  });

  // PATCH /api/memos/:id - 메모 수정 (위치, 크기, 내용)
  app.patch("/api/memos/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).send("올바르지 않은 메모 ID입니다.");

    const memo = getMemoById(id);
    if (!memo) return res.status(404).send("메모를 찾을 수 없습니다.");

    const setClauses = [];
    const values = [];

    if (req.body.lat !== undefined || req.body.lng !== undefined) {
      const lat = req.body.lat !== undefined ? req.body.lat : memo.lat;
      const lng = req.body.lng !== undefined ? req.body.lng : memo.lng;
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

    if (req.body.width !== undefined) {
      const wV = validateMemoDimension(req.body.width, "너비");
      if (!wV.valid) return res.status(400).send(wV.error);
      setClauses.push("width = ?");
      values.push(wV.value);
    }

    if (req.body.height !== undefined) {
      const hV = validateMemoDimension(req.body.height, "높이");
      if (!hV.valid) return res.status(400).send(hV.error);
      setClauses.push("height = ?");
      values.push(hV.value);
    }

    if (req.body.rotation !== undefined) {
      const rV = validateMemoRotation(req.body.rotation);
      if (!rV.valid) return res.status(400).send(rV.error);
      setClauses.push("rotation = ?");
      values.push(rV.value);
    }

    if (req.body.content !== undefined) {
      const cV = validateMemoContent(req.body.content);
      if (!cV.valid) return res.status(400).send(cV.error);
      setClauses.push("content = ?");
      values.push(cV.value);
    }

    if (setClauses.length === 0) {
      return res.status(400).send("수정할 필드가 없습니다.");
    }

    setClauses.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");

    const result = dbRun(() => {
      values.push(id);
      db.prepare(`UPDATE memo SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
      return db.prepare("SELECT * FROM memo WHERE id = ?").get(id);
    });

    if (!result.success) {
      const memoCourse = getCourseById(memo.course_id);
      logger.warn(
        req,
        "memo.update",
        { error: result.internalError || result.error },
        memoCourse?.name,
      );
      return res.status(result.status).send(result.error);
    }

    const memoCourse = getCourseById(memo.course_id);
    // 변경된 필드만 before/after로 기록한다. content는 길 수 있으므로 100자로 자른다.
    const changes = {};
    for (const field of ["lat", "lng", "width", "height", "rotation", "content"]) {
      if (memo[field] !== result.result[field]) {
        const truncate = (v) =>
          field === "content" && typeof v === "string" ? v.slice(0, 100) : v;
        changes[field] = { from: truncate(memo[field]), to: truncate(result.result[field]) };
      }
    }
    logger.log(req, "memo.update", { changes }, memoCourse?.name);
    broadcastEvent("memos", {
      type: "update",
      courseId: memo.course_id,
      memo: result.result,
      memos: getMemos(memo.course_id),
    });
    res.json(result.result);
  });

  // DELETE /api/memos/:id - 메모 삭제
  app.delete("/api/memos/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).send("올바르지 않은 메모 ID입니다.");

    const memo = getMemoById(id);
    if (!memo) return res.status(404).send("메모를 찾을 수 없습니다.");

    const result = dbRun(() => db.prepare("DELETE FROM memo WHERE id = ?").run(id));
    if (!result.success) {
      const delCourse = getCourseById(memo.course_id);
      logger.warn(
        req,
        "memo.delete",
        { error: result.internalError || result.error },
        delCourse?.name,
      );
      return res.status(result.status).send(result.error);
    }

    const delCourse = getCourseById(memo.course_id);
    logger.log(req, "memo.delete", { lat: memo.lat, lng: memo.lng }, delCourse?.name);
    broadcastEvent("memos", {
      type: "delete",
      courseId: memo.course_id,
      memoId: id,
      memos: getMemos(memo.course_id),
    });
    res.status(200).send();
  });
}
