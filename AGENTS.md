# pi-tools

`pi-tools` is a pnpm workspace containing independently published Pi packages.

## Working agreement

- Use the exact pnpm version declared by the workspace root and the Node version in `.node-version`.
- Keep `pi-ax` and `pi-bash-tools` independently publishable; preserve their package names, Pi manifests, peer dependency model, and package-local tarball contents.
- Run package-local checks through the package scripts and workspace-wide checks through the root scripts.
- Keep shared TypeScript and Vite+ settings in root tooling files; keep package-specific tests, coverage, and lint rules in each package.
- Treat the vendored anti-slop plugin under `tools/oxlint/anti-slop` as repository-owned source. Generic anti-slop rules are enabled for both packages.
- Add a changeset for every published package change. Do not publish or push without explicit authorization.

## Verification

Before considering a migration or package change complete, run:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:coverage
pnpm test:smoke
pnpm pack:dry
```

For publication changes, inspect each package's packed manifest and file list, then test the packed package from a clean temporary project.

## Context pointers

- Read `docs/MONOREPO-RESEARCH.md` for the cited monorepo, TypeScript 7, publication, and CI research.
- Read the package-local `AGENTS.md` and `README.md` before changing package behavior.
- Read `CONTEXT.md` in `packages/pi-ax` before changing ax semantics.
