import {
  assertCurrentCompetitionYear,
  currentCompetitionYear,
  parseCompetitionYear,
} from "../../shared/competition-year.mjs";

function parseExplicitYear(value) {
  if (value == null || value === "") return null;
  return assertCurrentCompetitionYear(value);
}

function addExplicitYear(years, value) {
  const year = parseExplicitYear(value);
  if (year != null) years.add(year);
}

function addStoredYear(years, value) {
  if (value != null) years.add(assertCurrentCompetitionYear(value));
}

export function normalizedPath(req) {
  return (req.path.replace(/\/+$/, "") || "/").toLowerCase();
}

function decodePathCapture(value) {
  try { return decodeURIComponent(value); }
  catch {
    throw Object.assign(new Error("올바르지 않은 경로 인코딩입니다."), {
      status: 400,
      code: "INVALID_PATH_ENCODING",
    });
  }
}

function addInspectionYears(req, db, years) {
  const path = normalizedPath(req);
  const templateCapture = path.match(/^\/api\/sheet\/template\/([^/]+)$/)?.[1];
  const templateId = templateCapture == null ? null : Number(decodePathCapture(templateCapture));
  if (Number.isInteger(templateId)) {
    addStoredYear(years, db.prepare("SELECT year FROM sheet_template WHERE id = ?").get(templateId)?.year);
    return;
  }
  if (path === "/api/sheet/template/reorder") {
    if (Array.isArray(req.body?.items)) {
      const lookup = db.prepare("SELECT year FROM sheet_template WHERE id = ?");
      for (const item of req.body.items) addStoredYear(years, lookup.get(Number(item?.id))?.year);
    }
    return;
  }
  if (path === "/api/sheet/template/copy") {
    parseCompetitionYear(req.body?.from_year, { defaultCurrent: false });
    addExplicitYear(years, req.body?.to_year);
    return;
  }
  if (path === "/api/sheet/template"
    || path === "/api/sheet/template/import"
    || /^\/api\/sheet\/(?:answer|memo|category-result)$/.test(path)) {
    addExplicitYear(years, req.body?.year);
    return;
  }
  years.add(currentCompetitionYear());
}

function addDocumentYears(req, db, years) {
  const path = normalizedPath(req);
  const sessionCapture = path.match(/^\/api\/(?:admin\/)?sessions\/([^/]+)(?:\/submit)?$/)?.[1];
  const sessionId = sessionCapture == null ? null : Number(decodePathCapture(sessionCapture));
  if (Number.isInteger(sessionId)) {
    addStoredYear(years, db.prepare("SELECT year FROM session WHERE id = ?").get(sessionId)?.year);
    return;
  }
  if (path === "/api/admin/sessions" || path === "/api/admin/student-teams") {
    addExplicitYear(years, req.body?.year);
    return;
  }
  const studentTeamYear = path.match(/^\/api\/admin\/student-teams\/[^/]+\/([^/]+)$/)?.[1];
  if (studentTeamYear != null) {
    addExplicitYear(years, decodePathCapture(studentTeamYear));
    return;
  }
  const fileYear = path.match(/^\/api\/admin\/years\/([^/]+)\/files$/)?.[1];
  if (fileYear != null) {
    addExplicitYear(years, decodePathCapture(fileYear));
    return;
  }
  years.add(currentCompetitionYear());
}

function addTrafficYears(req, years) {
  const recordCapture = normalizedPath(req).match(/^\/api\/records\/([^/]+)(?:\/|$)/)?.[1];
  if (recordCapture == null) {
    years.add(currentCompetitionYear());
    return;
  }
  const recordName = decodePathCapture(recordCapture);
  const recordYear = recordName.match(/^fsk (\d{4}) /)?.[1];
  if (recordYear == null) {
    throw Object.assign(new Error("기록 이름에서 대회 연도를 확인할 수 없습니다."), {
      status: 400,
      code: "INVALID_RECORD_YEAR",
    });
  }
  addExplicitYear(years, recordYear);
}

function addRegistrationYears(req, db, years) {
  const path = normalizedPath(req);
  if (path === "/api/lookup") return true;
  if (path === "/api/queue") {
    addStoredYear(
      years,
      db.prepare("SELECT year FROM competition_team WHERE id = ?").get(Number(req.body?.teamId))?.year,
    );
    return false;
  }
  const transition = path.match(/^\/api\/queue\/([^/]+)\/(?:done|cancel)$/);
  if (transition) {
    const registrationId = Number(transition[1]);
    if (Number.isInteger(registrationId)) {
      addStoredYear(years, db.prepare(`
        SELECT t.year
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE q.id = ?
      `).get(registrationId)?.year);
    }
    return false;
  }
  // The retired call route is intentionally absent and must continue through to
  // Express's 404 instead of being mistaken for a newly added mutation.
  if (/^\/api\/queue\/[^/]+\/call$/.test(path)) return true;
  if (path === "/api/settings") {
    addExplicitYear(years, req.body?.year);
    return false;
  }
  throw Object.assign(new Error("등록 대기열 변경 경로의 연도를 확인할 수 없습니다."), {
    status: 500,
    code: "UNKNOWN_REGISTRATION_MUTATION",
  });
}

export function createModuleYearGuard({ module, db }) {
  return function requireCurrentCompetitionYear(req) {
    const years = new Set();
    let credentialedRead = false;
    if (module === "queue") years.add(currentCompetitionYear());
    else if (module === "registration") credentialedRead = addRegistrationYears(req, db, years);
    else if (module === "inspection") addInspectionYears(req, db, years);
    else if (module === "traffic") addTrafficYears(req, years);
    else if (module === "score") addExplicitYear(years, req.body?.year);
    else if (module === "documents") addDocumentYears(req, db, years);
    else years.add(currentCompetitionYear());
    if (credentialedRead) return { module, years: [] };
    if (years.size === 0) years.add(currentCompetitionYear());
    for (const year of years) assertCurrentCompetitionYear(year);
    return { module, years: [...years].sort((a, b) => a - b) };
  };
}
