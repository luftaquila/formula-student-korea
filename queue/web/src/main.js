import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "vue-sonner/style.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";
import { hasPermission } from "@shared/officialsStore.js";
import { refreshDevice } from "@shared/deviceStore.js";

// Routes
import QueueStatus from "./views/QueueStatus.vue";
import AdminPanel from "./views/AdminPanel.vue";
import Register from "./views/Register.vue";
import Priority from "./views/Priority.vue";
import StatsPage from "./views/StatsPage.vue";
const routes = [
  { path: "/", component: QueueStatus },
  { path: "/admin", component: AdminPanel, meta: { permission: "queue.operate" } },
  { path: "/register", component: Register, meta: { kioskScope: "kiosk.queue.register", permission: "queue.manage" } },
  { path: "/priority", component: Priority, meta: { permission: "queue.manage" } },
  { path: "/stats", component: StatsPage, meta: { permission: "queue.operate" } },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/queue" : ""),
  routes,
});

router.beforeEach(async (to) => {
  if (!to.meta.permission || hasPermission(to.meta.permission)) return;
  if (to.meta.kioskScope && (await refreshDevice())?.scope === to.meta.kioskScope) return;
  if (to.meta.kioskScope) {
    window.location.href = "/auth/device";
    return false;
  }
  return "/";
});

initTheme();
initTestBanner();

createApp(App).use(router).mount("#app");
