import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*.{js,mjs,cjs,ts,mts,cts,tsx,jsx,json,json5,yaml,yml}": "vp fmt --write",
  },
});
