const YEAR_MIN = 2000;
const YEAR_MAX = 2099;
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const SEOUL_YEAR = new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Seoul",
  year: "numeric",
});

export function currentCompetitionYear(now = new Date()) {
  return Number(SEOUL_YEAR.format(now));
}

export function competitionTeamWriteYears({ now } = {}) {
  const currentYear = currentCompetitionYear(now);
  return currentYear < YEAR_MAX ? [currentYear, currentYear + 1] : [currentYear];
}

export function competitionDateStart(value) {
  const match = typeof value === "string" && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < YEAR_MIN || year > YEAR_MAX || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const timestamp = Date.UTC(year, month - 1, day) - SEOUL_OFFSET_MS;
  return formatCompetitionDate(timestamp) === value ? timestamp : null;
}

export function formatCompetitionDate(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return "";
  const seoul = new Date(Number(timestamp) + SEOUL_OFFSET_MS);
  if (Number.isNaN(seoul.getTime())) return "";
  const year = seoul.getUTCFullYear();
  const month = String(seoul.getUTCMonth() + 1).padStart(2, "0");
  const day = String(seoul.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function competitionYearBounds(yearValue) {
  const year = parseCompetitionYear(yearValue, { defaultCurrent: false });
  const from = competitionDateStart(`${year}-01-01`);
  // The upper boundary is a sentinel, not a selectable competition year.
  // In particular, 2099 must end at the start of 2100 even though 2100 is
  // intentionally rejected by parseCompetitionYear/competitionDateStart.
  const toExclusive = Date.UTC(year + 1, 0, 1) - SEOUL_OFFSET_MS;
  return { from, toExclusive, to: toExclusive - 1 };
}

export function parseCompetitionYear(value, { defaultCurrent = true, now } = {}) {
  if (value == null || value === "") {
    if (defaultCurrent) return currentCompetitionYear(now);
    throw invalidYear(value);
  }
  const year = Number(value);
  if (!Number.isInteger(year) || year < YEAR_MIN || year > YEAR_MAX) throw invalidYear(value);
  return year;
}

export function assertCurrentCompetitionYear(yearValue, { now } = {}) {
  const year = parseCompetitionYear(yearValue, { now });
  const currentYear = currentCompetitionYear(now);
  if (year !== currentYear) {
    throw Object.assign(new Error(`${year}년은 읽기 전용입니다. 현재 연도(${currentYear})만 수정할 수 있습니다.`), {
      status: 409,
      code: "YEAR_READ_ONLY",
      year,
      currentYear,
    });
  }
  return year;
}

export function assertCompetitionTeamWriteYear(yearValue, { now } = {}) {
  const year = parseCompetitionYear(yearValue, { now });
  const writableYears = competitionTeamWriteYears({ now });
  if (!writableYears.includes(year)) {
    const currentYear = writableYears[0];
    const nextYear = writableYears[1];
    const writableDescription = nextYear == null
      ? `현재 연도(${currentYear})`
      : `현재 연도(${currentYear})와 다음 연도(${nextYear})`;
    throw Object.assign(new Error(`${year}년은 읽기 전용입니다. 엔트리는 ${writableDescription}만 수정할 수 있습니다.`), {
      status: 409,
      code: "YEAR_READ_ONLY",
      year,
      currentYear,
    });
  }
  return year;
}

export function sendYearError(res, error) {
  const status = Number(error?.status) || 500;
  return res.status(status).json({
    code: error?.code || "YEAR_ERROR",
    message: error?.message || "연도를 확인할 수 없습니다.",
    ...(error?.year == null ? {} : { year: error.year }),
    ...(error?.currentYear == null ? {} : { currentYear: error.currentYear }),
  });
}

function invalidYear(value) {
  const error = Object.assign(new Error("올바르지 않은 연도입니다."), {
    status: 400,
    code: "INVALID_YEAR",
  });
  const year = Number(value);
  if (Number.isFinite(year)) error.year = year;
  return error;
}
