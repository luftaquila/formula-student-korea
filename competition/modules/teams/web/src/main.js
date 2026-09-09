import { createApp } from "vue";
import App from "./App.vue";
import "./styles/main.css";
import "vue-sonner/style.css";
import { initTheme } from "@shared/browser/theme-init.js";
import { initTestBanner } from "@shared/browser/test-banner.js";

initTheme();
initTestBanner();

createApp(App).mount("#app");
