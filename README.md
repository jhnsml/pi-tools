# pi-tools

A pnpm workspace for independently published Pi packages:

- [`@jhnsml/pi-ax`](./packages/pi-ax) — a read-only `ax` web extraction tool.
- [`@jhnsml/pi-bash-tools`](./packages/pi-bash-tools) — typed tools for modern command-line utilities.

Each package is independently versioned and installable.

## Development

The repository uses Node.js 24.20.0 for development and CI, supports Node.js `>=22.19.0` for the published packages, and pins the latest pnpm version used by the workspace in the root `package.json`.

```bash
pnpm install
pnpm check
pnpm test
pnpm test:coverage
pnpm test:smoke
pnpm pack:dry
```

Run one package with pnpm filters:

```bash
pnpm --filter @jhnsml/pi-ax check
pnpm --filter @jhnsml/pi-bash-tools test
```

Vite+ provides the repository's Oxfmt, Oxlint, Vitest, TypeScript, staged-file checks, and Git hook dispatcher. The vendored generic anti-slop Oxlint plugin lives under [`tools/oxlint/anti-slop`](./tools/oxlint/anti-slop) and is enabled for both packages. Test scaffolding and the existing Pi/ax parsing and result-shaping seams have documented configuration exceptions where the rules do not model their runtime contracts.

Commits use the [Conventional Commits](https://www.conventionalcommits.org/) format and are validated locally by Commitlint and in pull-request CI. Vite+ manages the hooks without Husky; `pnpm install` installs the dispatcher, while `VP_GIT_HOOKS=0` disables hooks for a single command.

## Releases

Each package has its own version and changelog. Add a Changeset for every published change:

```bash
pnpm changeset
pnpm version-packages
```

The release workflow uses GitHub Actions trusted publishing with npm provenance. Configure a trusted publisher for both npm packages before enabling publication. The old package repositories remain available as archives; new installations should use npm package names.
