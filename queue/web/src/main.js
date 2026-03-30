import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "notyf/notyf.min.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";

// Routes
import QueueStatus from "./views/QueueStatus.vue";
import AdminPanel from "./views/AdminPanel.vue";
import Register from "./views/Register.vue";
import Priority from "./views/Priority.vue";
import StatsPage from "./views/StatsPage.vue";
const routes = [
  { path: "/", component: QueueStatus },
  { path: "/admin", component: AdminPanel },
  { path: "/register", component: Register },
  { path: "/priority", component: Priority },
  { path: "/stats", component: StatsPage },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/queue" : ""),
  routes,
});

initTheme();
initTestBanner();

createApp(App).use(router).mount("#app");
