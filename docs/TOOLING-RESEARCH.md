# Repository tooling research

**Research date:** 2026-09-06
**Decision supported:** whether and how to add Conventional Commits and Git hooks without disrupting this pnpm monorepo's existing Changesets release flow.

## Executive recommendation

1. Keep **Changesets** as the only authority for package selection, SemVer bumps, and changelogs. Conventional Commits should improve history and squash-merge titles, not determine versions.
2. Start with `@commitlint/cli` plus `@commitlint/config-conventional`. If this repository squash-merges pull requests, enforce the **PR title in CI** and let maintainers/contributors use arbitrary intermediate commits. If individual commits are retained, also lint the commit range in CI.
3. For local feedback, prefer the existing Vite+ native hook dispatcher over Husky: track `.vite-hooks/commit-msg` and `.vite-hooks/pre-commit`, install the generated dispatcher with `vp config`, and use `vp staged` for staged formatting. It adds no hook-manager dependency. Use `simple-git-hooks` instead only if the project stops using Vite+; use Lefthook only if hooks grow beyond this repository's small staged-check surface.
4. Before enforcing Conventional Commits on all commits, configure the current Changesets action's generated commit and PR title as `chore(release): version packages`; its v1 defaults are `Version Packages` and would fail commitlint.
5. Make the release artifact policy explicit. The current custom publisher does publish npm packages, but `changesets/action@v1` will not recognize those publishes, push package tags, create GitHub Releases, or set `published=true`, because it recognizes the `New tag:` output emitted by `changeset publish` and the custom script emits no such lines.

## Current repository baseline

