import { createApp } from "vue";
import App from "./App.vue";
import "./styles/main.css";
import "notyf/notyf.min.css";
import { initTheme } from "@shared/theme-init.js";

initTheme();

createApp(App).mount("#app");
