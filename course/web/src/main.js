import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "leaflet/dist/leaflet.css";
import "vue-sonner/style.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";
import { hasPermission } from "@shared/officialsStore.js";

// Mission history is integrated into MapView as the 기록(history) inspector tab
// so the same rail + map + inspector layout serves both live operation and
// replay; legacy /missions URLs redirect to the merged view.
const routes = [
  { path: "/", component: () => import("./views/MapView.vue"), meta: { permission: "course.operate" } },
  { path: "/public", component: () => import("./views/PublicCourseView.vue"), meta: { public: true } },
  { path: "/missions", redirect: "/" },
  // VR teleop (Meta Quest 3S, WebXR). Lazy so three.js stays out of the main bundle.
  { path: "/vr", component: () => import("./views/VrView.vue"), meta: { permission: "rover.operate" } },
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
initTestBanner();

const app = createApp(App).use(router);
router.isReady().then(() => app.mount("#app"));
