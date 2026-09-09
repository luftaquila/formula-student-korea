export function auditTeam(team) {
  return (
    team && {
      id: team.id,
      year: team.year,
      number: team.number,
      university: team.university,
      name: team.name,
      vehicleTypeId: team.vehicleTypeId,
      active: team.active,
    }
  );
}

export function auditVehicleType(type) {
  return (
    type && {
      id: type.id,
      year: type.year,
      name: type.name,
      color: type.color,
      sortOrder: type.sortOrder,
    }
  );
}

export function sendError(res, error) {
  const constraint = error?.code?.startsWith?.("SQLITE_CONSTRAINT");
  const status = Number(error?.status) || (constraint ? 409 : 500);
  return res.status(status).json({
    code: error?.code || (status >= 500 ? "TEAM_OPERATION_FAILED" : "INVALID_REQUEST"),
    message: status >= 500 ? "팀 목록 처리 중 오류가 발생했습니다." : error.message,
    ...(error?.year ? { year: error.year } : {}),
  });
}
