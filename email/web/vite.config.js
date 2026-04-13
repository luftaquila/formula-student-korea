import vue from "@vitejs/plugin-vue";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createViteConfig } from "../../shared/vite-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default (env) => ({
  plugins: [vue()],
  ...createViteConfig("email", 9900, {
    aliases: { notyf: resolve(__dirname, "node_modules/notyf") },
  })(env),
});
