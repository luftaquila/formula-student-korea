import { ref } from "vue";

const STORAGE_KEY = "fsk_show_officials";

export const showOfficials = ref(localStorage.getItem(STORAGE_KEY) === "true");

export function toggleOfficials() {
  showOfficials.value = !showOfficials.value;
  localStorage.setItem(STORAGE_KEY, showOfficials.value);
}
