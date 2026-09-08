# @jhnsml/pi-bash-tools

A Pi package that exposes modern command-line utilities as typed tools, plus a `/jump` command backed by zoxide.

The package owns the Pi adapter layer—typed schemas, safe argv construction, cancellation, timeouts, bounded output, and prompt guidance—while each CLI remains the source of truth for its behavior.

The development baseline is Pi 0.80.9; verification currently uses Pi 0.80.10 and TypeBox 1.x. Older Pi versions are not supported or tested. Host-provided packages retain wildcard optional peer dependencies, as recommended by [Pi's package documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md#dependencies); these ranges are not a claim of compatibility with every Pi version.

## Install

`@jhnsml/pi-bash-tools` does not bundle the underlying executables. On macOS, install them with Homebrew:

```bash
brew install bat eza ast-grep jq yq difftastic gh sd scc zoxide
```

Then install the published Pi package from npm:

```bash
pi install npm:@jhnsml/pi-bash-tools
```

## Tools

| Pi interface     | CLI project                                                                                       | Purpose                                           |
| ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `read_file`      | [`bat`](https://github.com/sharkdp/bat)                                                           | Read files with line numbers and optional ranges  |
| `list_dir`       | [`eza`](https://eza.rocks/) ([source](https://github.com/eza-community/eza))                      | List directories, metadata, trees, and Git status |
| `ast_search`     | [`sg` (`ast-grep`)](https://ast-grep.github.io/) ([source](https://github.com/ast-grep/ast-grep)) | Search source code with structural patterns       |
| `json_query`     | [`jq`](https://jqlang.org/) ([source](https://github.com/jqlang/jq))                              | Query JSON files or inline JSON                   |
| `yaml_query`     | [`yq`](https://mikefarah.gitbook.io/yq/) ([source](https://github.com/mikefarah/yq))              | Query YAML, TOML, or JSON files and inline data   |
| `diff_files`     | [`difft`](https://difftastic.wilfred.me.uk/) ([source](https://github.com/Wilfred/difftastic))    | Compare files with a syntax-aware diff            |
| `gh`             | [`gh`](https://cli.github.com/) ([source](https://github.com/cli/cli))                            | Run GitHub CLI subcommands with typed tool input  |
| `find_replace`   | [`sd`](https://github.com/chmln/sd)                                                               | Replace text in a file                            |
| `codebase_stats` | [`scc`](https://github.com/boyter/scc)                                                            | Analyze code size and approximate complexity      |
| `/jump`          | [`zoxide`](https://github.com/ajeetdsouza/zoxide)                                                 | Switch a conversation fork to another directory   |

### Jump between projects

Run `/jump <query>` to find a directory with zoxide. After you confirm the destination, Pi forks the saved conversation and switches to the fork. The original conversation remains unchanged.

`/jump` requires a saved conversation and a UI that supports confirmation.

### Input rules

| Input                 | Behavior                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| File paths            | Leading `-` is protected with `./`. A path of `-` means the file named `-`, not stdin.                        |
| Line ranges and depth | Values must be positive integers; a line range can't end before it starts.                                    |
| Output formats        | `yaml_query` accepts `yaml`, `json`, `toml`, and `props`.                                                     |
| TOML input            | `yaml_query` requires Mike Farah's Go-based `yq`. Clear TOML uses its TOML parser; ambiguous input uses YAML. |

Pi validates tool inputs before execution and passes query expressions separately from CLI options.

### Output

Tool output is limited to 2,000 lines or 50 KB. Diagnostics appear before standard output. If the result is truncated, it includes the path to a file under Pi's agent data directory (`~/.pi/agent/tmp/pi-bash-tools/`, or the directory selected by `PI_CODING_AGENT_DIR`) containing the complete combined output.

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