**Observed facts.** This repository is a private pnpm workspace with independently versioned `pi-ax` and `pi-bash-tools`. The root [`package.json`](../package.json) pins pnpm 12.3.4, provides `changeset`, `version-packages`, and `release` scripts, and uses `@changesets/cli ^2.29.7`. [`.changeset/config.json`](../.changeset/config.json) uses `baseBranch: main`, public access, independent packages, and `commit: false`. [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the full check/test/coverage/smoke/pack suite for pushes to `main` and pull requests.

The current [release workflow](../.github/workflows/release.yml) runs on pushes to `main`, invokes the maintenance/v1 Changesets action with conventional `commit`/`title` values, `createGithubReleases: false`, `version: pnpm version-packages`, and `publish: pnpm release`, and grants contents, pull-request, and OIDC permissions. [`scripts/publish-packages.mjs`](../scripts/publish-packages.mjs) checks npm, packs each package, and publishes the tarball with provenance. Commitlint is configured in [`commitlint.config.mjs`](../commitlint.config.mjs), and Vite+ manages tracked `.vite-hooks/commit-msg` and `.vite-hooks/pre-commit` hooks.

## 1. Conventional Commits options

### What the convention does—and does not do here

**Sourced fact.** Conventional Commits 1.0.0 defines `<type>[optional scope]: <description>`, with `feat` corresponding to a minor change, `fix` to a patch, and `!` or a `BREAKING CHANGE:` footer to a major change. Other types are allowed. The specification also explicitly says not every contributor must author conforming intermediate commits when a squash workflow lets maintainers normalize the final commit. [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)

**Recommendation.** Use the convention for readable history and machine-checkable merge commits, but do not derive releases from it. Changesets already stores the package-level release intent, bump type, and changelog prose that a multi-package repository needs. Adding semantic-release or release-please as a second version authority would create overlapping release state without solving a current gap.

Suggested types are the conventional defaults: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, and `test`. Scopes should initially be optional; useful examples are `pi-ax`, `pi-bash-tools`, `repo`, and `release`. Mandatory package scopes make cross-cutting changes awkward and are not required by the specification.

### Option A: commitlint validation (recommended)

**Sourced fact.** commitlint's official pnpm setup is:

```sh
pnpm add -D @commitlint/cli @commitlint/config-conventional
```

with an ESM config extending `@commitlint/config-conventional`. Its local guide requires a `commit-msg` hook—not `pre-commit`—and its CI guide recommends full checkout history, `--last` on pushes, and `--from <base-sha> --to <head-sha>` for pull requests. Local hooks alone are mutable/bypassable, so the guide recommends CI for enforcement. [Getting started](https://commitlint.js.org/guides/getting-started.html), [local setup](https://commitlint.js.org/guides/local-setup.html), [CI setup](https://commitlint.js.org/guides/ci-setup.html)

Minimal configuration shape (implemented in this repository):

```js
// commitlint.config.mjs
export default {
  extends: ["@commitlint/config-conventional"],
};
```

```jsonc
// package.json fragments
{
  "scripts": {
    "commitlint": "commitlint"
  }
}
```

For repositories that preserve every PR commit, add `fetch-depth: 0` to checkout and run:

```sh
pnpm exec commitlint --from "$BASE_SHA" --to "$HEAD_SHA" --verbose
```

For a squash-only policy, validating the PR title is less burdensome and validates the text that becomes the merge commit. `amannn/action-semantic-pull-request@v6` is specifically designed for Conventional Commit PR titles and documents GitHub's “Default to PR title for squash merge commits” setting. Its fork-safe example uses `pull_request_target` with only `pull-requests: read`. [action-semantic-pull-request README](https://github.com/amannn/action-semantic-pull-request/blob/main/README.md)

**Recommendation.** Prefer PR-title enforcement if this repository uses squash merging. Otherwise enforce both the local `commit-msg` hook and the CI commit range. Pin any added GitHub Action to a full commit SHA in the actual workflow.

### Option B: guided authoring with Commitizen (optional, not enforcement)

**Sourced fact.** Commitizen prompts authors for the message fields and supports pnpm initialization with `cz-conventional-changelog`. Its documented local pattern is a `commit` script that runs `cz`, plus `config.commitizen.path: "cz-conventional-changelog"`. Commitizen's own documentation says it complements rather than replaces commit hooks. [Commitizen README](https://github.com/commitizen/cz-cli/blob/master/README.md)

A non-mutating implementation plan would be:

```sh
pnpm add -D commitizen cz-conventional-changelog
```

```jsonc
{
  "scripts": { "commit": "cz" },
  "config": {
    "commitizen": { "path": "cz-conventional-changelog" }
  }
}
```

**Recommendation.** Add this only if contributors ask for an interactive prompt. It adds dependencies and a second command (`pnpm commit`) but does not enforce messages entered through `git commit`, IDEs, or the GitHub UI. commitlint or PR-title CI remains the enforcement layer.

### Release-generated commits must be covered

**Observed fact.** The v1 action defaults both version commits and PR titles to `Version Packages`; its supported inputs are `commit` and `title`. This repository overrides both with `chore: version packages`. [changesets/action v1 action definition](https://github.com/changesets/action/blob/maintenance/v1/action.yml)

**Recommendation.** Keep the release-generated message conventional:

```yaml
with:
  version: pnpm version-packages
  publish: pnpm release
  commit: "chore(release): version packages"
  title: "chore(release): version packages"
```

This does not change `.changeset/config.json`'s `commit: false`: that option controls whether the Changesets CLI itself commits generated files; the GitHub Action separately commits its version-PR output.

## 2. Do Changesets trigger releases?

### Direct answer

**No—not by themselves.** A changeset is committed release metadata. `changeset version` consumes that metadata and changes versions/changelogs; `changeset publish` publishes package versions not yet present in the registry. Those commands can be run manually or by CI. A GitHub workflow event, such as the current `push` to `main`, is what starts automation. [Changesets v2 workflow](https://github.com/changesets/changesets/blob/maintenance/v2/docs/intro-to-using-changesets.md), [Changesets v2 CLI reference](https://github.com/changesets/changesets/blob/maintenance/v2/docs/command-line-options.md)

This distinction matters:

- Adding or merging `.changeset/*.md` does not itself publish.
- A workflow triggered by the merge runs `changesets/action`.
- The action decides whether to maintain a version PR or invoke the configured publish command.
- Merging the version PR triggers the workflow again; now the consumed changesets are gone and the publish path can run.

### `changesets/action@v1` decision table

This project pins the **maintenance/v1** action, compatible with Changesets v2. The action's source implements these branches: [v1 `src/index.ts`](https://github.com/changesets/action/blob/maintenance/v1/src/index.ts)

| State when the workflow invokes the action | v1 behavior |
| --- | --- |
| Non-empty changesets exist | Runs the configured `version` command (or `changeset version`), pushes/updates `changeset-release/<branch>`, and opens or updates a version PR. |
| Only empty changesets exist | Does not create a version PR. |
| No changesets and no `publish` input | Does nothing. |
| No changesets and a `publish` input | Runs the publish command, attempting to publish any unpublished versions. |

The action README describes the same two-phase flow: changesets on the base branch maintain a version PR; merging that PR can cause automatic npm publication when `publish` is configured. [changesets/action v1 README](https://github.com/changesets/action/blob/maintenance/v1/README.md)

Because any unrelated push with no changesets can reach the publish branch, the publish command should be idempotent. The current custom publisher is substantially idempotent: it checks the registry and skips a package when the current manifest version is already published.

### Important current-repository caveat: npm publish is not action publish detection

**Observed fact plus source-level implication.** The action runs any configured publish script, but v1 determines which packages were released by parsing stdout for `New tag: <package>@<version>`, the format produced by `changeset publish`. It only then sets `published=true`; with the default `createGithubReleases: true`, it pushes tags and creates releases from changelog entries. [v1 `runPublish`](https://github.com/changesets/action/blob/maintenance/v1/src/run.ts)

This repository's [`scripts/publish-packages.mjs`](../scripts/publish-packages.mjs) calls `npm publish` itself and emits no `New tag:` lines. Therefore:

- npm publication can succeed;
- the action will report `published=false` and `publishedPackages=[]`;
- the action will not push package tags or create GitHub Releases for those publishes.

**Recommendation.** Decide deliberately among these outcomes:

1. **npm-only release:** keep the custom publisher and set `createGithubReleases: false` explicitly so the workflow states its intent;
2. **Changesets-managed tags/releases:** make the publish script eventually call `changeset publish` after required builds/checks, preserving the custom safety checks elsewhere; or
3. **custom release artifacts:** keep custom npm publication and create tags/GitHub Releases explicitly from a structured manifest result rather than imitating the action's stdout parser.

Do not assume the action's default `createGithubReleases: true` currently produces releases.

## 3. Pre-commit and commit-message hook alternatives to Husky in 2026

### Comparison

| Option | Installation shape | Strengths | Costs / limits | Fit here |
| --- | --- | --- | --- | --- |
| **Native Git `core.hooksPath`** | Track `.githooks/*`; each clone runs `git config --local core.hooksPath .githooks`. | No manager dependency; transparent shell files; ideal for one `commit-msg` hook. | One-time per-clone setup; hooks are client-side and bypassable; the tracked file must be executable. | **Best minimal default.** |
| **simple-git-hooks** | `pnpm add -D simple-git-hooks`; configure one command per hook; run `simple-git-hooks`, usually from root `prepare`. | Zero dependencies, small package.json config, little abstraction. | Must re-run after config changes; one command per hook (a script can fan out); relies on install/prepare behavior. | Best if automatic setup matters more than zero dependencies. |
| **Lefthook** | `pnpm add -D lefthook`; configure `lefthook.yml`; `lefthook install`. | Parallel jobs, staged-file placeholders, filters, per-directory roots, direct `lefthook run`. | More machinery and a platform binary; pnpm must allow its install script for automatic installation. | Use only if hooks grow beyond commit-message validation. |
| **pre-commit framework** | Install the external `pre-commit` tool, add `.pre-commit-config.yaml`, run `pre-commit install`. | Mature cross-language plugin ecosystem and reproducible hook environments. | Adds a non-Node tool/runtime and YAML ecosystem for a TypeScript-only pnpm workspace. | Valid for a future polyglot repo; excessive now. |

**Primary-source basis.** Git looks in `$GIT_DIR/hooks` by default and `core.hooksPath` redirects that directory; the path may be absolute or relative. [Git `core.hooksPath`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corehooksPath), [githooks](https://git-scm.com/docs/githooks). simple-git-hooks documents zero dependencies, one command per hook, explicit reapplication, and a `prepare` setup; it also notes that modern pnpm blocks dependency install scripts and recommends the root `prepare` approach. [simple-git-hooks README](https://github.com/toplenboren/simple-git-hooks/blob/master/README.md). Lefthook documents a single Go binary, parallel/file-aware jobs, and `lefthook install`; its pnpm installation page requires allowing Lefthook's install script for automatic setup. [Lefthook README](https://github.com/evilmartians/lefthook/blob/master/README.md), [Node/pnpm installation](https://lefthook.dev/installation/node), [usage](https://lefthook.dev/usage/). pre-commit's official setup installs into `.git/hooks/pre-commit`. [pre-commit documentation](https://pre-commit.com/#install)

`lint-staged` is not a hook manager; it is a staged-file task runner to invoke from a hook. It is useful when formatting only changed files, but it does not install or enforce `commit-msg` by itself.

### Hook setup implemented for this repository

Vite+ provides the hook dispatcher and staged-file runner already used by this workspace:

```jsonc
{
  "scripts": {
    "prepare": "vp config --no-agent"
  }
}
```

```sh
#!/bin/sh
# .vite-hooks/commit-msg
pnpm exec commitlint --edit "$1"

# .vite-hooks/pre-commit
pnpm exec vp staged
pnpm check
```

The generated dispatcher is ignored under `.vite-hooks/_`; project-owned hook scripts remain tracked. Keep the hook fast: the full test, coverage, smoke, and pack gates still run in CI.

## 4. Representative repository survey

The repository names were ambiguous, so the inspected repositories are identified precisely. Findings are snapshots, not prescriptions.

### Matt Pocock / Total TypeScript

**Repository selected:** [`mattpocock/total-typescript-monorepo`](https://github.com/mattpocock/total-typescript-monorepo), described as the home of Matt Pocock's internal tooling. Snapshot: [`fd2f2802`](https://github.com/mattpocock/total-typescript-monorepo/tree/fd2f2802c859a5880eec8ad9f035d02583946d04), 2026-01-28.

**Observed facts.**

- The root uses pnpm 9 and Turborepo. Its central scripts are `dev: turbo watch build`, `ci: turbo build test lint`, `build: turbo build`, `release: pnpm run ci && changeset publish`, and `prepare: husky`. It depends on Changesets and has Husky/lint-staged dev dependencies. [`package.json`](https://github.com/mattpocock/total-typescript-monorepo/blob/fd2f2802c859a5880eec8ad9f035d02583946d04/package.json)
- `.husky/pre-commit` runs `pnpx lint-staged` and then the full `pnpm run ci`; `.lintstagedrc` formats every staged file with Prettier. [hook](https://github.com/mattpocock/total-typescript-monorepo/blob/fd2f2802c859a5880eec8ad9f035d02583946d04/.husky/pre-commit), [lint-staged config](https://github.com/mattpocock/total-typescript-monorepo/blob/fd2f2802c859a5880eec8ad9f035d02583946d04/.lintstagedrc)
- CI runs on every push, installs with `--no-frozen-lockfile`, and runs the root `ci` script. [`.github/workflows/ci.yml`](https://github.com/mattpocock/total-typescript-monorepo/blob/fd2f2802c859a5880eec8ad9f035d02583946d04/.github/workflows/ci.yml)
- The publish workflow runs on pushes to `main` and invokes `changesets/action@v1` with `publish: pnpm run release`, so it follows the version-PR/publish cycle. [`.github/workflows/publish.yml`](https://github.com/mattpocock/total-typescript-monorepo/blob/fd2f2802c859a5880eec8ad9f035d02583946d04/.github/workflows/publish.yml)
- Changesets uses independent public packages and an ignore list for internal/example packages. [`.changeset/config.json`](https://github.com/mattpocock/total-typescript-monorepo/blob/fd2f2802c859a5880eec8ad9f035d02583946d04/.changeset/config.json)
- The inspected root manifest and sole Husky hook contain no commitlint/Commitizen setup. This repository is evidence for Husky plus a heavy pre-commit gate, not Conventional Commit enforcement.

**Judgment.** Its full CI-on-commit policy is stricter and slower than this repository needs. Its Changesets action pattern is relevant; its `--no-frozen-lockfile` CI install is not a good model for reproducibility.

### pi.dev / pi-mono

**Repository selected:** [`earendil-works/pi`](https://github.com/earendil-works/pi), snapshot [`9767ba27`](https://github.com/earendil-works/pi/tree/9767ba275f3e9a5ee0f5c5342249b629ab1b2282), 2026-09-05. The former `badlogic/pi-mono` GitHub API URL redirects to this canonical repository; the root package still calls itself `pi-monorepo`.

**Observed facts.**

- It is an **npm workspaces** monorepo, not pnpm. Root scripts explicitly sequence package builds; `check` runs Biome with writes plus repository-specific integrity checks and tsgo; test runs script tests plus workspace tests; release scripts are custom; `prepare` runs Husky. [`package.json`](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/package.json)
- `.husky/pre-commit` validates lockfile staging, runs the full check, conditionally runs a browser smoke test for relevant paths, and re-stages files changed by formatting. [`.husky/pre-commit`](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/.husky/pre-commit)
- Main CI runs on pushes and pull requests, uses `npm ci --ignore-scripts`, then build/check/test. A separate scheduled/manual workflow runs production `npm audit` and signature verification. [CI](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/.github/workflows/ci.yml), [audit](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/.github/workflows/npm-audit.yml)
- It does **not** use Changesets. `scripts/release.mjs` checks a clean tree, bumps all workspace versions, updates changelogs, regenerates artifacts, checks/tests, commits, creates `v<version>`, and pushes main/tag. The tag-triggered binary workflow builds and smoke-tests platform artifacts, stages a draft GitHub Release, publishes npm through OIDC, announces the verified release to pi.dev, then publishes the GitHub Release. [release script](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/scripts/release.mjs), [build/release workflow](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/.github/workflows/build-binaries.yml)
- The root dependency/hook setup has no commitlint. The sampled head commit uses `fix(coding-agent): ...`, but the release script's own messages (`Release v...`, `Add [Unreleased]...`) are not Conventional Commit messages.

**Judgment.** pi's strong artifact staging, cross-platform smoke tests, OIDC publication, and “publish GitHub Release last” ordering are useful release-safety patterns. Its lockstep custom release model and heavy modifying pre-commit hook are not directly transferable to two independently released Changesets packages.

### shadcn/ui

**Repository selected:** [`shadcn-ui/ui`](https://github.com/shadcn-ui/ui), snapshot [`5c7072da`](https://github.com/shadcn-ui/ui/tree/5c7072da672b0048bc6771e3204063a2537df91a), 2026-09-06.

**Observed facts.**

- It is a pnpm 10 workspace with Turborepo. Root scripts fan out build/lint/typecheck/format/test operations; `release` runs `changeset version`, while package-specific publication scripts cover beta, RC, and stable channels. [`package.json`](https://github.com/shadcn-ui/ui/blob/5c7072da672b0048bc6771e3204063a2537df91a/package.json)
- It installs `@commitlint/cli` and `@commitlint/config-conventional`; `.commitlintrc.json` extends the conventional config, and `CONTRIBUTING.md` documents `category(scope or module): message`. [config](https://github.com/shadcn-ui/ui/blob/5c7072da672b0048bc6771e3204063a2537df91a/.commitlintrc.json), [contribution convention](https://github.com/shadcn-ui/ui/blob/5c7072da672b0048bc6771e3204063a2537df91a/CONTRIBUTING.md)
- There is no root `.husky` directory, hook-manager dependency, or `prepare` script. The inspected root scripts and listed workflows do not invoke commitlint, so commitlint is configured but no local or CI enforcement path was observed. A separate workflow checks commit **signatures**, not message format. [signed-commit workflow](https://github.com/shadcn-ui/ui/blob/5c7072da672b0048bc6771e3204063a2537df91a/.github/workflows/signed-commits.yml)
- CI is split: `code-check.yml` runs lint, formatting, and typecheck jobs; `test.yml` runs general and package-specific tests; browser and registry workflows are separate. [code checks](https://github.com/shadcn-ui/ui/blob/5c7072da672b0048bc6771e3204063a2537df91a/.github/workflows/code-check.yml), [tests](https://github.com/shadcn-ui/ui/blob/5c7072da672b0048bc6771e3204063a2537df91a/.github/workflows/test.yml)
- Changesets publishes `shadcn`, `@shadcn/react`, and `@shadcn/helpers` independently; the config uses the GitHub changelog plugin and ignores app/test workspaces. [release guide](https://github.com/shadcn-ui/ui/blob/5c7072da672b0048bc6771e3204063a2537df91a/RELEASING.md), [config](https://github.com/shadcn-ui/ui/blob/5c7072da672b0048bc6771e3204063a2537df91a/.changeset/config.json)
- On pushes to `main`, the release workflow builds publishable packages, imports a signing key, and runs `changesets/action@v1` with an explicit conventional commit/title, a custom version script, and `npx changeset publish`. Labeled PRs can publish timestamped Changesets snapshots to beta/RC tags. [`.github/workflows/release.yml`](https://github.com/shadcn-ui/ui/blob/5c7072da672b0048bc6771e3204063a2537df91a/.github/workflows/release.yml)

**Judgment.** shadcn/ui is the closest model for this repository's independent-package release flow. Its explicit `chore(release): version packages` action configuration is directly applicable. Its presence of commitlint without an observed invocation is a warning that installing/configuring a linter is not the same as enforcing it.

## Cross-repository takeaways

### Observed

- Two of the three surveyed repositories still use Husky in 2026; shadcn/ui has no observed local hook manager.
- The two pnpm repositories that use Changesets run the action on pushes to `main`, maintain a version PR, and publish only after the version changes return to `main`.
- Release policy is not standardized: Matt Pocock's repository delegates publication to `changeset publish`; shadcn/ui adds builds, signed release commits, snapshots, and GitHub changelogs; pi uses a custom lockstep/tag pipeline with staged artifacts.
- Conventional-looking history can exist without enforced commitlint (pi), and commitlint can exist without an observed enforcement path (shadcn/ui).

### Recommendation for pi-tools

Adopt the smallest coherent set rather than copying one repository wholesale:

1. commitlint conventional config;
2. conventional release PR commit/title;
3. PR-title CI if squash merging, otherwise commit-range CI;
4. Vite+'s tracked `commit-msg` and `pre-commit` hooks for local feedback;
5. Changesets remains authoritative for releases;
6. the custom publisher is intentionally npm-only; `createGithubReleases: false` makes that explicit.

## Implementation in pi-tools

The recommendations above are now implemented with the repository's existing Vite+ toolchain:

- `@commitlint/cli` and `@commitlint/config-conventional` are installed at `21.2.2`, with [`commitlint.config.mjs`](../commitlint.config.mjs) extending the conventional preset.
- [`vite.config.ts`](../vite.config.ts) uses `vp staged` for staged formatting. [`.vite-hooks/pre-commit`](../.vite-hooks/pre-commit) runs that formatter and the existing `pnpm check`; [`.vite-hooks/commit-msg`](../.vite-hooks/commit-msg) runs Commitlint. (The links intentionally refer to project-owned hooks; the generated dispatcher under `.vite-hooks/_` remains ignored.)
- The root `prepare` script runs `vp config --no-agent`, which installs the Vite+ dispatcher and sets the clone-local `core.hooksPath`. `VP_GIT_HOOKS=0` disables hooks for one command.
- Pull-request CI validates the commit range using base/head SHAs. The release workflow sets `commit` and `title` to `chore: version packages` so Changesets automation passes the same policy.
- The custom publisher remains npm-only. `createGithubReleases: false` is explicit because Changesets Action cannot infer published packages or create GitHub releases from this repository's custom `npm publish` output.

## Contradictions and remaining gaps

- **Action version drift:** `changesets/action`'s `main` branch is now v2 for Changesets v3, while this repository intentionally pins maintenance/v1 for Changesets v2. The analysis above uses the v1 input names and v1 source. A future major upgrade must re-check renamed inputs and permissions. [action main README](https://github.com/changesets/action/blob/main/README.md)
- **Hook enforcement limit:** every client-side hook option can be bypassed or absent in a fresh clone. Only CI/branch protection can enforce the policy.
- **Merge strategy unknown:** repository files do not reveal whether GitHub squash merging and “default to PR title” are enabled. That setting determines whether PR-title-only enforcement is sufficient.
- **GitHub code-search access:** unauthenticated GitHub code search returned 401, so claims about absent tooling are bounded to inspected root manifests, root directories, hooks, and workflow listings rather than an exhaustive semantic search of every nested file. This does not affect the primary recommendations, but it is why the survey says “no observed invocation” rather than “none exists anywhere.”
