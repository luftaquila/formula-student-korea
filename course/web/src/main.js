import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "leaflet/dist/leaflet.css";
import { initTheme } from "@shared/theme-init.js";

import MapView from "./views/MapView.vue";

const routes = [
  { path: "/", component: MapView },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/course" : ""),
  routes,
});

initTheme();

createApp(App).use(router).mount("#app");
