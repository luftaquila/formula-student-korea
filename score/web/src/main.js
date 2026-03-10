import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "notyf/notyf.min.css";
import { initTheme } from "@shared/theme-init.js";

import ScoreBoard from "./views/ScoreBoard.vue";

const routes = [
  { path: "/", component: ScoreBoard },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/score" : ""),
  routes,
});

initTheme();

createApp(App).use(router).mount("#app");
