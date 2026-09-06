# Consolidating `pi-ax` and `pi-bash-tools` into the `pi-tools` monorepo

**Research date:** 2026-09-06
**Scope:** repository and release design only; no source or package configuration was changed.

This report distinguishes:

- **Requirement** — imposed by pnpm, npm, Pi, or an existing compatibility promise.
- **Recommendation** — the proposed design for this repository.
- **Uncertainty / decision** — something the available evidence does not settle or that requires an owner choice.

All external citations are primary sources maintained by pnpm, npm, Microsoft TypeScript, Oxc, Vite+, Changesets, Node.js, or Pi.

## Executive recommendation

Create a private workspace root named `pi-tools`, put the two independently publishable packages under `packages/`, and retain their npm identities:

```text
pi-tools/
├── package.json                 # private workspace/tooling root
├── pnpm-workspace.yaml          # workspace membership + pnpm settings/catalog
├── pnpm-lock.yaml               # the only lockfile
├── tsconfig.base.json
├── vite.shared.config.ts        # optional shared object, not a publishable package
├── .changeset/                  # if using pnpm versioning or Changesets
├── packages/
│   ├── pi-ax/
│   │   ├── package.json         # name remains "pi-ax"
│   │   ├── extensions/
│   │   ├── src/
│   │   ├── test/
│   │   └── vite.config.ts
│   └── pi-bash-tools/
│       ├── package.json         # name remains "pi-bash-tools"
│       ├── extensions/
│       ├── test/
│       ├── vite.config.ts
│       └── vite.smoke.config.ts
└── .github/workflows/
    ├── ci.yml
    └── release.yml
```

The important migration principle is: **change repository topology without changing either published package's identity or installed shape**. Aligning TypeScript, Vite+, lint rules, or dependency versions is valuable, but each is a separate compatibility change and should be verified independently rather than hidden inside the file move.

## Existing-state observations

The following observations come from the current local configuration files, not from source-code inspection:

- Both packages are public candidates at version `0.1.0`, are ESM packages (`"type": "module"`), declare Node `>=22.19.0`, and expose a Pi extension through an explicit `pi.extensions` path.
- `pi-ax` publishes `extensions`, `src`, `README.md`, and `LICENSE`; `pi-bash-tools` publishes `extensions`, `README.md`, and `LICENSE`.
- Neither package currently declares `main` or `exports`. That is coherent for a Pi resource package loaded from its `pi` manifest rather than imported as a conventional JavaScript library.
- Both place Pi host modules and `typebox` in optional peer dependencies and concrete development dependencies, but the Pi package versions differ.
- The TypeScript/Vite+ toolchains differ: `pi-ax` declares TypeScript `^7.0.2` and Vite+ `^0.3.0`; `pi-bash-tools` declares TypeScript `^5.8.3` and Vite+ `^0.2.4`.
- Their `tsconfig.json` compiler options are otherwise the same. Their Vite+ configs share formatting, type-aware checking, test layout, and coverage thresholds, while `pi-bash-tools` adds stricter lint rules and a smoke-test config.
- Both currently have a `pnpm-workspace.yaml`, but with different dependency-build approvals; `pi-ax` also has minimum-release-age exceptions. These policies need an intentional union at the new root.

## 1. Workspace, root package, and lockfile

### Workspace declaration

