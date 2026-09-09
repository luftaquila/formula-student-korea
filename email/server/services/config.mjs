export function createConfigService({ MASKED_KEYS }) {
  function maskValue(key, value) {
    if (!MASKED_KEYS.has(key) || !value) return value;
    return value.length > 4 ? "****" + value.slice(-4) : "****";
  }

  /* ============================================
   Config Reset
   ============================================ */
  const CONFIG_GROUPS = {
    brevo: ["brevo_api_key", "brevo_sender_name", "brevo_sender_email"],
    sms: [
      "naver_cloud_access_key",
      "naver_cloud_secret_key",
      "naver_cloud_sms_service_id",
      "phone_number_sms_sender",
    ],
  };

  return { maskValue, CONFIG_GROUPS };
}
