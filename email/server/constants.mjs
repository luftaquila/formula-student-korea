export const BREVO_API_BASE = "https://api.brevo.com/v3";

export const CONFIG_KEYS = [
  "email_enabled",
  "brevo_api_key",
  "brevo_sender_name",
  "brevo_sender_email",
  "naver_cloud_access_key",
  "naver_cloud_secret_key",
  "naver_cloud_sms_service_id",
  "phone_number_sms_sender",
];

export const MASKED_KEYS = new Set([
  "brevo_api_key",
  "naver_cloud_access_key",
  "naver_cloud_secret_key",
]);
