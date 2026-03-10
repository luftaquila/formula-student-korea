import { createApp } from "vue";
import { createPinia } from "pinia";
import router from "./router";
import App from "./App.vue";

import "notyf/notyf.min.css";
import "./assets/styles/main.css";
import { initTheme } from "@shared/theme-init.js";

initTheme();

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount("#app");
