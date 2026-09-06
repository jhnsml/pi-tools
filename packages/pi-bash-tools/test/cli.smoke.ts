import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";
import extension from "../extensions/bash-tools.js";

// Real processes are deliberately confined to this opt-in suite. No shell interpolation.
const exec: ExtensionAPI["exec"] = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({
        stdout,
        stderr,
        code: typeof error?.code === "number" ? error.code : 0,
        killed: error?.killed ?? false,
      });
    });
  });

type SmokeCase = {
  cli: string;
  tool: string;
  input: Record<string, unknown>;
  expected: string;
  versionMarker?: string;
};

const cases: SmokeCase[] = [
  {
    cli: "bat",
    tool: "read_file",
    input: { path: "--help.ts", start_line: 1, end_line: 1 },
    expected: "console.log",
  },
  {
    cli: "eza",
    tool: "list_dir",
    input: { path: ".", tree: true, depth: 1 },
    expected: "--help.ts",
  },
  {
    cli: "sg",
    tool: "ast_search",
    input: { path: "--help.ts", pattern: "console.log($A)", lang: "ts" },
    expected: "console.log",
    versionMarker: "ast-grep",
  },
  {
    cli: "jq",
    tool: "json_query",
    input: { input: "--help.json", query: "-.value" },
    expected: "-3",
  },
  { cli: "jq", tool: "json_query", input: { input: "3", query: "-." }, expected: "-3" },
  {
    cli: "yq",
    tool: "yaml_query",
    input: { input: "--help.yaml", query: ".value", output_format: "json" },
    expected: "3",
  },
  {
    cli: "yq",
    tool: "yaml_query",
    input: { input: "value = 3", query: ".value", output_format: "json" },
    expected: "3",
  },
  { cli: "yq", tool: "yaml_query", input: { input: "value: 3", query: "-1" }, expected: "-1" },
  {
    cli: "difft",
    tool: "diff_files",
    input: { path_a: "--help.ts", path_b: "other.ts", lang: "ts" },
    expected: "console.log",
  },
  {
    cli: "sd",
    tool: "find_replace",
    input: { path: "--help.ts", find: "-before", replace: "--after", literal: true },
    expected: "(done)",
  },
  {
    cli: "scc",
    tool: "codebase_stats",
    input: { path: "--help.ts", sort: "complexity", by_file: true },
    expected: "--help.ts",
  },
  { cli: "gh", tool: "gh", input: { args: "--version" }, expected: "gh version" },
];

it.for(cases)("$tool: $input", async ({ cli, tool, input, expected, versionMarker }, context) => {
  let version: Awaited<ReturnType<ExtensionAPI["exec"]>>;
  try {
    version = await exec(cli, ["--version"], { timeout: 5000 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      context.skip(`${cli} is not installed`);
    }
    throw error;
  }
  if (versionMarker && !`${version.stdout}\n${version.stderr}`.includes(versionMarker)) {
    context.skip(`${cli} is not the expected executable`);
  }
  const cwd = await mkdtemp(join(tmpdir(), "pi-bash-tools-smoke-"));
  try {
    await Promise.all([
      writeFile(join(cwd, "--help.ts"), 'console.log("-before");\n'),
      writeFile(join(cwd, "other.ts"), 'console.log("changed");\n'),
      writeFile(join(cwd, "--help.json"), '{"value":3}'),
      writeFile(join(cwd, "--help.yaml"), "value: 3\n"),
    ]);
    const tools = new Map<string, ToolDefinition>();
    extension({
      exec,
      registerTool(definition: ToolDefinition) {
        tools.set(definition.name, definition);
      },
      registerCommand() {},
    } as unknown as ExtensionAPI);
    const definition = tools.get(tool);
    if (!definition) throw new Error(`Tool not registered: ${tool}`);
    const output = await definition.execute("smoke", input, undefined, undefined, {
      cwd,
    } as Parameters<ToolDefinition["execute"]>[4]);
    const text = output.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(text).toContain(expected);
    if (cli === "sd") expect(await readFile(join(cwd, "--help.ts"), "utf8")).toContain("--after");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
