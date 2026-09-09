export const CONTROLLER_MAX_ROWS = 100000;

export const RETAIN_EVENTS = 500000;

export const WIRELESS_STATUS_MAX_AGE_MS = 12000;

export const WIRELESS_SYNC_MAX_AGE_MS = 7000;

export const WIRELESS_MAX_SKEW_PPM = 100;

export const WIRELESS_REQUIRED_ROLES = Object.freeze({
  가속: ["start", "finish"],
  스키드패드: ["start"],
  오토크로스: ["start", "finish"],
  내구: ["start"],
});
