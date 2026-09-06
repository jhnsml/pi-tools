/**
 * bash-tools: pi.dev extension
 *
 * Exposes modern CLI tools (bat, eza, ast-grep, jq, yq, sd, difft, gh,
 * scc, zoxide) as LLM-callable tools and a /jump command.
 *
 * Note: find_files, fuzzy_filter, and search_code are intentionally absent.
 * Pi already uses rg and fd for plain-text and file-name searches.
 *
 * Installed via brew. All tools called through pi.exec so they run in the
 * session's working directory with proper signal propagation.
 */

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  defineTool,
  SessionManager,
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runCommand } from "./lib/command-runner.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function fail(text: string): never {
  throw new Error(text);
}

// Prefix rather than resolve: retain relative output paths while preventing option parsing
// and the special stdin operand "-" across the different CLI parsers.
function fileOperand(path: string) {
  return path.startsWith("-") ? `./${path}` : path;
}

function isExistingPath(cwd: string, input: string) {
  return existsSync(resolve(cwd, input));
}

function looksLikeJsonInput(input: string) {
  return (
    input.startsWith("{") ||
    input.startsWith("[") ||
    input.startsWith('"') ||
    input === "true" ||
    input === "false" ||
    input === "null" ||
    /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(input)
  );
}

function looksLikeTomlInput(input: string) {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const assignment = /^(?:[A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*=/;
  const firstLine = lines[0] ?? "";
  // A lone [name] is also a YAML flow sequence; require an assignment after a table header.
  return (
    assignment.test(firstLine) ||
    (/^\[\[?[A-Za-z0-9_."' -]+\]\]?(?:\s*#.*)?$/.test(firstLine) &&
      lines.slice(1).some((line) => assignment.test(line)))
  );
}

function looksLikeYamlOrTomlInput(input: string) {
  return (
    looksLikeTomlInput(input) ||
    input.includes("\n") ||
    input.startsWith("{") ||
    input.startsWith("[") ||
    input.startsWith("-") ||
    input.startsWith("---") ||
    input.startsWith('"') ||
    /^[A-Za-z0-9_.-]+\s*:/.test(input) ||
    /^\[[^\]]+\]$/.test(input)
  );
}

function splitShellArgs(input: string) {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let tokenStarted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\\") {
      i += 1;
      if (i >= input.length) throw new Error("unterminated escape sequence");
      current += input[i];
      tokenStarted = true;
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }

      current += char;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (quote) throw new Error("unterminated quoted string");
  if (tokenStarted) args.push(current);

  return args;
}

// ── tool factories (need pi.exec via closure) ─────────────────────────────────

function makeReadFileTool(pi: ExtensionAPI) {
  return defineTool({
    name: "read_file",
    label: "Read File (bat)",
    description:
      "Read a file using bat with plain output and line numbers. " +
      "Supports optional line ranges. Prefer this over the built-in read tool " +
      "when you want line numbers printed alongside content.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file" }),
      start_line: Type.Optional(
        Type.Integer({ minimum: 1, description: "First line to read (1-indexed)" }),
      ),
      end_line: Type.Optional(
        Type.Integer({ minimum: 1, description: "Last line to read (1-indexed)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.end_line !== undefined && params.end_line < (params.start_line ?? 1)) {
        throw new Error("end_line must be greater than or equal to start_line");
      }
      const args = ["--plain", "--color=never", "--number"];
      if (params.start_line !== undefined || params.end_line !== undefined) {
        const start = params.start_line ?? 1;
        const end = params.end_line ?? "";
        args.push("--line-range", `${start}:${end}`);
      }
      args.push(fileOperand(params.path));

      return runCommand(pi, "bat", args, { cwd: ctx.cwd, signal, timeout: 10000 });
    },
  });
}

function makeListDirTool(pi: ExtensionAPI) {
  return defineTool({
    name: "list_dir",
    label: "List Directory (eza)",
    description:
      "List directory contents using eza. Supports tree view, file metadata, and git status. " +
      "Use tree=true for recursive views; long=true for sizes and timestamps.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to list (defaults to cwd)" })),
      tree: Type.Optional(Type.Boolean({ description: "Show as a tree (default: false)" })),
      depth: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Tree depth limit when tree=true (default: 3)",
        }),
      ),
      all: Type.Optional(Type.Boolean({ description: "Include hidden files" })),
      long: Type.Optional(Type.Boolean({ description: "Show size and modified time" })),
      git: Type.Optional(Type.Boolean({ description: "Show git status per entry" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["--color=never", "--icons=never"];
      if (params.tree) {
        args.push("--tree", "--level", String(params.depth ?? 3));
      }
      if (params.all) args.push("--all");
      if (params.long) args.push("--long", "--no-permissions", "--no-user");
      if (params.git) args.push("--git");
      if (params.path) args.push(fileOperand(params.path));

      return runCommand(pi, "eza", args, { cwd: ctx.cwd, signal, timeout: 10000 });
    },
  });
}

