import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "vue-sonner/style.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";
import { hasPermission } from "@shared/officialsStore.js";

// Routes
import SheetTeamList from "./views/SheetTeamList.vue";
import SheetTemplate from "./views/SheetTemplate.vue";
import SheetTemplatePrint from "./views/SheetTemplatePrint.vue";
import SheetDetail from "./views/SheetDetail.vue";

const routes = [
  { path: "/", component: SheetTeamList },
  { path: "/template", component: SheetTemplate, meta: { permission: "inspection.manage" } },
  { path: "/template/print", component: SheetTemplatePrint, meta: { permission: "inspection.manage" } },
  { path: "/:year/:num", component: SheetDetail },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/inspection" : ""),
  routes,
});

router.beforeEach((to) => {
  if (to.meta.permission && !hasPermission(to.meta.permission)) return "/";
});

initTheme();
initTestBanner();

createApp(App).use(router).mount("#app");
