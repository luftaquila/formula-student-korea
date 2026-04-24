import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "leaflet/dist/leaflet.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";

import MapView from "./views/MapView.vue";
import MissionsView from "./views/MissionsView.vue";

const routes = [
  { path: "/", component: MapView },
  { path: "/missions", component: MissionsView },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/course" : ""),
  routes,
});

initTheme();
initTestBanner();

createApp(App).use(router).mount("#app");
