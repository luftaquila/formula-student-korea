import { sendYearError } from "../../../../shared/common/competition-year.mjs";

export function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw Object.assign(new Error(`올바르지 않은 ${label}입니다.`), {
      status: 400,
      code: "INVALID_REQUEST",
    });
  }
  return number;
}

export function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return /^010\d{8}$/.test(digits) ? digits : null;
}

export function auditTeam(team) {
  return (
    team && {
      id: team.id,
      year: team.year,
      number: team.number,
      university: team.university,
      name: team.name,
      active: team.active,
    }
  );
}

export function sendError(res, error, fallbackCode = "REGISTRATION_OPERATION_FAILED") {
  if (error?.code === "YEAR_READ_ONLY" || error?.code === "INVALID_YEAR")
    return sendYearError(res, error);
  const status =
    Number(error?.status) || (error?.code?.startsWith?.("SQLITE_CONSTRAINT") ? 409 : 500);
  return res.status(status).json({
    code: error?.code || (status >= 500 ? fallbackCode : "INVALID_REQUEST"),
    message: status >= 500 ? "등록 대기열 처리 중 오류가 발생했습니다." : error.message,
  });
}
