import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Value } from "typebox/value";
import extension from "../extensions/bash-tools.js";

// Allow spill directories to join the test cleanup set without mocking file I/O.
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, mkdtemp: vi.fn(fs.mkdtemp) };
});

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
type ExecCall = {
  command: string;
  args: string[];
  options: Parameters<ExtensionAPI["exec"]>[2];
};
type JumpCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type ReplacedSessionContext = Parameters<
  NonNullable<NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]>["withSession"]>
>[0];

function createJumpContext(source?: string) {
  const notify = vi.fn();
  const confirm = vi.fn(async () => true);
  const switchSession = vi.fn<ExtensionCommandContext["switchSession"]>(async (file, options) => {
    await options?.withSession?.({
      cwd: SessionManager.open(file).getCwd(),
      ui: { notify },
    } as unknown as ReplacedSessionContext);
    return { cancelled: false };
  });
  const ctx = {
    get cwd() {
      return tmpdir();
    },
    hasUI: true,
    waitForIdle: vi.fn(async () => {}),
    sessionManager: { getSessionFile: () => source },
    ui: { notify, confirm },
    switchSession,
  } as unknown as ExtensionCommandContext;
  return { ctx, notify, confirm, switchSession };
}

const tempDirs = new Set<string>();
function tempDirectory(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(path);
  return path;
}

function savedSession() {
  const dir = tempDirectory("pi-bash-tools-jump-");
  const source = join(dir, "source.jsonl");
  writeFileSync(
    source,
    JSON.stringify({
      type: "session",
      version: 3,
      id: "source",
      timestamp: new Date().toISOString(),
      cwd: tmpdir(),
    }) +
      "\n" +
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: "Keep this conversation when jumping",
          timestamp: Date.now(),
        },
      }) +
      "\n",
  );
  return { dir, source };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of tempDirs) rmSync(path, { recursive: true, force: true });
  tempDirs.clear();
});

const expectedToolNames = [
  "read_file",
  "list_dir",
  "ast_search",
  "json_query",
  "yaml_query",
  "diff_files",
  "gh",
  "find_replace",
  "codebase_stats",
];

function result(stdout = "ok", stderr = "", code = 0): ExecResult {
  return { stdout, stderr, code, killed: false };
}

