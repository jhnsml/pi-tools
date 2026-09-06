# pi-bash-tools

A Pi package that exposes modern command-line utilities as typed tools, plus a `/jump` command backed by zoxide.

The package owns the Pi adapter layer—typed schemas, safe argv construction, cancellation, timeouts, bounded output, and prompt guidance—while each CLI remains the source of truth for its behavior.

The development baseline is Pi 0.80.9; verification currently uses Pi 0.80.10 and TypeBox 1.x. Older Pi versions are not supported or tested. Host-provided packages retain wildcard optional peer dependencies, as recommended by [Pi's package documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md#dependencies); these ranges are not a claim of compatibility with every Pi version.

## Install

`pi-bash-tools` does not bundle the underlying executables. On macOS, install them with Homebrew:

```bash
brew install bat eza ast-grep jq yq difftastic gh sd scc zoxide
```

Then install the published Pi package from npm:

```bash
pi install npm:pi-bash-tools
```

## Tools

| Pi tool          | CLI             | Purpose                                           |
| ---------------- | --------------- | ------------------------------------------------- |
| `read_file`      | `bat`           | Read files with line numbers and optional ranges  |
| `list_dir`       | `eza`           | List directories, metadata, trees, and Git status |
| `ast_search`     | `sg` (ast-grep) | Search source code with structural patterns       |
| `json_query`     | `jq`            | Query JSON files or inline JSON                   |
| `yaml_query`     | `yq`            | Query YAML, TOML, or JSON files and inline data   |
| `diff_files`     | `difft`         | Compare files with a syntax-aware diff            |
| `gh`             | `gh`            | Run GitHub CLI subcommands with typed tool input  |
| `find_replace`   | `sd`            | Replace text in a file                            |
| `codebase_stats` | `scc`           | Analyze code size and approximate complexity      |

`/jump <query>` uses `zoxide query` to find a directory. After confirmation, it forks your saved conversation into that directory and switches sessions through Pi's session lifecycle. Your original session remains unchanged. This requires a saved conversation and a UI that supports confirmation; it does not assign to Pi's read-only working-directory context.

File operands beginning with `-` are passed with a `./` prefix so CLI parsers treat them as paths, not options. A path of `-` means the file named `-`, not stdin. Query expressions are passed separately from options.

Line numbers and tree depth must be positive integers. A read range must end at or after its start. Output formats are limited to `yaml`, `json`, `toml`, and `props`; sort keys are limited to the values listed in the tool schema. Pi validates these schemas before execution.

`yaml_query` requires Mike Farah's Go-based `yq` (the Homebrew `yq` formula), not the Python tool with the same name. It selects the TOML parser for `.toml` files and recognizable inline TOML assignments or tables containing assignments. Ambiguous inline data such as `[name]` uses the YAML parser; use a `.toml` file when you need to select TOML explicitly.

Tool output and command errors stay within Pi's standard 2,000-line or 50 KB ceiling, including truncation notices. Successful commands preserve stderr under a labeled section before stdout, so large stdout does not hide diagnostics. Without stderr, stdout is returned unchanged. When output is truncated, the tool saves the complete presented output to a temporary file and returns its path. Result details include a separately bounded raw stdout value and a `stdoutTruncated` flag for command consumers such as `/jump`. This flag is independent of truncation of the combined presentation.

## Design

`extensions/bash-tools.ts` owns tool schemas and CLI-specific argument construction. `extensions/lib/command-runner.ts` exposes one `runCommand` interface that owns execution, cancellation, transient spawn retries, file mutation queueing, and bounded results and errors. Tools cannot accidentally omit output handling. Commands that have already exited are not retried.

Tests exercise tool behavior through registered tools and shared execution behavior through `runCommand`. Both use a mock `pi.exec` adapter, so deterministic tests do not require the wrapped executables.

## Build and test

Development requires Node.js 22.19+, pnpm, and Vite+ (`vp`).

```bash
vp install
vp check
vp test run
vp test run --coverage
pnpm run pack:dry
```

There is no build step. The package ships TypeScript source, which Pi loads directly.

`vp check` enforces formatting, type checking, type-aware promise checks, and restrictions on explicit `any` and unsafe values flowing from dependencies. Error checks require throwing `Error` objects and treating Promise rejection values as `unknown`. It also enforces strict equality and bans dynamic code evaluation, nested ternaries, and duplicate imports. Cyclomatic complexity is limited to 15 per function and block nesting to 4.

Test lint catches focused tests (`.only`), malformed assertions, and unawaited async assertions. Conditional assertions remain allowed for parameterized and queue-synchronization tests. These checks use the existing Vite+/Oxlint toolchain; they do not impose arbitrary file or function length limits or require another service.

## Real-CLI compatibility checks

After installing the executables listed above, run the optional smoke suite:

```bash
pnpm run test:smoke
```

This suite invokes registered adapters against disposable fixtures, including leading-dash paths, query expressions, TOML parsing, and an in-place replacement. It runs `gh --version` without accessing GitHub. Missing executables produce explicit skips; installed but incompatible executables fail. It does not test `/jump` against your zoxide database or modify your sessions. The default deterministic suite remains independent of these executables.

## Extension-loading smoke test

```bash
pi --no-extensions -e ./extensions/bash-tools.ts --list-models
pi --no-extensions -e . --list-models
```
