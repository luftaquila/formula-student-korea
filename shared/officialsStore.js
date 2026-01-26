import { ref } from "vue";

const STORAGE_KEY = "fsk_show_officials";

// URL 파라미터 ?official=true 체크
const urlParams = new URLSearchParams(window.location.search);
const officialParam = urlParams.get("official") === "true";

// URL 파라미터가 true이면 localStorage에도 저장하고 활성화
if (officialParam) {
  localStorage.setItem(STORAGE_KEY, "true");
}

export const showOfficials = ref(
  officialParam || localStorage.getItem(STORAGE_KEY) === "true"
);

export function toggleOfficials() {
  showOfficials.value = !showOfficials.value;
  localStorage.setItem(STORAGE_KEY, showOfficials.value);
}
