import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "vue-sonner/style.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";
import { hasPermission } from "@shared/officialsStore.js";

import StudentSessions from "./views/StudentSessions.vue";
import StudentSubmit from "./views/StudentSubmit.vue";
import AdminDashboard from "./views/AdminDashboard.vue";
import AdminSessionForm from "./views/AdminSessionForm.vue";
import AdminSessionDetail from "./views/AdminSessionDetail.vue";

const routes = [
  { path: "/", component: StudentSessions },
  { path: "/session/:id", component: StudentSubmit },
  { path: "/admin", component: AdminDashboard, meta: { permission: "documents.operate" } },
  { path: "/admin/create", component: AdminSessionForm, meta: { permission: "documents.manage" } },
  { path: "/admin/session/:id", component: AdminSessionDetail, meta: { permission: "documents.operate" } },
  { path: "/admin/session/:id/edit", component: AdminSessionForm, meta: { permission: "documents.manage" } },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/documents" : ""),
  routes,
});

router.beforeEach((to) => {
  if (to.meta.permission && !hasPermission(to.meta.permission)) return "/";
});

initTheme();
initTestBanner();

createApp(App).use(router).mount("#app");
