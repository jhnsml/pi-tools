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
    plugins: ["typescript", "unicorn", "oxc", "vitest"],
    rules: {
      ...antiSlopRules,
      complexity: ["error", { max: 15 }],
      "max-depth": ["error", 4],
      eqeqeq: ["error", "always"],
      "no-eval": "error",
      "no-new-func": "error",
      "no-nested-ternary": "error",
      "no-duplicate-imports": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/only-throw-error": "error",
      "typescript/use-unknown-in-catch-callback-variable": "error",
      // Keep the plugin focused on test correctness, not assertion style or inferred mock types.
      "vitest/no-conditional-expect": "off",
      "vitest/require-to-throw-message": "off",
      "vitest/require-mock-type-parameters": "off",
      "vitest/no-focused-tests": "error",
      "vitest/valid-expect": "error",
      "vitest/valid-expect-in-promise": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/await-thenable": "error",
      "typescript/no-unnecessary-type-assertion": "error",
    },
    overrides: [
      {
        files: ["test/**"],
        rules: Object.fromEntries(Object.keys(antiSlopRules).map((rule) => [rule, "off"])),
      },
    ],
    options: sharedLintOptions,
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      include: ["extensions/**"],
      thresholds: coverageThresholds,
    },
  },
});
