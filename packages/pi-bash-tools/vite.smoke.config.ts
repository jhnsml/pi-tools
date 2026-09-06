import { defineConfig } from "vite-plus";
import config from "./vite.config.js";

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ["test/**/*.smoke.ts"],
    testTimeout: 20000,
  },
});
