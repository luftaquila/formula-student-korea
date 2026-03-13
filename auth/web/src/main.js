import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "notyf/notyf.min.css";
import { initTheme } from "@shared/theme-init.js";

initTheme();

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/login", component: () => import("./views/Login.vue") },
    { path: "/", component: () => import("./views/Manage.vue") },
  ],
});

createApp(App).use(router).mount("#app");