function makeAstSearchTool(pi: ExtensionAPI) {
  return defineTool({
    name: "ast_search",
    label: "AST Search (ast-grep)",
    description:
      "Search code using structural AST patterns with ast-grep (sg). " +
      "Output is truncated to 2000 lines or 50KB. " +
      "Use for syntax-shaped queries, not bare identifiers/properties (use bash with rg for those). " +
      "Metavariables: $VAR matches a single AST node, $$$VAR matches zero or more nodes. " +
      "Example patterns: 'console.log($MSG)', 'async function $F($$$) { $$$BODY }', " +
      "'if ($COND) { $$$ }'. Lang is auto-detected from file extensions if omitted.",
    promptSnippet:
      "Search source code by structural AST pattern using ast-grep; use bash with rg for bare identifiers.",
    promptGuidelines: [
      "Use ast_search only for structural code patterns such as function calls, declarations, conditionals, JSX elements, or imports.",
      "Do not use ast_search for bare identifiers, object property names, or string constants; use bash with rg first. Use fd for file names.",
    ],
    parameters: Type.Object({
      pattern: Type.String({
        description: "AST pattern with optional $VAR / $$$VAR metavariables",
      }),
      path: Type.Optional(
        Type.String({
          description: "File or directory to search (defaults to cwd)",
        }),
      ),
      lang: Type.Optional(
        Type.String({
          description: "Language override: ts, tsx, js, jsx, py, rs, go, java, c, cpp, etc.",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["run", "--pattern", params.pattern, "--color=never"];
      if (params.lang) args.push("--lang", params.lang);
      if (params.path) args.push(fileOperand(params.path));

      return runCommand(pi, "sg", args, {
        cwd: ctx.cwd,
        signal,
        timeout: 15000,
        okCodes: [0, 1],
        emptyOutput: "(no matches)",
      });
    },
  });
}

function makeJsonQueryTool(pi: ExtensionAPI) {
  return defineTool({
    name: "json_query",
    label: "JSON Query (jq)",
    description:
      "Query and transform JSON using jq. " +
      "Pass a file path or a raw JSON string as input. " +
      "Examples: '.name', '.items[] | .id', '{n: .name, count: (.items | length)}'.",
    parameters: Type.Object({
      query: Type.String({ description: "jq filter expression" }),
      input: Type.String({ description: "JSON string or file path" }),
      raw_output: Type.Optional(Type.Boolean({ description: "Output raw strings (jq -r)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const jqArgs: string[] = [];
      if (params.raw_output) jqArgs.push("--raw-output");
      jqArgs.push("--", params.query);

      const trimmed = params.input.trim();
      const shouldTreatAsInline = looksLikeJsonInput(trimmed) && !isExistingPath(ctx.cwd, trimmed);

      if (shouldTreatAsInline) {
        return runCommand(
          pi,
          "sh",
          ["-c", 'input="$1"; shift; printf "%s" "$input" | jq "$@"', "--", trimmed, ...jqArgs],
          { cwd: ctx.cwd, signal, timeout: 10000 },
        );
      }
      return runCommand(pi, "jq", [...jqArgs, fileOperand(trimmed)], {
        cwd: ctx.cwd,
        signal,
        timeout: 10000,
      });
    },
  });
}

function makeYamlQueryTool(pi: ExtensionAPI) {
  return defineTool({
    name: "yaml_query",
    label: "YAML/TOML Query (yq)",
    description:
      "Query and transform YAML, TOML, or JSON files using yq. " +
      "Uses the same filter syntax as jq. Pass a file path or raw YAML/TOML string. " +
      "Examples: '.name', '.services.web.image', '.dependencies | keys'.",
    parameters: Type.Object({
      query: Type.String({ description: "yq filter expression" }),
      input: Type.String({ description: "YAML/TOML/JSON string or file path" }),
      output_format: Type.Optional(
        Type.String({
          enum: ["yaml", "json", "toml", "props"],
          description: "Output format: yaml (default), json, toml, props",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const trimmed = params.input.trim();
      const shouldTreatAsInline =
        looksLikeYamlOrTomlInput(trimmed) && !isExistingPath(ctx.cwd, trimmed);
      const isToml = shouldTreatAsInline ? looksLikeTomlInput(trimmed) : /\.toml$/i.test(trimmed);
      const yqArgs = ["eval", "--no-colors"];
      if (isToml) yqArgs.push("--input-format", "toml");
      if (params.output_format) yqArgs.push("--output-format", params.output_format);
      yqArgs.push("--expression", params.query);

      if (shouldTreatAsInline) {
        return runCommand(
          pi,
          "sh",
          ["-c", 'input="$1"; shift; printf "%s" "$input" | yq "$@"', "--", trimmed, ...yqArgs],
          { cwd: ctx.cwd, signal, timeout: 10000 },
        );
      }
      return runCommand(pi, "yq", [...yqArgs, "--", fileOperand(trimmed)], {
        cwd: ctx.cwd,
        signal,
        timeout: 10000,
      });
    },
  });
}

function makeDiffTool(pi: ExtensionAPI) {
  return defineTool({
    name: "diff_files",
    label: "Structural Diff (difft)",
    description:
      "Compare two files using difftastic (difft), which diffs by syntax tree rather than " +
      "raw text. Ignores formatting noise and shows only semantic changes. " +
      "Ideal for reviewing what actually changed before deciding what to edit. " +
      "Use instead of standard diff when working with source code.",
    parameters: Type.Object({
      path_a: Type.String({ description: "First file path" }),
      path_b: Type.String({ description: "Second file path" }),
      lang: Type.Optional(
        Type.String({
          description: "Language override: ts, js, py, rs, go, etc. (auto-detected if omitted)",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["--color=never"];
      if (params.lang) {
        const aliases = new Map([
          ["ts", "typescript"],
          ["js", "javascript"],
          ["py", "python"],
          ["rs", "rust"],
          ["jsx", "javascript jsx"],
          ["tsx", "typescript tsx"],
          ["cpp", "c++"],
        ]);
        args.push("--override", `*:${aliases.get(params.lang.toLowerCase()) ?? params.lang}`);
      }
      args.push(fileOperand(params.path_a), fileOperand(params.path_b));

      return runCommand(pi, "difft", args, {
        cwd: ctx.cwd,
        signal,
        timeout: 15000,
        okCodes: [0, 1],
        emptyOutput: "(no differences)",
      });
    },
  });
}

function makeGhTool(pi: ExtensionAPI) {
  return defineTool({
    name: "gh",
    label: "GitHub CLI (gh)",
    description:
      "Run GitHub CLI commands for repo operations: PRs, issues, CI status, releases, and more. " +
      "Pass any valid gh subcommand and arguments as a single args string. " +
      "Examples: 'pr list', 'pr view 42', 'issue create --title \"Bug\" --body \"desc\"', " +
      "'run list', 'run view 12345', 'release list'.",
    parameters: Type.Object({
      args: Type.String({
        description: "gh subcommand and arguments, e.g. 'pr list --state open'",
      }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      let ghArgs: string[];

      try {
        ghArgs = splitShellArgs(params.args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`invalid gh args: ${message}`);
      }

      if (ghArgs.length === 0) {
        return fail("gh args must not be empty");
      }

      return runCommand(pi, "gh", ghArgs, { cwd: ctx.cwd, signal, timeout: 30000 });
    },
  });
}

function makeSdTool(pi: ExtensionAPI) {
  return defineTool({
    name: "find_replace",
    label: "Find and Replace (sd)",
    description:
      "Find and replace text in files using sd, a modern sed replacement. " +
      "Supports regex or literal patterns. Safer to construct than sed — no escaping pitfalls. " +
      "Edits files in place. Use ast_search to locate sites first, then this to apply changes.",
    parameters: Type.Object({
      find: Type.String({ description: "Pattern to find (regex by default)" }),
      replace: Type.String({
        description: "Replacement string. Use $1, $2 for capture groups.",
      }),
      path: Type.String({ description: "File path to edit in place" }),
      literal: Type.Optional(
        Type.Boolean({
          description: "Treat find as a literal string, not regex",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args: string[] = [];
      if (params.literal) args.push("--string-mode");
      args.push("--", params.find, params.replace, fileOperand(params.path));

      return runCommand(pi, "sd", args, {
        cwd: ctx.cwd,
        signal,
        timeout: 10000,
        mutationPath: params.path,
        emptyOutput: "(done)",
      });
    },
  });
}

function makeCodebaseStatsTool(pi: ExtensionAPI) {
  return defineTool({
    name: "codebase_stats",
    label: "Codebase Stats (scc)",
    description:
      "Analyze code by language using scc. Shows file and line counts, code, comments, " +
      "blanks, and a fast approximation of cyclomatic complexity. Set by_file=true and " +
      "sort=complexity to get compact per-file CSV ranked by complexity. Run at the start " +
      "of a session to understand " +
      "what a repo is made of.",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Directory or file to analyze (defaults to cwd)" }),
      ),
      sort: Type.Optional(
        Type.String({
          enum: ["files", "name", "lines", "blanks", "code", "comments", "complexity"],
          description: "Sort by: files (default), name, lines, blanks, code, comments, complexity",
        }),
      ),
      by_file: Type.Optional(
        Type.Boolean({ description: "Show per-file results instead of a language summary" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["--ci", "--no-cocomo"];
      if (params.sort) args.push("--sort", params.sort);
      if (params.by_file) args.push("--by-file", "--format", "csv");
      if (params.path) args.push(fileOperand(params.path));

      return runCommand(pi, "scc", args, { cwd: ctx.cwd, signal, timeout: 15000 });
    },
  });
}

// ── /jump command ─────────────────────────────────────────────────────────────

function registerJumpCommand(pi: ExtensionAPI) {
  pi.registerCommand("jump", {
    description: "Jump to a directory using zoxide smart matching. Usage: /jump <query>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /jump <directory query>");
        return;
      }
      await ctx.waitForIdle();
      const r = await runCommand(pi, "zoxide", ["query", "--", query], {
        cwd: ctx.cwd,
        signal: ctx.signal,
        timeout: 10000,
        okCodes: [0, 1],
      });
      const output = r.details.stdout.trim();
      if (r.details.stdoutTruncated) throw new Error("zoxide returned an oversized directory path");
      if (r.details.exitCode !== 0 || !output) {
        ctx.ui.notify(`zoxide: no match for "${query}"`);
        return;
      }
      const target = resolve(ctx.cwd, output);
      if (!(await stat(target)).isDirectory()) {
        ctx.ui.notify(`Not a directory: ${target}`, "error");
        return;
      }
      const source = ctx.sessionManager.getSessionFile();
      if (!source || !existsSync(source)) {
        ctx.ui.notify(
          "Save a conversation before /jump, or start Pi from the target directory.",
          "warning",
        );
        return;
      }
      if (
        !ctx.hasUI ||
        !(await ctx.ui.confirm(
          "Jump to another project?",
          `Fork this saved conversation into ${target} and switch sessions?`,
        ))
      )
        return;
      const fork = await withFileMutationQueue(source, async () =>
        SessionManager.forkFrom(source, target),
      );
      const sessionFile = fork.getSessionFile();
      if (!sessionFile) throw new Error("The forked session has no file");
      const result = await ctx.switchSession(sessionFile, {
        withSession: async (next) => {
          next.ui.notify(`Jumped to: ${next.cwd}`);
        },
      });
      if (result.cancelled)
        ctx.ui.notify("Jump cancelled; the forked session remains available through /resume.");
    },
  });
}

// ── extension entry point ─────────────────────────────────────────────────────

export default function bashToolsExtension(pi: ExtensionAPI) {
  pi.registerTool(makeReadFileTool(pi));
  pi.registerTool(makeListDirTool(pi));
  pi.registerTool(makeAstSearchTool(pi));
  pi.registerTool(makeJsonQueryTool(pi));
  pi.registerTool(makeYamlQueryTool(pi));
  pi.registerTool(makeDiffTool(pi));
  pi.registerTool(makeGhTool(pi));
  pi.registerTool(makeSdTool(pi));
  pi.registerTool(makeCodebaseStatsTool(pi));
  registerJumpCommand(pi);
}
