import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "notyf/notyf.min.css";
import { initTheme } from "@shared/theme-init.js";
import { isChief } from "@shared/officialsStore.js";

import StudentSessions from "./views/StudentSessions.vue";
import StudentSubmit from "./views/StudentSubmit.vue";
import AdminDashboard from "./views/AdminDashboard.vue";
import AdminSessionForm from "./views/AdminSessionForm.vue";
import AdminSessionDetail from "./views/AdminSessionDetail.vue";

const routes = [
  { path: "/", component: StudentSessions },
  { path: "/session/:id", component: StudentSubmit },
  { path: "/admin", component: AdminDashboard, meta: { requireChief: true } },
  { path: "/admin/create", component: AdminSessionForm, meta: { requireChief: true } },
  { path: "/admin/session/:id", component: AdminSessionDetail, meta: { requireChief: true } },
  { path: "/admin/session/:id/edit", component: AdminSessionForm, meta: { requireChief: true } },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/documents" : ""),
  routes,
});

router.beforeEach((to) => {
  if (to.meta.requireChief && !isChief.value) return "/";
});

initTheme();

createApp(App).use(router).mount("#app");
