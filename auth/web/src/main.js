import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "notyf/notyf.min.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";

initTheme();
initTestBanner();

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", component: () => import("./views/Manage.vue") },
    { path: "/applications", component: () => import("./views/Applications.vue") },
    { path: "/apply", component: () => import("./views/Apply.vue") },
    { path: "/logs", component: () => import("./views/Logs.vue") },
  ],
});

createApp(App).use(router).mount("#app");
