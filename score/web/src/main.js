import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "vue-sonner/style.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";

import ScoreBoard from "./views/ScoreBoard.vue";
import EnduranceInput from "./views/EnduranceInput.vue";
import PublicScoreBoard from "./views/PublicScoreBoard.vue";

const routes = [
  { path: "/", component: ScoreBoard },
  { path: "/endurance", component: EnduranceInput },
  { path: "/public/:year(\\d{4})", name: "public-score", component: PublicScoreBoard },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/score" : ""),
  routes,
});

initTheme();
initTestBanner();

createApp(App).use(router).mount("#app");