function createHarness(
  execute: (call: ExecCall) => ExecResult | Promise<ExecResult> = () => result(),
) {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, JumpCommand>();
  const calls: ExecCall[] = [];

  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: JumpCommand) {
      commands.set(name, command);
    },
    async exec(command: string, args: string[], options: Parameters<ExtensionAPI["exec"]>[2]) {
      const call = { command, args, options };
      calls.push(call);
      return execute(call);
    },
  } as unknown as ExtensionAPI;

  extension(pi);

  async function run(name: string, input: Record<string, unknown>, cwd = tmpdir()) {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool was not registered: ${name}`);
    if (!Value.Check(tool.parameters, input)) throw new Error("Invalid tool input");
    return tool.execute("call-1", input, undefined, undefined, { cwd } as Parameters<
      ToolDefinition["execute"]
    >[4]);
  }

  return { calls, commands, run, tools };
}

describe("bash-tools extension", () => {
  it("registers all tools and the jump command", () => {
    const { commands, tools } = createHarness();

    expect([...tools.keys()]).toEqual(expectedToolNames);
    expect(commands.get("jump")?.description).toContain("zoxide");
    expect(tools.get("ast_search")?.promptSnippet).toContain("structural AST");
    expect(tools.get("ast_search")?.promptGuidelines).toHaveLength(2);
  });

  it("constructs argv for file, directory, search, diff, and stats tools", async () => {
    const { calls, run } = createHarness();
    const signal = undefined;

    await run("read_file", { path: "src/a.ts", start_line: 2, end_line: 8 });
    await run("list_dir", {
      path: ".",
      tree: true,
      depth: 2,
      all: true,
      long: true,
      git: true,
    });
    await run("ast_search", { pattern: "console.log($MSG)", path: "src", lang: "ts" });
    await run("diff_files", { path_a: "a.ts", path_b: "b.ts", lang: "ts" });
    await run("codebase_stats", { path: "src", sort: "complexity", by_file: true });

    expect(calls).toEqual([
      {
        command: "bat",
        args: ["--plain", "--color=never", "--number", "--line-range", "2:8", "src/a.ts"],
        options: { cwd: tmpdir(), signal, timeout: 10_000 },
      },
      {
        command: "eza",
        args: [
          "--color=never",
          "--icons=never",
          "--tree",
          "--level",
          "2",
          "--all",
          "--long",
          "--no-permissions",
          "--no-user",
          "--git",
          ".",
        ],
        options: { cwd: tmpdir(), signal, timeout: 10_000 },
      },
      {
        command: "sg",
        args: ["run", "--pattern", "console.log($MSG)", "--color=never", "--lang", "ts", "src"],
        options: { cwd: tmpdir(), signal, timeout: 15_000 },
      },
      {
        command: "difft",
        args: ["--color=never", "--override", "*:typescript", "a.ts", "b.ts"],
        options: { cwd: tmpdir(), signal, timeout: 15_000 },
      },
      {
        command: "scc",
        args: [
          "--ci",
          "--no-cocomo",
          "--sort",
          "complexity",
          "--by-file",
          "--format",
          "csv",
          "src",
        ],
        options: { cwd: tmpdir(), signal, timeout: 15_000 },
      },
    ]);
  });

  it("supports default argv variants", async () => {
    const { calls, run } = createHarness();

    await run("read_file", { path: "README.md", start_line: 4 });
    await run("list_dir", {});
    await run("ast_search", { pattern: "return $VALUE" });
    await run("diff_files", { path_a: "a", path_b: "b" });
    await run("codebase_stats", {});

    expect(calls.map(({ command, args }) => ({ command, args }))).toEqual([
      {
        command: "bat",
        args: ["--plain", "--color=never", "--number", "--line-range", "4:", "README.md"],
      },
      { command: "eza", args: ["--color=never", "--icons=never"] },
      { command: "sg", args: ["run", "--pattern", "return $VALUE", "--color=never"] },
      { command: "difft", args: ["--color=never", "a", "b"] },
      { command: "scc", args: ["--ci", "--no-cocomo"] },
    ]);
  });

  it("routes inline and file query inputs without interpolation", async () => {
    const cwd = tempDirectory("pi-bash-tools-query-");
    writeFileSync(join(cwd, "fixture.json"), '{"name":"pi"}');
    writeFileSync(join(cwd, "fixture.yaml"), "name: pi\n");
    const { calls, run } = createHarness();

    await run("json_query", { query: ".name", input: '{"name":"pi"}', raw_output: true }, cwd);
    await run("json_query", { query: ".name", input: "fixture.json" }, cwd);
    await run("yaml_query", { query: ".name", input: "name: pi\n", output_format: "json" }, cwd);
    await run("yaml_query", { query: ".name", input: "fixture.yaml" }, cwd);

    expect(calls.map(({ command, args }) => ({ command, args }))).toEqual([
      {
        command: "sh",
        args: [
          "-c",
          'input="$1"; shift; printf "%s" "$input" | jq "$@"',
          "--",
          '{"name":"pi"}',
          "--raw-output",
          "--",
          ".name",
        ],
      },
      { command: "jq", args: ["--", ".name", "fixture.json"] },
      {
        command: "sh",
        args: [
          "-c",
          'input="$1"; shift; printf "%s" "$input" | yq "$@"',
          "--",
          "name: pi",
          "eval",
          "--no-colors",
          "--output-format",
          "json",
          "--expression",
          ".name",
        ],
      },
      {
        command: "yq",
        args: ["eval", "--no-colors", "--expression", ".name", "--", "fixture.yaml"],
      },
    ]);
  });

  it("parses gh arguments and constructs sd argv", async () => {
    const { calls, run } = createHarness();

    await run("gh", { args: "pr view 42 --json \"title,url\" --jq '[.title]'" });
    await run("find_replace", {
      find: "before",
      replace: "$1-after",
      path: "file.txt",
      literal: true,
    });

    expect(calls.map(({ command, args }) => ({ command, args }))).toEqual([
      {
        command: "gh",
        args: ["pr", "view", "42", "--json", "title,url", "--jq", "[.title]"],
      },
      {
        command: "sd",
        args: ["--string-mode", "--", "before", "$1-after", "file.txt"],
      },
    ]);
  });

  it.each([
    ["read_file", { path: "a", start_line: 0 }],
    ["read_file", { path: "a", end_line: -1 }],
    ["read_file", { path: "a", start_line: 1.5 }],
    ["read_file", { path: "a", start_line: 4, end_line: 2 }],
    ["list_dir", { tree: true, depth: 0 }],
    ["list_dir", { tree: true, depth: 1.5 }],
    ["yaml_query", { query: ".", input: "a.yaml", output_format: "invalid" }],
    ["codebase_stats", { sort: "invalid" }],
  ])("rejects invalid %s input before spawning: %j", async (name, input) => {
    const { calls, run } = createHarness();
    await expect(run(name, input)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it.each(["-file", "--help", "-"])("protects file operands: %s", async (path) => {
    const { calls, run } = createHarness();
    await run("read_file", { path });
    await run("list_dir", { path });
    await run("ast_search", { path, pattern: "return $A" });
    await run("diff_files", { path_a: path, path_b: path });
    await run("codebase_stats", { path });
    await run("json_query", { query: "-.", input: path });
    for (const call of calls) expect(call.args.at(-1)).toBe(`./${path}`);
    expect(calls[5]?.args).toEqual(["--", "-.", `./${path}`]);
  });

  it("protects existing dashed YAML paths and explicit expressions", async () => {
    const cwd = tempDirectory("pi-bash-tools-dash-");
    writeFileSync(join(cwd, "--help"), "name: pi");
    const { calls, run } = createHarness();
    await run("yaml_query", { query: "-1", input: "--help" }, cwd);
    expect(calls[0]?.args).toEqual(["eval", "--no-colors", "--expression", "-1", "--", "./--help"]);
  });

  it.each([
    [String.raw`pr view a\ b`, ["pr", "view", "a b"]],
    [String.raw`pr view "a\"b"`, ["pr", "view", 'a"b']],
    [`pr view ''`, ["pr", "view", ""]],
  ])("preserves gh tokenization: %s", async (args, expected) => {
    const { calls, run } = createHarness();
    await run("gh", { args });
    expect(calls[0]?.args).toEqual(expected);
  });

  it("rejects invalid gh input before execution", async () => {
    const { calls, run } = createHarness();

    await expect(run("gh", { args: "" })).rejects.toThrow("gh args must not be empty");
    await expect(run("gh", { args: "pr view 'unterminated" })).rejects.toThrow(
      "invalid gh args: unterminated quoted string",
    );
    await expect(run("gh", { args: "pr view \\" })).rejects.toThrow(
      "invalid gh args: unterminated escape sequence",
    );
    expect(calls).toHaveLength(0);
  });

  it("throws bounded command failures and accepts search-style exit code 1", async () => {
    const { run } = createHarness(({ command }) => {
      if (command === "jq") return result("", "bad filter", 2);
      if (command === "gh") return result("", "not found", 2);
      return result("", "no matches", 1);
    });

    await expect(run("json_query", { query: ".", input: "missing.json" })).rejects.toThrow(
      "jq -- . missing.json failed: exit 2: bad filter",
    );
    await expect(run("gh", { args: `pr view "it's"` })).rejects.toThrow(
      "gh pr view 'it'\\''s' failed: exit 2: not found",
    );
    await expect(run("ast_search", { pattern: "missing()" })).resolves.toMatchObject({
      content: [{ type: "text", text: "[stderr]\nno matches\n\n[stdout]\n(no matches)" }],
    });
    await expect(run("diff_files", { path_a: "a", path_b: "b" })).resolves.toMatchObject({
      content: [{ type: "text", text: "[stderr]\nno matches\n\n[stdout]\n(no differences)" }],
    });
  });

  it("jumps using session replacement with a getter-only cwd", async () => {
    const { dir, source } = savedSession();
    const forkFrom = SessionManager.forkFrom.bind(SessionManager);
    const fork = vi
      .spyOn(SessionManager, "forkFrom")
      .mockImplementation((path, cwd) => forkFrom(path, cwd, dir));
    const { calls, commands } = createHarness(() => result(`${dir}\n`));
    const { ctx, notify, confirm, switchSession } = createJumpContext(source);
    await commands.get("jump")!.handler("project", ctx);
    expect(confirm).toHaveBeenCalledOnce();
    expect(fork).toHaveBeenCalledWith(source, dir);
    const sessionFile = switchSession.mock.calls[0][0];
    const replacement = SessionManager.open(sessionFile);
    expect(replacement.getCwd()).toBe(dir);
    expect(replacement.getHeader()?.parentSession).toBe(source);
    expect(replacement.getEntries()).toHaveLength(1);
    expect(replacement.getEntries()).toEqual(SessionManager.open(source).getEntries());
    expect(ctx.cwd).toBe(tmpdir());
    expect(notify).toHaveBeenCalledWith(`Jumped to: ${dir}`);
    expect(calls[0]).toMatchObject({
      command: "zoxide",
      args: ["query", "--", "project"],
      options: { cwd: tmpdir(), timeout: 10000 },
    });
    await commands.get("jump")!.handler("  ", ctx);
    expect(notify).toHaveBeenCalledWith("Usage: /jump <directory query>");
  });

  it("jumps when only zoxide stderr exceeds the presentation budget", async () => {
    vi.spyOn(fsPromises, "mkdtemp").mockImplementation(async () =>
      tempDirectory("pi-jump-output-"),
    );
    const { dir, source } = savedSession();
    const forkFrom = SessionManager.forkFrom.bind(SessionManager);
    const fork = vi
      .spyOn(SessionManager, "forkFrom")
      .mockImplementation((path, cwd) => forkFrom(path, cwd, dir));
    const { commands } = createHarness(() => result(`${dir}\n`, "warning\n".repeat(3000)));
    const { ctx, confirm, switchSession } = createJumpContext(source);
    await commands.get("jump")!.handler("project", ctx);
    expect(confirm).toHaveBeenCalledOnce();
    expect(fork).toHaveBeenCalledWith(source, dir);
    expect(switchSession).toHaveBeenCalledOnce();
  });

  it.each(["x".repeat(60000), "directory\n".repeat(3000)])(
    "rejects truncated zoxide stdout (%#)",
    async (stdout) => {
      vi.spyOn(fsPromises, "mkdtemp").mockImplementation(async () =>
        tempDirectory("pi-jump-output-"),
      );
      const { source } = savedSession();
      const { commands } = createHarness(() => result(stdout));
      const { ctx, confirm, switchSession } = createJumpContext(source);
      await expect(commands.get("jump")!.handler("project", ctx)).rejects.toThrow(
        "zoxide returned an oversized directory path",
      );
      expect(confirm).not.toHaveBeenCalled();
      expect(switchSession).not.toHaveBeenCalled();
    },
  );

  it("leaves the session unchanged when zoxide finds no match", async () => {
    const { commands } = createHarness(() => result("", "not found", 1));
    const { ctx, notify, switchSession } = createJumpContext();
    await commands.get("jump")!.handler("missing", ctx);
    expect(switchSession).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('zoxide: no match for "missing"');
  });

  it("does not fork when confirmation is declined", async () => {
    const { source } = savedSession();
    const { commands } = createHarness(() => result(tmpdir()));
    const { ctx, confirm, switchSession } = createJumpContext(source);
    confirm.mockResolvedValue(false);
    const fork = vi.spyOn(SessionManager, "forkFrom");
    await commands.get("jump")!.handler("project", ctx);
    expect(fork).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
  });

  it("reports cancellation by a session lifecycle hook", async () => {
    const { dir, source } = savedSession();
    const forkFrom = SessionManager.forkFrom.bind(SessionManager);
    vi.spyOn(SessionManager, "forkFrom").mockImplementation((path, cwd) =>
      forkFrom(path, cwd, dir),
    );
    const { commands } = createHarness(() => result(tmpdir()));
    const { ctx, notify, switchSession } = createJumpContext(source);
    switchSession.mockResolvedValue({ cancelled: true });
    await commands.get("jump")!.handler("project", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Jump cancelled"));
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Jumped to:"));
  });

  it("rejects a zoxide match that is not a directory", async () => {
    const { source } = savedSession();
    const { commands } = createHarness(() => result(source));
    const { ctx, notify, switchSession } = createJumpContext(source);
    await commands.get("jump")!.handler("project", ctx);
    expect(notify).toHaveBeenCalledWith(`Not a directory: ${source}`, "error");
    expect(switchSession).not.toHaveBeenCalled();
  });

  it("handles unsaved sessions without assigning cwd", async () => {
    const { commands } = createHarness(() => result(tmpdir()));
    const { ctx, notify, switchSession } = createJumpContext();
    await commands.get("jump")!.handler("project", ctx);
    expect(switchSession).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Save a conversation"), "warning");
  });

  it.each([
    'name = "pi"',
    '# comment\nname = "pi"\ncount = 2',
    '[package]\nname = "pi"',
    '[[packages]]\nname = "pi"',
  ])("routes inline TOML with an explicit parser: %s", async (input) => {
    const { calls, run } = createHarness();
    await run("yaml_query", { query: ".name", input });
    expect(calls[0]?.command).toBe("sh");
    expect(calls[0]?.args).toContain(input);
    expect(calls[0]?.args.slice(-4)).toEqual(["--input-format", "toml", "--expression", ".name"]);
  });

  it("preserves existing TOML paths and selects the TOML parser", async () => {
    const cwd = tempDirectory("pi-bash-tools-toml-");
    writeFileSync(join(cwd, "config.toml"), 'name = "pi"');
    const { calls, run } = createHarness();
    await run("yaml_query", { query: ".name", input: "config.toml" }, cwd);
    expect(calls[0]).toMatchObject({
      command: "yq",
      args: [
        "eval",
        "--no-colors",
        "--input-format",
        "toml",
        "--expression",
        ".name",
        "--",
        "config.toml",
      ],
    });
  });

  it("treats leading dashes in replacement operands as data", async () => {
    const { calls, run } = createHarness();
    await run("find_replace", { find: "-a", replace: "--b", path: "-file" });
    expect(calls[0]?.args).toEqual(["--", "-a", "--b", "./-file"]);
  });

  it.each(["[name]", '["name"]', "[1, 2]"])(
    "keeps YAML/JSON flow sequences on the default parser: %s",
    async (input) => {
      const { calls, run } = createHarness();
      await run("yaml_query", { query: ".[0]", input });
      expect(calls[0]?.args).not.toContain("--input-format");
    },
  );
});
