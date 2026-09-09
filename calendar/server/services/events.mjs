export function createEventService({ canonicalAudience, logger, ALLOWED_EVENT_ROLES }) {
  function toEventResponse(row) {
    return {
      id: row.id,
      title: row.title,
      start: row.start,
      end: row.end,
      description: row.description,
      location: row.location,
      allDay: !!row.all_day,
      calendarId: row.role,
      role: row.role,
    };
  }

  function validDateParts(year, month, day, hour = 0, minute = 0) {
    const d = new Date(Date.UTC(year, month - 1, day, hour, minute));
    return (
      d.getUTCFullYear() === year &&
      d.getUTCMonth() === month - 1 &&
      d.getUTCDate() === day &&
      d.getUTCHours() === hour &&
      d.getUTCMinutes() === minute
    );
  }

  function toUtcIso({ yy, mo, dd, hh = "00", mi = "00", ss = "00", zone = "" }) {
    const text = zone
      ? `${yy}-${mo}-${dd}T${hh}:${mi}:${ss}${zone}`
      : new Date(
          Date.UTC(Number(yy), Number(mo) - 1, Number(dd), Number(hh) - 9, Number(mi), Number(ss)),
        ).toISOString();
    if (zone) {
      const d = new Date(text);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    return text;
  }

  function normalizeDateTime(value, { allDay = false, requireTime = false } = {}) {
    if (typeof value !== "string") return null;
    const input = value.trim();
    const dateOnly = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
      const [, yy, mm, dd] = dateOnly;
      const [y, m, d] = [Number(yy), Number(mm), Number(dd)];
      if (!validDateParts(y, m, d)) return null;
      if (requireTime && !allDay) return null;
      return `${yy}-${mm}-${dd}`;
    }
    const dateTime = input.match(
      /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
    );
    if (!dateTime) return null;
    const [, yy, mo, dd, hh, mi, ss = "00", zone = ""] = dateTime;
    const [y, m, d, hour, minute] = [Number(yy), Number(mo), Number(dd), Number(hh), Number(mi)];
    if (!validDateParts(y, m, d, hour, minute)) return null;
    return allDay ? `${yy}-${mo}-${dd}` : toUtcIso({ yy, mo, dd, hh, mi, ss, zone });
  }

  function normalizeRangeBound(value, endOfDay = false) {
    if (typeof value !== "string") return null;
    const input = value.trim();
    const dateOnly = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
      const [, yy, mo, dd] = dateOnly;
      const [y, m, d] = [Number(yy), Number(mo), Number(dd)];
      if (!validDateParts(y, m, d)) return null;
      const localMs = Date.UTC(
        y,
        m - 1,
        d,
        endOfDay ? 23 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 999 : 0,
      );
      return new Date(localMs - 9 * 3600000).toISOString();
    }
    return normalizeDateTime(input);
  }

  function kstDateFromUtcIso(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  }

  function canSeeAudience(principal, audience) {
    const role = canonicalAudience(audience);
    if (role === "public") return true;
    if (principal?.kind !== "human") return false;
    if (role === "student") return ["student", "official", "admin"].includes(principal.role);
    return ["official", "admin"].includes(principal.role);
  }

  // 이벤트 입력 검증 (생성·수정 공유). 실패 시 응답을 보내고 null 반환, 성공 시 { role }.
  function validateEventInput(req, res, action, target) {
    const { title, start, end } = req.body;
    if (!title || !start || !end) {
      logger.warn(
        req,
        action,
        { error: "title, start, and end are required", title, start, end },
        target,
      );
      res.status(400).send("제목, 시작, 종료는 필수입니다.");
      return null;
    }
    const allDay = !!req.body.allDay;
    const normalizedStart = normalizeDateTime(start, { allDay, requireTime: true });
    const normalizedEnd = normalizeDateTime(end, { allDay, requireTime: true });
    if (!normalizedStart || !normalizedEnd) {
      logger.warn(req, action, { error: "invalid start/end format", start, end, allDay }, target);
      res.status(400).send("시작 또는 종료 형식이 올바르지 않습니다.");
      return null;
    }
    if (normalizedStart > normalizedEnd) {
      logger.warn(
        req,
        action,
        { error: "start must not be after end", start: normalizedStart, end: normalizedEnd },
        target,
      );
      res.status(400).send("시작은 종료보다 늦을 수 없습니다.");
      return null;
    }
    const role = req.body.role || "official";
    if (!ALLOWED_EVENT_ROLES.includes(role)) {
      logger.warn(req, action, { error: "Invalid role value", role }, target);
      res.status(400).send("올바르지 않은 공개 범위입니다.");
      return null;
    }
    return { role, start: normalizedStart, end: normalizedEnd, allDay };
  }

  return {
    toEventResponse,
    normalizeDateTime,
    normalizeRangeBound,
    kstDateFromUtcIso,
    canSeeAudience,
    validateEventInput,
  };
}
