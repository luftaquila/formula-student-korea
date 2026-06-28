import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "vue-sonner/style.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";

import Dashboard from "./views/Dashboard.vue";

const routes = [
  { path: "/", component: Dashboard },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/email" : ""),
  routes,
});

initTheme();
initTestBanner();

createApp(App).use(router).mount("#app");
