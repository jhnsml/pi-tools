import { defineConfig } from "vite-plus";

import {
  antiSlopPlugin,
  antiSlopRules,
  coverageThresholds,
  sharedIgnorePatterns,
  sharedLintOptions,
} from "../../tools/vite-plus/shared.mjs";

export default defineConfig({
  fmt: {
    ignorePatterns: sharedIgnorePatterns,
  },
  lint: {
    ignorePatterns: sharedIgnorePatterns,
    jsPlugins: [antiSlopPlugin],
    rules: antiSlopRules,
    overrides: [
      {
        files: ["test/**"],
        rules: Object.fromEntries(Object.keys(antiSlopRules).map((rule) => [rule, "off"])),
      },
      {
        // These files intentionally parse untrusted Pi/ax payloads and build sparse
        // result records. Keep the remaining anti-slop rules active around those seams.
        files: [
          "src/argv.ts",
          "src/continuation.ts",
          "src/execute.ts",
          "src/outcome.ts",
          "extensions/ax.ts",
        ],
        rules: {
          "anti-slop/no-conditional-empty-object-spread": "off",
          "anti-slop/no-known-value-widening": "off",
          "anti-slop/no-runtime-typeof": "off",
          "anti-slop/no-unknown-parameters": "off",
          "anti-slop/no-unsafe-dictionary-type": "off",
        },
      },
    ],
    options: sharedLintOptions,
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      include: ["src/**", "extensions/**"],
      thresholds: coverageThresholds,
    },
  },
});
