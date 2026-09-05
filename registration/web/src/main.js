import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import "vue-sonner/style.css";
import "@shared/styles/base.css";
import "@shared/styles/layout.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";
import { user, hasPermission } from "@shared/officialsStore.js";
import { refreshDevice } from "@shared/deviceStore.js";
import App from "./App.vue";
import "./styles/main.css";

initTheme();
initTestBanner();

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/registration" : ""),
  routes: [
    { path: "/", component: { render: () => null } },
    { path: "/manage", component: () => import("./views/Manage.vue"), meta: { permission: "registration.operate" } },
    { path: "/register", component: () => import("./views/Register.vue"), meta: { permission: "registration.manage", kioskScope: "kiosk.registration.register" } },
  ],
});

router.beforeEach(async (to) => {
  if (to.path === "/") {
    window.location.replace("/queue/");
    return false;
  }
  if (!to.meta.permission || hasPermission(to.meta.permission)) return;
  // The pairing page is only for browsers with no human session. A signed-in
  // Official who lacks the grant lands on the operations view instead.
  if (to.meta.kioskScope && !user.value) {
    if ((await refreshDevice())?.scope === to.meta.kioskScope) return;
    window.location.href = "/auth/device";
    return false;
  }
  return to.meta.kioskScope ? "/manage" : "/";
});

createApp(App).use(router).mount("#app");
