import { createApp } from "vue";
import App from "./App.vue";
import "./styles/main.css";
import { initTheme } from "@shared/theme-init.js";
import { initTestBanner } from "@shared/test-banner.js";

initTheme();
initTestBanner();

createApp(App).mount("#app");
