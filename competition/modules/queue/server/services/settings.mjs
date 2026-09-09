export function createInspectionSettings() {
  const INSPECTION_SETTING_DEFAULTS = Object.freeze({
    sms: "FALSE",
    sms_rank: "3",
    cancel_penalty: "10",
  });

  const INSPECTION_SETTING_FIELDS = Object.freeze(Object.keys(INSPECTION_SETTING_DEFAULTS));

  function inspectionSettingKey(type, field) {
    return `inspection:${type}:${field}`;
  }

  function normalizeInspectionSetting(field, value) {
    if (field === "sms") {
      return value === true || value === 1 || String(value).toUpperCase() === "TRUE"
        ? "TRUE"
        : "FALSE";
    }
    const parsed = Number.parseInt(value, 10);
    if (field === "sms_rank") {
      return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10
        ? String(parsed)
        : INSPECTION_SETTING_DEFAULTS[field];
    }
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 60
      ? String(parsed)
      : INSPECTION_SETTING_DEFAULTS[field];
  }

  return {
    INSPECTION_SETTING_DEFAULTS,
    INSPECTION_SETTING_FIELDS,
    inspectionSettingKey,
    normalizeInspectionSetting,
  };
}
