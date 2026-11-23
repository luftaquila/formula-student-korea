// Rover and GPS unit API addresses offered to the console. FSK serves them from
// COURSE_DEVICES, a JSON array of { id, kind: "rover"|"gps", label, url }
// (https addresses on the tailnet); the console connects to them directly.
const KINDS = new Set(["rover", "gps"]);

export function loadCourseDevices(raw, logger) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Configuration is read once at startup, before any request context.
    logger.warn(null, "course.devices.config", { error: `COURSE_DEVICES is not JSON: ${error.message}` });
    return [];
  }
  const devices = [];
  for (const entry of Array.isArray(parsed) ? parsed : []) {
    let url = null;
    try {
      url = new URL(entry?.url);
    } catch {
      url = null;
    }
    if (typeof entry?.id !== "string" || !KINDS.has(entry.kind) || url?.protocol !== "https:") {
      logger.warn(null, "course.devices.config", { error: "invalid device entry", entry });
      continue;
    }
    devices.push({
      id: entry.id,
      kind: entry.kind,
      label: typeof entry.label === "string" && entry.label ? entry.label : entry.kind === "rover" ? "Rover" : "GPS unit",
      url: url.origin,
    });
  }
  return devices;
}

export function registerDeviceRoutes(app, { devices }) {
  app.get("/api/devices", (req, res) => res.json({ devices }));
}
