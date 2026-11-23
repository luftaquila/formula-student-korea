import { permissionComputed } from "@shared/browser/officialsStore.js";
import { createHttpTransport } from "fsk-coursekeeper/console/transport.mjs";
import { createDeviceRegistry } from "fsk-coursekeeper/console/devices.mjs";
import { requestPublicCourse } from "./public-api.mjs";

const base = import.meta.env.PROD ? "/course" : "";

function redirectToLogin() {
  window.location.href = `/auth/api/login?redirect=${encodeURIComponent(window.location.pathname)}`;
}

// FSK hosts the console with course data on the Course server and FSK
// permissions. The rover and GPS unit serve their own APIs on the tailnet; the
// Course server only lists their addresses (COURSE_DEVICES) for rover operators.
export function createFskHost() {
  const course = createHttpTransport(base, { onUnauthorized: redirectToLogin });
  const canOperateRover = permissionComputed("rover.operate");
  return {
    course,
    devices: createDeviceRegistry({
      load: async () => (canOperateRover.value ? (await (await course.request("/api/devices")).json()).devices : []),
      createTransport: (url) => createHttpTransport(url, { credentials: "omit" }),
    }),
    access: { permission: permissionComputed },
    features: { publication: true },
    publicCourses: { request: requestPublicCourse },
    version: import.meta.env.VITE_COURSEKEEPER_VERSION || "dev",
  };
}
