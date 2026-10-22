import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "@shared/browser/styles/base.css";
import "@shared/browser/styles/layout.css";
import "fsk-coursekeeper/console/styles/console.css";
import "leaflet/dist/leaflet.css";
import "vue-sonner/style.css";
import { initTheme } from "@shared/browser/theme-init.js";
import { initTestBanner } from "@shared/browser/test-banner.js";
import { hasPermission } from "@shared/browser/officialsStore.js";
import { HOST_KEY } from "fsk-coursekeeper/console/host.mjs";
import { setBaseMapKey } from "fsk-coursekeeper/console/lib/course-map.mjs";
import { createFskHost } from "./fsk-host.mjs";

// Mission history is integrated into MapView as the 기록(history) inspector tab
// so the same rail + map + inspector layout serves both live operation and
// replay; legacy /missions URLs redirect to the merged view.
const routes = [
  { path: "/", component: () => import("fsk-coursekeeper/console/CourseConsole.vue"), meta: { permission: "course.operate" } },
  { path: "/public", component: () => import("fsk-coursekeeper/console/views/PublicCourseView.vue"), meta: { public: true } },
  { path: "/missions", redirect: "/" },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/course" : ""),
  routes,
});

router.beforeEach((to) => {
  if (to.meta.permission && !hasPermission(to.meta.permission)) return to.path === "/" ? "/public" : "/";
});

router.afterEach((to) => { document.title = to.meta.public ? "FSK 경기 코스" : "FSK 코스 관리"; });

initTheme();
setBaseMapKey(window.__VWORLD_KEY__);
initTestBanner();

const app = createApp(App).use(router);
app.provide(HOST_KEY, createFskHost());
router.isReady().then(() => app.mount("#app"));
