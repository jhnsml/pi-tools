import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const dryRun = process.argv.includes("--dry-run");
if (!dryRun && process.env.CI !== "true") {
  throw new Error("Package publishing is restricted to CI; pass --dry-run for a local check.");
}

const root = resolve(import.meta.dirname, "..");
const artifactDirectory = resolve(root, ".artifacts/packages");
const packageDirectories = ["packages/pi-ax", "packages/pi-bash-tools"];

mkdirSync(artifactDirectory, { recursive: true });

for (const relativeDirectory of packageDirectories) {
  const directory = resolve(root, relativeDirectory);
  const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  let publishedVersion = "";

  try {
    const registryVersion = execFileSync("npm", ["view", manifest.name, "version", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    publishedVersion = JSON.parse(registryVersion);
  } catch {
    // A package that is not in the registry yet still needs to be published.
  }

  if (publishedVersion === manifest.version) {
    console.log(`${manifest.name}@${manifest.version} is already published; skipping.`);
    continue;
  }

  if (dryRun) {
    console.log(`Would publish ${manifest.name}@${manifest.version}.`);
    continue;
  }

  const packOutput = execFileSync("pnpm", ["pack", "--pack-destination", artifactDirectory], {
    cwd: directory,
    encoding: "utf8",
  }).trim();
  const tarball = packOutput.split("\n").at(-1);
  if (!tarball) throw new Error(`pnpm pack did not return a tarball for ${manifest.name}`);

  execFileSync("npm", ["publish", tarball, "--access", "public"], {
    cwd: root,
    stdio: "inherit",
  });
}
