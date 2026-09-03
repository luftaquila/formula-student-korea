import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import "vue-sonner/style.css";
import "@shared/styles/base.css";
import "@shared/styles/layout.css";
import "@shared/styles/lookup-status.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";
import { hasPermission } from "@shared/officialsStore.js";
import { refreshDevice } from "@shared/deviceStore.js";
import App from "./App.vue";
import "./styles/main.css";

initTheme();
initTestBanner();

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/registration" : ""),
  routes: [
    { path: "/", component: () => import("./views/Lookup.vue") },
    { path: "/manage", component: () => import("./views/Manage.vue"), meta: { permission: "registration.operate" } },
    { path: "/register", component: () => import("./views/Register.vue"), meta: { permission: "registration.manage", kioskScope: "kiosk.registration.register" } },
  ],
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

createApp(App).use(router).mount("#app");
