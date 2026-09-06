import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const rulesDirectory = resolve(root, "tools/oxlint/anti-slop/rules");
const tests = readdirSync(rulesDirectory)
  .filter((file) => file.endsWith(".test.ts"))
  .sort();

for (const test of tests) {
  execFileSync("pnpm", ["exec", "tsx", resolve(rulesDirectory, test)], {
    cwd: root,
    stdio: "inherit",
  });
}
