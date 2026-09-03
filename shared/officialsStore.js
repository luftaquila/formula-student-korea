import { ref, computed } from "vue";
import { PERMISSION_KEYS } from "./access-control.js";

function getUserFromCookie() {
  const match = document.cookie.match(/fsk_user=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); }
  catch { return null; }
}

export const user = ref(getUserFromCookie());
export const isAuthenticated = computed(() => ["student", "official", "admin"].includes(user.value?.role));
export const isStudent = computed(() => user.value?.role === "student");
export const isOfficial = computed(() => user.value?.role === "official" || user.value?.role === "admin");
export const isAdmin = computed(() => user.value?.role === "admin");

export function hasPermission(permission) {
  if (!PERMISSION_KEYS.includes(permission)) return false;
  return user.value?.role === "admin"
    || (user.value?.role === "official" && user.value?.permissions?.includes(permission));
}

export function permissionComputed(permission) {
  return computed(() => hasPermission(permission));
}

export async function refreshUser() {
  try {
    const response = await fetch("/auth/api/session");
    if (response.ok) user.value = await response.json();
    else if (response.status === 401) user.value = null;
    // Any other status (502/503 from auth) is an outage, not a sign-out: keep the
    // last display snapshot so the navigation does not vanish until it recovers.
  } catch { /* same: retain the last display snapshot during a transient outage */ }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      user.value = getUserFromCookie();
      if (user.value) refreshUser();
    }
  });
}
