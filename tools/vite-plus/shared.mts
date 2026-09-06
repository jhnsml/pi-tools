export const sharedIgnorePatterns = [
  ".pi-subagents/**",
  "dist/**",
  "node_modules/**",
];

export const antiSlopPlugin = {
  name: "anti-slop",
  specifier: "../../tools/oxlint/anti-slop/index.ts",
};

export const antiSlopRules = {
  "anti-slop/no-chained-type-assertions": "error",
  "anti-slop/no-conditional-empty-object-spread": "error",
  "anti-slop/no-known-value-widening": "error",
  "anti-slop/no-module-mocking": "error",
  "anti-slop/no-object-parameters": "error",
  "anti-slop/no-reflect-apply": "error",
  "anti-slop/no-reflect-get": "error",
  "anti-slop/no-runtime-typeof": "error",
  "anti-slop/no-shape-in-symbol-names": "error",
  "anti-slop/no-unknown-parameters": "error",
  "anti-slop/no-unknown-returns": "error",
  "anti-slop/no-unknown-type-aliases": "error",
  "anti-slop/no-unsafe-dictionary-type": "error",
  "anti-slop/no-widen-then-assert": "error",
  "anti-slop/require-safety-comment-for-type-assertion": "error",
} as const;

export const sharedLintOptions = {
  typeAware: true,
  typeCheck: true,
};

export const coverageThresholds = {
  lines: 80,
  functions: 80,
  branches: 80,
  statements: 80,
};
