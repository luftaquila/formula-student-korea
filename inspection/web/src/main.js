import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";
import "notyf/notyf.min.css";

// Routes
import SheetTeamList from "./views/SheetTeamList.vue";
import SheetTemplate from "./views/SheetTemplate.vue";
import SheetDetail from "./views/SheetDetail.vue";

const routes = [
  { path: "/", component: SheetTeamList },
  { path: "/template", component: SheetTemplate },
  { path: "/:year/:num", component: SheetDetail },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? "/inspection" : ""),
  routes,
});

// Apply theme on mount
const saved = localStorage.getItem("theme");
if (saved) {
  document.documentElement.setAttribute("data-theme", saved);
} else {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
}

// Listen for theme changes from other services
window.addEventListener("storage", (e) => {
  if (e.key === "theme") {
    document.documentElement.setAttribute("data-theme", e.newValue || "light");
  }
});

createApp(App).use(router).mount("#app");
