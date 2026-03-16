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
export const showOfficials = computed(() => roleLevel(user.value?.role) >= 2);
export const isChief = computed(() => roleLevel(user.value?.role) >= 3);
export const isAdmin = computed(() => roleLevel(user.value?.role) >= 4);