**Requirement:** a pnpm workspace has a `pnpm-workspace.yaml` at its root. Its `packages` field defines included/excluded package directories, and the root project is always included. If `packages` is omitted, only the root is included ([pnpm workspace configuration](https://pnpm.io/pnpm-workspace_yaml#packages); [pnpm workspaces](https://pnpm.io/workspaces)).

**Recommendation:** use one unsurprising glob:

```yaml
packages:
  - packages/*
```

Do not use broad `**` patterns unless nested publishable packages are actually planned. Keep examples, fixtures, and temporary directories outside that match or exclude them explicitly.

### Root `package.json`

**Requirement:** set `"private": true` on the root. npm refuses to publish a package with this field, which protects the workspace container from accidental publication ([npm `private`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#private)).

**Recommendation:** the root should have at least:

- `name: "pi-tools"`;
- `private: true`;
- one exact `packageManager` pin;
- repository-wide scripts only;
- shared development tooling only, not runtime dependencies of either published package.

The owner selected the current `pnpm@12.3.4` release for the workspace root rather than retaining either package-local pin. Vite+ detects the package manager from the workspace root, preferring `packageManager`, and downloads the matching version; this makes root pinning the single source of truth ([Vite+ dependency installation](https://viteplus.dev/guide/install)).

**Recommendation:** remove child `packageManager` fields after the root pin is established. They do not describe consumer requirements and create ambiguity about which pnpm version owns the shared lockfile.

**Uncertainty / decision:** current pnpm documentation is served as 12.x documentation, while the proposed initial pin is 12.3.4. The features recommended here state their own introduction versions and are available in pnpm 11, but a later upgrade to pnpm 12 should be a separate, lockfile-regenerating change.

### One root lockfile

**Requirement by default:** pnpm's `sharedWorkspaceLockfile` defaults to `true`, producing one `pnpm-lock.yaml` at the workspace root ([pnpm `sharedWorkspaceLockfile`](https://pnpm.io/workspaces#sharedworkspacelockfile)). npm's packaging rules exclude `pnpm-lock.yaml` from package tarballs, so the root lockfile is a development/CI artifact rather than package payload ([npm `files`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#files)).

**Recommendation:** commit exactly one root `pnpm-lock.yaml`; delete package-local lockfiles only as part of the actual migration. In CI use a frozen install. pnpm enables frozen-lockfile behavior automatically in CI and, since v11, rejects lockfiles created by an incompatible newer pnpm major rather than silently rewriting them ([pnpm CI guidance](https://pnpm.io/continuous-integration#lockfile-behavior-in-ci)). The exact root package-manager pin therefore matters.

### Merge root pnpm policy deliberately

**Recommendation:** merge, do not overwrite, the two current `pnpm-workspace.yaml` policies:

- retain the union of dependency build decisions (`@google/genai`, `protobufjs`, and `esbuild`);
- retain or deliberately revise `minimumReleaseAgeExclude` entries;
- add `packages: ["packages/*"]`;
- document why any install-script permission is `true`.

This is a migration requirement arising from the current repositories: dropping either file's policy by accident could alter install behavior even when dependency versions are unchanged.

### Catalogs and workspace dependencies

pnpm catalogs centralize reusable dependency ranges in `pnpm-workspace.yaml`, can be referenced from dependency, development-dependency, peer, and optional-dependency fields, and are replaced with ordinary ranges during `pnpm pack` or `pnpm publish` ([pnpm catalogs](https://pnpm.io/catalogs)).

**Recommendation:** use a small default catalog only for versions intentionally kept in sync across both packages—for example the tested Pi host packages, `typebox`, Vitest coverage tooling, and perhaps `@types/node`. Do not turn every dependency into a catalog entry; that obscures package ownership without helping alignment.

If the packages later depend on one another, use `workspace:^` (or another deliberate `workspace:` range). The protocol guarantees local workspace resolution and pnpm converts it to a normal semver range when packing or publishing, so consumers are not required to use pnpm ([pnpm workspace protocol and publishing](https://pnpm.io/workspaces#workspace-protocol-workspace)). Today, the packages appear independent, so do not invent a cross-package dependency merely because they share a repository.

## 2. Shared TypeScript, Vite+, Oxlint, and Oxfmt configuration

### TypeScript configuration

**Recommendation:** extract only the identical compiler options into `tsconfig.base.json`, and keep one leaf `tsconfig.json` in each package with its own `include` list. TypeScript's project-reference guidance explicitly recommends configuration inheritance to centralize common compiler options ([TypeScript project-reference guidance](https://www.typescriptlang.org/docs/handbook/project-references.html#overall-structure)).

Do not add project references just because this is a monorepo. References are most useful when projects depend on each other's declaration output and require `composite`/declaration behavior; these packages currently use `noEmit` and have no observed dependency edge ([TypeScript project references](https://www.typescriptlang.org/docs/handbook/project-references.html)). Recursive workspace tasks are the simpler seam.

### TypeScript 7 status and compatibility

As of **2026-09-06**, TypeScript 7 is not a preview: Microsoft has announced the stable release, and the npm registry's `latest` metadata reports `typescript@7.0.2` ([TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/); [official npm registry metadata](https://registry.npmjs.org/typescript/latest)). It is a native Go port, typically 8–12x faster in Microsoft's full-build measurements, and Microsoft describes its type-checking and command-line behavior as compatible with TypeScript 6.0 under the documented migration conditions.

Important limitations and changes:

- **TypeScript 7.0 has no stable programmatic compiler API.** Microsoft expects a new/different API in 7.1. Tools that import `typescript` may need the `@typescript/typescript6` compatibility package or npm aliases in the interim ([TypeScript 7, “Running Side-by-Side”](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60)).
- TypeScript 7 adopts TypeScript 6 defaults and turns TypeScript 6 deprecations into hard errors. Notable defaults include `strict: true`, `types: []`, and a root `rootDir`; removed settings include legacy `node`/`node10`/`classic` module resolution and several legacy module targets ([TypeScript 7 migration behavior](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#updates-since-5x-and-new-behaviors-from-60)).
- The current package configs already explicitly set `strict`, `target`, `module: NodeNext`, `moduleResolution: NodeNext`, `noEmit`, and `types: ["node"]`, avoiding the most surprising default changes. This is encouraging but is not proof that `pi-bash-tools` passes under 7.0.

Vite+ 0.3's current documentation says `vp check` combines Oxfmt, Oxlint, and TypeScript checking through the TypeScript Go toolchain/`tsgolint`; it recommends enabling both `typeAware` and `typeCheck` ([Vite+ check](https://viteplus.dev/guide/check); [Vite+ lint](https://viteplus.dev/guide/lint)). This makes Vite+ 0.3 and TypeScript 7 conceptually aligned.

**Recommendation:** converge on TypeScript `^7.0.2` and Vite+ `^0.3.0` at the root, but do so as a separately verified step. First run all `pi-bash-tools` type, unit, smoke, and pack checks against the new toolchain. If a tool imports the TypeScript compiler API, retain TypeScript 6 side-by-side as Microsoft documents until 7.1 compatibility is verified. Nothing in the inspected package configs demonstrates such an API dependency, but source was intentionally outside this research scope.

**Recommendation:** align `@types/node` with the declared runtime floor, not merely the newest Node release. Using Node 26 declarations while advertising Node `>=22.19.0` can permit code that type-checks but is unavailable to the minimum supported consumer. Verify whether `pi-ax` actually requires Node 26 APIs before choosing the shared version.

### Vite+ config composition

Vite+ recommends keeping lint and formatting configuration in the `lint` and `fmt` blocks of `vite.config.ts`, rather than separate Oxlint/Oxfmt files ([Vite+ lint configuration](https://viteplus.dev/guide/lint#configuration); [Vite+ format configuration](https://viteplus.dev/guide/fmt#configuration)).

**Recommendation:** export a small root shared config object containing only the common settings, then import/merge it in each package's `vite.config.ts`. Keep package-owned settings local:

- common: ignore patterns, type-aware/type-check options, Node test environment, test include convention, and baseline coverage thresholds;
- `pi-ax`: coverage includes `src/**` and `extensions/**`;
- `pi-bash-tools`: its stricter lint rules/plugins, extension-only coverage, and smoke-test config.

Avoid one giant root test config with path-sensitive exceptions. Package-local configs preserve the behavior of running `vp check` or `vp test` from a package directory.

At the root, scripts can delegate with `vp run -r <task>`. Vite+ documents that recursive execution runs a task in every workspace package, in dependency order, and supports pnpm-compatible filters ([Vite+ workspace task execution](https://viteplus.dev/guide/run#running-in-a-workspace)). Keep the package scripts (`check`, `test`, `test:coverage`, `pack:dry`, and the bash-tools smoke test) so package-local workflows and contributor expectations continue to work.

### Direct Oxlint/Oxfmt use

If the repository later invokes Oxlint directly, it can use a shared root baseline plus package-specific nested configs. Oxlint uses the nearest config for each file; nested configs do not merge automatically, but a package config can explicitly extend the root baseline. Type-aware/type-check options are root-config-only ([Oxlint nested configs](https://oxc.rs/docs/guide/usage/linter/nested-config.html)). Oxlint also supports `overrides` and `extends` for shared rules ([Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config.html)).

Oxfmt likewise resolves the nearest config per file, supports overrides, and can disable nested lookup when one root config is desired ([Oxfmt configuration](https://oxc.rs/docs/guide/usage/formatter/config.html)).

**Recommendation:** because this project already uses Vite+, do not add parallel `.oxlintrc` or `.oxfmtrc` files. Multiple configuration systems create precedence questions and contradict Vite+'s documented integration path.

## 3. Published package manifests and tarball shape

### Preserve identities and versions

**Requirement for install compatibility:** keep the published names `pi-ax` and `pi-bash-tools`. npm identifies a published package by name and version, and an existing name/version pair cannot be reused ([npm package name/version](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#name); [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish#description)). The repository folder and Git repository can change without renaming the registry package.

**Recommendation:** keep versions independent. A change to one adapter should not force a release of the other. Do not configure a fixed release group unless the packages later form one public compatibility unit.

### Pi manifest and packaged files

**Pi requirement:** a Pi package may declare resources under the `pi` key; paths are relative to the package root. Pi also auto-discovers conventional directories, including `.ts`/`.js` files in `extensions/` ([Pi package creation and structure](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#creating-a-pi-package)).

**Recommendation:** preserve each current explicit manifest exactly in meaning:

- `pi-ax`: `"pi": { "extensions": ["./extensions/ax.ts"] }`;
- `pi-bash-tools`: `"pi": { "extensions": ["./extensions/bash-tools.ts"] }`.

Keep `pi-package` in each package's keywords for Pi gallery discovery. Do not move extension files to a root-level shared folder unless they are copied into each package tarball; Pi resolves manifest paths from the installed package root.

npm's `files` field is an allowlist for tarball contents; `package.json`, README, and license are always included, while lockfiles and `node_modules` are excluded ([npm `files`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#files)).

**Recommendation:** retain narrow package-local `files` arrays. Continue including `src` only for `pi-ax` if that extension imports it at runtime. Never assume workspace files outside the package directory will be available after publication. Verify every release with `pnpm -r pack --dry-run`; pnpm's dry run performs packing logic without creating the archive ([pnpm pack](https://pnpm.io/cli/pack#--dry-run)). Also inspect the generated manifest because pnpm replaces `workspace:` and `catalog:` protocols while packing.

### `exports`, `main`, and `type`

npm documents `exports` as a modern entry-point map that defines/encapsulates importable package paths ([npm `exports`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#exports)). Node warns that adding `exports` to an existing package blocks all undeclared deep imports and is likely a breaking change unless every previously supported path is exported ([Node.js package entry points](https://nodejs.org/api/packages.html#package-entry-points)).

**Recommendation:** do not add `main` or `exports` merely because the packages moved into a monorepo. Their public entry point is currently the Pi manifest, not `import "pi-ax"`. Add `exports` only if a supported JavaScript API is intentionally introduced; then export explicit built JavaScript and declarations, test both import modes that are promised, and treat any restriction of previous deep imports as semver-significant. Preserve `"type": "module"` because it explicitly defines `.js` interpretation and is recommended for package authors ([Node.js package type](https://nodejs.org/api/packages.html#packagejson-and-file-extensions)).

### Repository metadata

npm supports a `repository.directory` field specifically for packages located below a monorepo root ([npm `repository`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#repository)).

**Recommendation:** update each package to the canonical monorepo URL and directory, for example:

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/OWNER/pi-tools.git",
    "directory": "packages/pi-ax"
  },
  "homepage": "https://github.com/OWNER/pi-tools/tree/main/packages/pi-ax#readme",
  "bugs": {
    "url": "https://github.com/OWNER/pi-tools/issues"
  },
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org"
  }
}
```

Use the analogous directory for `pi-bash-tools`. `publishConfig` is not required for unscoped public packages, but explicitly constrains publish-time registry/access and reduces operator error ([npm `publishConfig`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#publishconfig)).

**Uncertainty / decision:** the canonical GitHub owner is not stated. Existing manifests refer to different owners (`yhn` and `jhnsml`). Decide the actual `OWNER` before enabling npm trusted publishing, because npm requires the package repository URL to match the GitHub repository exactly and case-sensitively ([npm trusted-publisher troubleshooting](https://docs.npmjs.com/trusted-publishers#troubleshooting)).

### License placement

pnpm copies the workspace-root LICENSE into a package when publishing if that package has no license file of its own ([pnpm publish](https://pnpm.io/cli/publish)).

**Recommendation:** keep a root license and package-local license files during the migration. The duplication is small, preserves current tarball contents, and avoids depending on publisher-specific copying behavior if a package is packed with another client.

## 4. Peer and runtime dependencies

**Pi requirement:** third-party runtime dependencies belong in `dependencies`. Pi-provided core modules must be peer dependencies with a `"*"` range and must not be bundled: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` ([Pi package dependencies](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#dependencies)). Only list the Pi modules a package actually imports.

npm explains that peers express compatibility with a host/plugin interface and recommends broad ranges; optional peer metadata prevents npm from automatically installing that peer ([npm peer dependencies](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#peerdependencies); [npm optional peer metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#peerdependenciesmeta)).

**Recommendation:** preserve the current pattern:

- Pi host imports remain `peerDependencies: { ...: "*" }` as Pi requires;
- mark those peers optional so ordinary npm installation does not create a competing Pi host tree;
- install concrete, tested versions as root development dependencies for type-checking and tests;
- do not bundle Pi host packages;
- keep non-Pi libraries needed at extension runtime in the individual package's `dependencies`, not only at the root.

A root dev dependency is available while developing the workspace but is not carried into a package tarball. Therefore moving a true runtime dependency to the root would create a package that works in the repository and fails for consumers.

**Uncertainty / decision:** the packages currently test against different Pi versions. Select one concrete development version only after both packages pass against it. The public peer range should remain `"*"` unless Pi's own packaging rules change; narrowing it for conventional npm style would contradict current Pi documentation.

## 5. Versioning and release tooling

pnpm states that workspace versioning is complex and points to Changesets/Rush; current pnpm also has native release management, added in v11.13.0, using Changesets-compatible intent files ([pnpm workspace release workflow](https://pnpm.io/workspaces#release-workflow); [pnpm native versioning](https://pnpm.io/versioning)). Because the proposed pin is pnpm 12.3.4, native versioning is available.

### Recommended default: pnpm-native intents

Use:

1. `pnpm change` to commit an intent naming only affected packages;
2. `pnpm change status` in CI to preview pending releases;
3. `pnpm version -r --dry-run`, then `pnpm version -r`, for a release PR;
4. `pnpm install` to update the shared lockfile;
5. publish only versions not already in the registry.

pnpm documents that recursive versioning bumps named packages and workspace dependents, creates no Git commit/tag because independent packages may receive different versions, and can keep package changelogs in the repository with `versioning.changelog.storage: repository` ([pnpm versioning](https://pnpm.io/versioning#releasing)).

**Recommendation:** do not configure a `fixed` group. Use package-qualified tags such as `pi-ax@0.1.1` and `pi-bash-tools@0.1.1` if tags are created, because there is no single monorepo version.

### Alternative: Changesets automation

If automatic “Version Packages” pull requests are more valuable than minimizing dependencies, install `@changesets/cli` at the root and use the official Changesets action. pnpm documents the standard flow (`changeset version`, refresh lockfile, `pnpm publish -r`) ([pnpm Changesets guide](https://pnpm.io/using-changesets)). The current Changesets action documents separate version and publish sub-actions and recommends them when using trusted publishing so publish permissions can be narrowed ([Changesets action](https://github.com/changesets/action)).

**Recommendation:** choose one versioning owner—pnpm-native or Changesets CLI—not both. Both can read `.changeset/*.md`, but two tools updating versions/changelogs in one workflow create avoidable ambiguity.

## 6. CI, provenance, and publishing security

### Pull-request CI

**Recommendation:** on every pull request and main-branch push:

1. install the exact root pnpm version;
2. `pnpm install --frozen-lockfile`;
3. run recursive `check`, unit tests, coverage, and `pi-bash-tools` smoke tests;
4. run recursive pack dry-runs;
5. verify the tarball file list and packed manifest for each package;
6. install each tarball in an empty temporary project and perform the existing Pi load checks;
7. test Node `22.19.x` (the declared floor) and the current supported Node line.

Vite+ supports recursive task execution and package filters ([Vite+ run](https://viteplus.dev/guide/run#running-in-a-workspace)); pnpm supports recursive packing ([pnpm pack](https://pnpm.io/cli/pack#--recursive)). A clean-room tarball test is the strongest guard against accidentally relying on root-only files or dependencies.

### Trusted publishing and provenance

npm trusted publishing uses OIDC instead of long-lived write tokens. It currently requires npm CLI 11.5.1+ and Node 22.14.0+, and GitHub Actions must use a GitHub-hosted runner with `id-token: write` ([npm trusted publishing](https://docs.npmjs.com/trusted-publishers)). The existing Node floor satisfies npm's Node minimum, but the workflow must ensure a sufficiently new npm CLI.

With GitHub/GitLab trusted publishing, npm automatically produces provenance for public packages in public repositories. Provenance links the package to its source/build workflow and is recorded through Sigstore, but it does not prove the package is non-malicious ([npm provenance](https://docs.npmjs.com/generating-provenance-statements)). Configure a trusted publisher separately for **both** existing npm packages and, after it works, disallow traditional write tokens as npm recommends ([npm trusted-publisher security guidance](https://docs.npmjs.com/trusted-publishers#recommended-restrict-token-access-when-using-trusted-publishers)).

**Recommendation:** separate version-PR permissions from publish permissions. The release job should run only from a protected branch/tag or approved GitHub environment, use `contents: read` plus `id-token: write`, and avoid a long-lived `NPM_TOKEN` for publication.

### pnpm packing versus npm OIDC upload

pnpm 11's `publish` implementation is native rather than delegated to npm. pnpm supports `--provenance` and documents `pnpm pack && npm publish *.tgz` as a compatibility fallback when npm publishing behavior is required ([pnpm publish](https://pnpm.io/cli/publish); [pnpm `--provenance`](https://pnpm.io/cli/publish#--provenance)). npm's trusted-publisher documentation, however, specifies the npm CLI as the OIDC client and does not state that pnpm's native publisher is supported.

**Recommendation:** for the conservative trusted-publishing path:

1. build/check the workspace with pnpm;
2. create final tarballs with `pnpm pack` so `workspace:`/`catalog:` fields are converted;
3. publish the selected tarballs with npm CLI 11.5.1+ under OIDC;
4. verify registry metadata and provenance for both packages before marking the release complete.

**Uncertainty:** pnpm may support more of npm's OIDC flow than its current publish page states, but the primary docs reviewed do not promise it. Do not assume `pnpm publish` is trusted-publisher compatible; test it in a non-destructive/staged flow or use the documented npm CLI path. If token-based publishing is retained, `pnpm publish -r --provenance` is documented, but it gives up the principal benefit of OIDC (no long-lived write secret).

npm's provenance guide also recommends no dependency cache in release builds and requires a public repository whose `repository` metadata matches the publishing source ([npm provenance prerequisites and workflow](https://docs.npmjs.com/generating-provenance-statements#prerequisites)).

## 7. Preserving install compatibility

### npm installs

For existing users, the compatibility checklist is:

- keep `pi-ax` and `pi-bash-tools` as the npm package names;
- keep their independent semver histories—do not reset to a monorepo version;
- preserve the exact Pi extension manifest paths;
- preserve every file required by those paths and their transitive runtime imports;
- preserve ESM interpretation and the Node engine floor unless a release explicitly changes them;
- preserve Pi peers as unbundled optional peers and package-owned runtime dependencies;
- avoid adding a restrictive `exports` map without a deep-import audit;
- publish tarballs whose contents match the pre-migration package shape apart from intentional metadata/path changes;
- verify with `pi -e npm:pi-ax@<new-version>` and `pi -e npm:pi-bash-tools@<new-version>` after publishing.

Pi accepts npm package specs such as `npm:@foo/bar@1.0.0`; versioned specs are pinned, while unversioned packages can be updated by Pi's package-update flow ([Pi npm package sources](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#npm)). Keeping the names is therefore what preserves those settings.

### Git/local installs are a separate compatibility surface

Pi also installs packages from Git repositories and local paths. For a directory, it applies package rules to that directory; manifest paths are relative to that package root. For Git sources, Pi clones the repository and runs installation from the clone when a `package.json` is present ([Pi package sources](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#package-sources)).

Moving each old repository into `packages/<name>` means an old Git URL no longer naturally points at the same package root. A root `pi` manifest in `pi-tools` could load both subpackages, but that creates a new combined product and is not equivalent to either old Git install.

**Recommendation:** treat registry compatibility as the primary guarantee. For old Git installs, choose and document one policy:

1. keep each old repository available at its existing tags/commits and direct users to the unchanged npm package for updates; or
2. maintain a thin compatibility repository whose root still has the old package shape; or
3. explicitly announce Git-source installs as a breaking migration and provide replacement npm specs.

Do not rely on a GitHub repository redirect alone: even if cloning redirects, the checked-out root shape has changed. Do not make the `pi-tools` root auto-load both extensions merely to imitate old URLs unless an umbrella Pi package is intentionally desired and separately tested.

**Uncertainty / decision:** no install telemetry or support policy was provided, so the importance of old Git/local installs is unknown. Search the old repositories' documented install commands and user settings before retiring them.

## 8. Suggested migration and verification order

1. **Inventory compatibility:** record the current `pnpm pack --dry-run` output, packed manifest, package size, and Pi load command for each repository.
2. **Create topology only:** move repositories into `packages/pi-ax` and `packages/pi-bash-tools`; retain package manifests, configs, and versions initially.
3. **Create root control files:** private root manifest, one pinned package manager, workspace glob, merged pnpm security settings, and one generated lockfile.
4. **Restore green checks:** run every existing package check from the package directory and recursively from the root.
5. **Consolidate shared config:** introduce `tsconfig.base.json` and a minimal Vite+ shared config without erasing package-specific rules or test settings.
6. **Align toolchains separately:** test `pi-bash-tools` on TypeScript 7/Vite+ 0.3; resolve the Node type-version decision; then centralize versions.
7. **Update publication metadata:** canonical monorepo repository URL plus per-package `repository.directory`, homepages, issue tracker, and explicit publish policy.
8. **Add release intents:** pnpm-native versioning or Changesets, independent package bumps, and repository changelogs if desired.
9. **Add protected release CI:** OIDC trusted publishers for both packages, final pnpm-created tarballs, npm CLI publication, and automatic provenance verification.
10. **Diff artifacts:** compare pre/post tarball trees and manifests. Explain every difference.
11. **Publish a patch release:** exercise both npm install paths and Pi's package loader before archiving or redirecting old repositories.

## Requirements versus recommendations at a glance

| Area | Requirement / externally defined behavior | Recommendation for `pi-tools` |
|---|---|---|
| Workspace | Root `pnpm-workspace.yaml` | `packages/*` only |
| Root publishability | `private: true` prevents npm publish | Private `pi-tools` root |
| Lockfile | Shared root lockfile is pnpm's default | Commit one lockfile; frozen CI install |
| Package identity | npm compatibility follows name/version | Retain both names and independent versions |
| Pi resources | Manifest paths are package-root-relative | Preserve current `pi.extensions` paths |
| Pi peers | Pi core/typebox peers use `*`, unbundled | Keep optional peers + concrete root dev versions |
| Tarball | `files` controls payload; pack transforms workspace/catalog specs | Narrow allowlists + clean-room tarball tests |
| Exports | `exports` encapsulates paths and may break deep imports | Do not add until a public JS API exists |
| TypeScript 7 | Stable 7.0.2; no stable programmatic API in 7.0 | Align after `pi-bash-tools` compatibility checks |
| Lint/format | Vite+ uses Oxlint/Oxfmt and recommends Vite config blocks | Shared base object; package-local overrides |
| Versioning | pnpm 11.13+ supports Changesets-format native intents | Independent pnpm-native releases by default |
| Provenance | npm trusted publishing needs OIDC, npm 11.5.1+, Node 22.14+ | pnpm pack, npm publish tarballs via protected CI |
| Old Git URLs | Pi treats cloned root as package root | Keep compatibility repos or announce migration |

## Final uncertainties to resolve before implementation

1. What is the canonical GitHub owner/URL for `pi-tools`?
2. Are old Git-source Pi installs supported, or only npm installs?
3. Does either package or its test tooling import the TypeScript compiler API?
4. Does `pi-ax` genuinely require Node 26 declarations while advertising Node 22 runtime support?
5. Which concrete Pi version is the shared development/test baseline?
6. Should releases use pnpm-native versioning or automated Changesets version PRs?
7. Is an umbrella `pi-tools` Pi package that loads both extensions desired? It should not be created implicitly.

Resolving those decisions is sufficient to turn this design into a low-risk migration plan; none requires renaming the two published packages.
