import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "notyf/notyf.min.css";
import { initTheme } from "@shared/theme-init.js";

// Routes
import SheetTeamList from "./views/SheetTeamList.vue";
import SheetTemplate from "./views/SheetTemplate.vue";
import SheetTemplatePrint from "./views/SheetTemplatePrint.vue";
import SheetDetail from "./views/SheetDetail.vue";

const routes = [
  { path: "/", component: SheetTeamList },
  { path: "/template", component: SheetTemplate },
  { path: "/template/print", component: SheetTemplatePrint },
  { path: "/:year/:num", component: SheetDetail },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/inspection" : ""),
  routes,
});

initTheme();

createApp(App).use(router).mount("#app");
