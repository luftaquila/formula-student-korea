import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "vue-sonner/style.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";

import CalendarView from "./views/CalendarView.vue";

const routes = [
  { path: "/", component: CalendarView },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/calendar" : ""),
  routes,
});

initTheme();
initTestBanner();

createApp(App).use(router).mount("#app");
