import { ref, computed } from "vue";
import { ROLE_LEVELS } from "./constants.js";

function roleLevel(role) { return ROLE_LEVELS[role] || 0; }

function getUserFromCookie() {
  const match = document.cookie.match(/fsk_user=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); }
  catch { return null; }
}

export const user = ref(getUserFromCookie());
export const isAuthenticated = computed(() => roleLevel(user.value?.role) >= 1);
// Exact-match (not hierarchical): student-facing items hidden from staff.
export const isStudent = computed(() => user.value?.role === "student");
export const isStaff = computed(() => user.value?.role === "staff");
export const showStaff = computed(() => roleLevel(user.value?.role) >= ROLE_LEVELS.staff);
export const showOfficials = computed(() => roleLevel(user.value?.role) >= ROLE_LEVELS.official);
export const isChief = computed(() => roleLevel(user.value?.role) >= ROLE_LEVELS.chief);
export const isMaster = computed(() => roleLevel(user.value?.role) >= ROLE_LEVELS.master);
export const isAdmin = computed(() => roleLevel(user.value?.role) >= ROLE_LEVELS.admin);

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      user.value = getUserFromCookie();
    }
  });
}
