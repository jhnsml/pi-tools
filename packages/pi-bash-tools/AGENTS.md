# pi-bash-tools

`pi-bash-tools` is a Pi package that adapts existing command-line utilities into typed tools.

## Working agreement

- Use pnpm with Vite+ (`vp`) for package management and development.
- Preserve the public tool names, schemas, descriptions, and `/jump` behavior unless the task explicitly changes them.
- Keep each CLI as the source of truth; the adapter should only validate input, construct argv, execute, and shape bounded results.
- Pass arguments to `pi.exec` as argv arrays rather than interpolated shell commands. The inline jq/yq stdin bridge is the sole intentional shell use.
- Keep file mutations coordinated with Pi's file mutation queue.

## Verification

Run all deterministic checks before finishing:

```bash
vp check
vp test run
vp test run --coverage
pnpm run pack:dry
pi --no-extensions -e ./extensions/bash-tools.ts --list-models
pi --no-extensions -e . --list-models
```

Tests must not require the wrapped CLIs to be installed; mock `pi.exec` for deterministic unit tests.
