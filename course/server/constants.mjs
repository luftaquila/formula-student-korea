export const parsedMissionTelemetryMaxRows = Number.parseInt(
  process.env.MISSION_TELEMETRY_MAX_ROWS || "500000",
  10,
);

export const MISSION_TELEMETRY_MAX_ROWS =
  Number.isInteger(parsedMissionTelemetryMaxRows) && parsedMissionTelemetryMaxRows > 0
    ? parsedMissionTelemetryMaxRows
    : 500000;
