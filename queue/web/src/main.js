import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "vue-sonner/style.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";
import { user, hasPermission } from "@shared/officialsStore.js";
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
  // The pairing page is only for browsers with no human session. A signed-in
  // Official who lacks the grant lands on the operations view instead.
  if (to.meta.kioskScope && !user.value) {
    if ((await refreshDevice())?.scope === to.meta.kioskScope) return;
    window.location.href = "/auth/device";
    return false;
  }
  return to.meta.kioskScope ? "/admin" : "/";
});

initTheme();
initTestBanner();

createApp(App).use(router).mount("#app");
