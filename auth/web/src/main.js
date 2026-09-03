import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "vue-sonner/style.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";
import { hasPermission, isAdmin } from "@shared/officialsStore.js";

initTheme();
initTestBanner();

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", component: () => import("./views/Manage.vue"), meta: { adminOnly: true } },
    { path: "/applications", component: () => import("./views/Applications.vue"), meta: { permission: "applications.manage" } },
    { path: "/contacts", component: () => import("./views/Contacts.vue"), meta: { permission: "contacts.manage" } },
    { path: "/devices", component: () => import("./views/Devices.vue"), meta: { adminOnly: true } },
    { path: "/device", component: () => import("./views/DevicePair.vue") },
    {
      path: "/apply",
      component: () => import("./views/Apply.vue"),
      // 카톡 인앱 브라우저(WebView)는 Google OAuth를 막는다("disallowed_useragent").
      // 신청 페이지는 외부에서 공유된 링크로 들어오므로, 카톡이면 외부 브라우저로 튕겨낸다.
      beforeEnter: () => {
        if (/kakaotalk/i.test(navigator.userAgent)) {
          location.href =
            "kakaotalk://web/openExternal?url=" + encodeURIComponent(location.href);
          return false;
        }
      },
    },
    { path: "/logs", component: () => import("./views/Logs.vue"), meta: { permission: "audit.view" } },
  ],
});

router.beforeEach((to) => {
  if ((!to.meta.adminOnly || isAdmin.value) && (!to.meta.permission || hasPermission(to.meta.permission))) return;
  window.location.href = "/";
  return false;
});

createApp(App).use(router).mount("#app");
