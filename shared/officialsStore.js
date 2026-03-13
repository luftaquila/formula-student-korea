import { ref, computed } from "vue";

function getUserFromCookie() {
  const match = document.cookie.match(/fsk_user=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); }
  catch { return null; }
}

export const user = ref(getUserFromCookie());
export const showOfficials = computed(() => !!user.value);
export const isAdmin = computed(() => user.value?.role === "admin");
