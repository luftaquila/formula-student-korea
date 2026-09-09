import { ref } from "vue";

export const device = ref(null);

export async function refreshDevice() {
  try {
    const response = await fetch("/auth/api/device/session");
    device.value = response.ok ? await response.json() : null;
  } catch {
    device.value = null;
  }
  return device.value;
}
