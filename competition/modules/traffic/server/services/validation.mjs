import { currentCompetitionYear } from "../../../../../shared/common/competition-year.mjs";
import { isTeamActive } from "../../../../lib/team-status.mjs";
import { RESULT_STATUSES } from "../../../../../shared/common/constants.js";

export function createTrafficValidation({ logger, dbRun, options, db }) {
  // 제어권 식별자: 같은 계정이라도 브라우저 탭(세션)별로 구분돼야 한 탭의 claim/takeover가
  // 다른 탭에 잘못 반영되지 않는다. 클라가 보내는 X-Session-Id로 email#sid 합성(헤더 없으면 email).
  function wirelessActor(req) {
    const email = req.user?.email || null;
    if (!email) return null;
    const sid = req.get("X-Session-Id");
    return sid ? `${email}#${sid}` : email;
  }

  // 표시·계정 게이팅용: controller에서 email 부분만(세션 접미 #sid 제거).
  function controllerEmail(c) {
    if (!c) return c;
    const i = c.indexOf("#");
    return i === -1 ? c : c.slice(0, i);
  }

  function rejectMutation(req, res, { action, status, message, target, operation, context = {} }) {
    logger.warn(
      req,
      action,
      {
        error: message,
        reason: message,
        operation,
        ...context,
      },
      target,
    );
    return res.status(status).send(message);
  }

  function runRecordPreflight(req, res, { action, operation, target, lookup }) {
    const result = dbRun(lookup);
    if (!result.success) {
      const error = result.internalError || result.error;
      logger.warn(
        req,
        action,
        {
          error,
          reason: error,
          operation,
          phase: "record_preflight",
        },
        target,
      );
      res.status(500).send("기록 정보를 확인할 수 없습니다.");
      return { ok: false, value: null };
    }
    if (result.result?.rejection) {
      const rejection = result.result.rejection;
      rejectMutation(req, res, {
        action,
        status: rejection.status,
        message: rejection.message,
        target,
        operation,
        context: rejection.context,
      });
      return { ok: false, value: null };
    }
    return { ok: true, value: result.result?.value };
  }

  function runMutationPreflight(
    req,
    res,
    {
      action,
      operation,
      target,
      context = {},
      lookup,
      failureMessage = "현재 상태를 확인할 수 없습니다.",
    },
  ) {
    const result = dbRun(lookup);
    if (result.success) return { ok: true, value: result.result };
    const error = result.internalError || result.error;
    logger.warn(
      req,
      action,
      {
        error,
        reason: error,
        operation,
        phase: "mutation_preflight",
        ...context,
      },
      target,
    );
    res.status(500).send(failureMessage);
    return { ok: false, value: null };
  }

  function currentRecordYear() {
    return currentCompetitionYear();
  }

  function resolveCanonicalTeam(team, year = currentRecordYear()) {
    if (!options.teamStore) {
      if (!isTeamActive(db, year, team?.num)) {
        return {
          valid: false,
          status: 409,
          error: "비활성화된 엔트리에는 기록을 저장할 수 없습니다.",
        };
      }
      return { valid: true, team };
    }

    const teamId = Number(team?.teamId ?? team?.id);
    if (!Number.isInteger(teamId) || teamId < 1) {
      return {
        valid: false,
        status: 409,
        error: "팀 정보가 변경되었습니다. 새로고침 후 다시 선택하세요.",
      };
    }
    const canonical = options.teamStore.getById(teamId);
    if (!canonical || canonical.year !== year || !canonical.active) {
      return {
        valid: false,
        status: 409,
        error: "현재 연도의 활성 팀이 아닙니다. 새로고침 후 다시 선택하세요.",
      };
    }
    return {
      valid: true,
      team: {
        id: canonical.id,
        teamId: canonical.id,
        num: canonical.number,
        univ: canonical.university,
        team: canonical.name,
        type: canonical.vehicleType,
        active: canonical.active,
      },
    };
  }

  function validateNodeId(s) {
    return typeof s === "string" && /^[A-Za-z0-9_\-:.]{1,64}$/.test(s);
  }

  // 64-bit tick: 숫자 문자열 또는 정수 number 허용 -> TEXT. 잘못된 값이면 undefined.
  function tickToText(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
    if (typeof v === "string" && /^\d{1,20}$/.test(v) && BigInt(v) <= (1n << 64n) - 1n) return v;
    return undefined;
  }

  function validBootId(value) {
    return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  }

  const ALLOWED_ROLE = /^(start|finish|lane[1-9])$/;

  /* ============================================
   Validation 헬퍼
   ============================================ */
  function validateRecordName(name) {
    if (name === undefined || name === null || typeof name !== "string" || name.trim() === "") {
      return { valid: false, error: "올바르지 않은 기록 이름입니다." };
    }
    // 파일 경로에 사용할 수 없는 문자들을 .으로 치환
    const sanitized = name.trim().replace(/[/\\:*?"<>|']/g, ".");
    if (!/^[A-Za-z0-9가-힣 .\-_]+$/.test(sanitized)) {
      return { valid: false, error: "올바르지 않은 기록 이름입니다." };
    }
    return { valid: true, value: sanitized };
  }

  function recordYearFromName(name) {
    const match = String(name || "").match(/^FSK (\d{4}) /);
    if (!match) return null;
    const year = Number(match[1]);
    return year >= 2000 && year <= 2099 ? year : null;
  }

  function isRecordBoundToActiveTeam(year, record) {
    const hasCanonicalTeams = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'competition_team'")
      .get();
    // Isolated Traffic tests do not install the canonical Competition schema.
    if (!hasCanonicalTeams) return true;
    if (!Number.isInteger(record.team_id)) return false;
    return !!db
      .prepare(
        `
    SELECT 1 FROM competition_team
    WHERE id = ? AND year = ? AND num = ? AND active = 1
  `,
      )
      .get(record.team_id, year, record.num);
  }

  function validateRecordData(data, { allowRoundedZero = false } = {}) {
    if (!data || typeof data !== "object") {
      return { valid: false, error: "올바르지 않은 기록 데이터입니다." };
    }

    const required = ["time", "type", "entry"];
    for (const field of required) {
      if (data[field] === undefined) {
        return { valid: false, error: `필수 필드가 누락되었습니다: ${field}` };
      }
    }

    if (!data.entry || typeof data.entry !== "object") {
      return { valid: false, error: "올바르지 않은 엔트리 데이터입니다." };
    }

    const status = data.status == null ? null : data.status;
    if (status !== null && !RESULT_STATUSES.includes(status)) {
      return { valid: false, error: "판정은 DNS, DNF, DSQ 또는 비움이어야 합니다." };
    }
    const result = data.result == null ? null : data.result;
    if (
      result !== null &&
      (!Number.isInteger(result) || result < 0 || (result === 0 && !allowRoundedZero))
    ) {
      return { valid: false, error: "측정시간은 양의 정수(ms) 또는 비움이어야 합니다." };
    }
    if (status === null && result === null) {
      return { valid: false, error: "정상 기록에는 측정시간이 필요합니다." };
    }
    if (data.detail !== undefined && data.detail !== null && typeof data.detail !== "string") {
      return { valid: false, error: "상세 정보가 올바르지 않습니다." };
    }
    if (
      !data.entry.num ||
      typeof data.entry.num !== "number" ||
      !Number.isInteger(data.entry.num) ||
      data.entry.num < 1
    ) {
      return { valid: false, error: "엔트리 번호가 올바르지 않습니다." };
    }
    if (!data.entry.univ || typeof data.entry.univ !== "string") {
      return { valid: false, error: "올바르지 않은 엔트리 데이터입니다." };
    }
    if (!data.entry.team || typeof data.entry.team !== "string") {
      return { valid: false, error: "올바르지 않은 엔트리 데이터입니다." };
    }

    return { valid: true };
  }

  // 팀·이벤트명 선택값 검증(빈/누락 허용 → null). /api/wireless/select와 arm green이 공유.
  // 반환: { valid, error?, team(object|null), event_name(string|null) }.
  function validateSelection(body) {
    const teamRaw = body?.team;
    let team = null;
    if (teamRaw != null) {
      if (
        typeof teamRaw !== "object" ||
        !Number.isInteger(teamRaw.num) ||
        teamRaw.num < 1 ||
        typeof teamRaw.univ !== "string" ||
        !teamRaw.univ ||
        typeof teamRaw.team !== "string" ||
        !teamRaw.team
      ) {
        return { valid: false, error: "올바르지 않은 팀 정보입니다." };
      }
      const resolved = resolveCanonicalTeam(teamRaw);
      if (!resolved.valid) return resolved;
      team = resolved.team;
    }
    let event_name = typeof body?.event_name === "string" ? body.event_name.trim() : null;
    if (event_name === "") event_name = null;
    if (event_name != null) {
      const nv = validateRecordName(event_name);
      if (!nv.valid) return { valid: false, error: nv.error };
      event_name = nv.value;
    }
    return { valid: true, team, event_name };
  }

  function validateSelectionRequest(req, res, action, eventType, body = req.body) {
    try {
      return validateSelection(body);
    } catch (error) {
      const teamId = Number(body?.team?.teamId ?? body?.team?.id);
      logger.warn(
        req,
        action,
        {
          error: error?.message || String(error),
          phase: "canonical_team_lookup",
          event_type: eventType,
          year: currentRecordYear(),
          team_id: Number.isInteger(teamId) && teamId > 0 ? teamId : null,
        },
        eventType,
      );
      res.status(500).send("팀 기준 정보를 확인할 수 없습니다.");
      return null;
    }
  }

  return {
    wirelessActor,
    controllerEmail,
    rejectMutation,
    runRecordPreflight,
    runMutationPreflight,
    currentRecordYear,
    resolveCanonicalTeam,
    validateNodeId,
    tickToText,
    validBootId,
    ALLOWED_ROLE,
    validateRecordName,
    recordYearFromName,
    isRecordBoundToActiveTeam,
    validateRecordData,
    validateSelectionRequest,
  };
}
