import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import "vue-sonner/style.css";
import "@shared/styles/base.css";
import "@shared/styles/layout.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";
import { isChief, showOfficials } from "@shared/officialsStore.js";
import App from "./App.vue";
import "./styles/main.css";

initTheme();
initTestBanner();

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/registration" : ""),
  routes: [
    { path: "/", component: () => import("./views/Lookup.vue") },
    { path: "/manage", component: () => import("./views/Manage.vue"), meta: { role: "official" } },
    { path: "/register", component: () => import("./views/Register.vue"), meta: { role: "chief" } },
  ],
});

router.beforeEach((to) => {
  if (to.meta.role === "chief" && !isChief.value) return showOfficials.value ? "/manage" : "/";
  if (to.meta.role === "official" && !showOfficials.value) return "/";
});

createApp(App).use(router).mount("#app");
