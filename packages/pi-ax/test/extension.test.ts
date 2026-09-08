import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  visibleWidth,
} from "@earendil-works/pi-tui";
import extension from "../extensions/ax.js";
import { MIN_AX_VERSION, type AxBatchDetails } from "../src/types.js";

const source = join(tmpdir(), "pi-ax-extension-fixture.html");
const agentDirectory = mkdtempSync(join(tmpdir(), "pi-ax-extension-agent-"));
const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDirectory;
writeFileSync(source, "fixture");

afterAll(() => {
  if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
  rmSync(agentDirectory, { recursive: true, force: true });
});

const keybindingDefinitions = {
  "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
} as const;

describe("ax extension", () => {
  let previousKeybindings: ReturnType<typeof getKeybindings>;
  beforeEach(() => {
    previousKeybindings = getKeybindings();
    setKeybindings(new KeybindingsManager(keybindingDefinitions));
  });
  afterEach(() => setKeybindings(previousKeybindings));

  it.each([false, true])("uses active expansion bindings (batch=%s)", (batch) => {
    let tool!: ToolDefinition;
    extension({
      registerTool(value: ToolDefinition) {
        tool = value;
      },
    } as ExtensionAPI);
    const theme = {
      fg: (_color: string, text: string) => text,
    } as Parameters<NonNullable<ToolDefinition["renderResult"]>>[2];
    const single = {
      operation: "fetch",
      source: "https://example.com",
      elapsedMs: 10,
      preview: "sample output",
    };
    const details = batch
      ? {
          batch: true,
          state: "complete",
          total: 1,
          started: 1,
          completed: 1,
          failed: 0,
          unfinished: 0,
          elapsedMs: 10,
          items: [{ ...single, index: 0, execution: "completed" }],
        }
      : single;
    const render = (expanded = false, isPartial = false, isError = false) =>
      tool.renderResult!(
        { details, content: [{ type: "text", text: "sample output" }] },
        { expanded, isPartial },
        theme,
        { isError } as never,
      );
    const collapsed = render();
    expect(collapsed.render(200).join("\n")).toContain("ctrl+o to expand preview");
    expect(collapsed.render(30).join("\n")).toContain("ctrl+o to expand preview");
    for (const width of [1, 10, 30, 80, 200]) {
      expect(collapsed.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(render(true).render(200).join("\n")).toContain("sample output");
    for (const component of [render(true), render(false, true), render(false, false, true)]) {
      expect(component.render(200).join("\n")).not.toContain("to expand preview");
    }
    setKeybindings(
      new KeybindingsManager(keybindingDefinitions, { "app.tools.expand": ["ctrl+e", "ctrl+y"] }),
    );
    expect(collapsed.render(200).join("\n")).toContain("ctrl+e/ctrl+y to expand preview");
    setKeybindings(new KeybindingsManager(keybindingDefinitions, { "app.tools.expand": [] }));
    expect(collapsed.render(200).join("\n")).not.toContain("to expand preview");
  });

  it("registers one native tool and delegates to pi.exec", async () => {
    let tool: ToolDefinition | undefined;
    const pi = {
      registerTool(definition: ToolDefinition) {
        tool = definition;
      },
      exec: async (command: string, args: string[], options: unknown) => {
        expect(command).toBe("ax");
        expect(options).toMatchObject({ cwd: tmpdir() });
        if (args[0] === "--version") {
          return { stdout: "0.1.23", stderr: "", code: 0, killed: false };
        }
        expect(args).toEqual([source, "--md", "--offset", "5", "--all"]);
        return { stdout: "# fixture", stderr: "", code: 0, killed: false };
      },
    } as unknown as ExtensionAPI;

    extension(pi);
    if (!tool) throw new Error("tool was not registered");
    expect(tool.name).toBe("ax");
    expect(tool.promptSnippet).toContain("ax");
    expect(tool.renderCall).toBeTypeOf("function");
    expect(tool.renderResult).toBeTypeOf("function");
    const renderCall = tool.renderCall;
    if (!renderCall) throw new Error("call renderer was not registered");
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Parameters<typeof renderCall>[1];
    const renderedCall = renderCall(
      {
        source: "https://user:pass@example.com/docs?token=secret",
        operation: "markdown",
      },
      theme,
      {} as Parameters<typeof renderCall>[2],
    )
      .render(200)
      .join("\n");
    expect(renderedCall).toContain("https://example.com/docs");
    expect(renderedCall).not.toContain("user:pass");
    expect(renderedCall).not.toContain("token=secret");

    const malformedCall = renderCall(
      { source: "not a url?client_secret=secret", operation: "fetch" },
      theme,
      {} as Parameters<typeof renderCall>[2],
    )
      .render(200)
      .join("\n");
    expect(malformedCall).toContain("client_secret=[redacted]");
    expect(malformedCall).not.toContain("client_secret=secret");

    const result = await tool.execute(
      "call-1",
      { source, operation: "markdown", offset: 5, all: true },
      undefined,
      undefined,
      { cwd: tmpdir() } as Parameters<ToolDefinition["execute"]>[4],
    );
    const modelText = result.content
      .map((item) => (item.type === "text" ? item.text : ""))
      .join("\n");
    const records = modelText.split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({
      type: "ax_result",
      trust: "trusted",
      operation: "markdown",
      execution: "completed",
    });
    expect(records[1]).toEqual({
      type: "ax_output",
      trust: "untrusted",
      content: "# fixture",
    });

    const renderResult = tool.renderResult;
    if (!renderResult) throw new Error("result renderer was not registered");
    const renderOptions = { expanded: false, isPartial: false } as Parameters<
      typeof renderResult
    >[1];
    const renderContext = { isError: false } as Parameters<typeof renderResult>[3];
    const collapsed = renderResult(result, renderOptions, theme, renderContext)
      .render(200)
      .join("\n");
    expect(collapsed).toContain("ax completed");

    const expanded = renderResult(
      {
        ...result,
        details: {
          ...(result.details as object),
          truncated: true,
          stderr: "cache warning",
          fullOutputPath: "/tmp/pi-ax-output.txt",
        },
      },
      { ...renderOptions, expanded: true },
      theme,
      renderContext,
    )
      .render(200)
      .join("\n");
    expect(expanded).toContain("# fixture");
    expect(expanded).toContain("cache warning");
    expect(expanded).toContain("/tmp/pi-ax-output.txt");

    const partial = renderResult(
      result,
      { ...renderOptions, isPartial: true },
      theme,
      renderContext,
    )
      .render(200)
      .join("\n");
    expect(partial).toContain("RUNNING · fetching");

    const failed = renderResult(
      { content: [{ type: "text", text: "ax failed safely" }], details: undefined },
      renderOptions,
      theme,
      { isError: true } as Parameters<typeof renderResult>[3],
    )
      .render(200)
      .join("\n");
    expect(failed).toContain("ax failed safely");
  });

  it("renders batch calls and mixed batch results", async () => {
    let tool: ToolDefinition | undefined;
    const pi = {
      registerTool(definition: ToolDefinition) {
        tool = definition;
      },
      exec: async (_command: string, args: string[]) => {
        if (args[0] === "--version") {
          return { stdout: "0.1.23", stderr: "", code: 0, killed: false };
        }
        if (args[0]?.endsWith("/failed")) {
          return { stdout: "", stderr: "bad selector", code: 1, killed: false };
        }
        if (args[0]?.endsWith("/clipped")) {
          return {
            stdout: JSON.stringify({
              status: 200,
              ok: true,
              body: "x".repeat(10_000),
            }),
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        if (args[0]?.endsWith("/inspect")) {
          return {
            stdout: Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"),
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        if (args[0]?.endsWith("/missing")) {
          return {
            stdout: JSON.stringify({ status: 404, ok: false, body: "not found" }),
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        return { stdout: args[0] ?? "", stderr: "", code: 0, killed: false };
      },
    } as unknown as ExtensionAPI;
    extension(pi);
    if (!tool) throw new Error("tool was not registered");
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Parameters<NonNullable<ToolDefinition["renderCall"]>>[1];
    const params = {
      requests: [
        { source: "https://example.com/ok", operation: "fetch" as const },
        { source: "https://example.com/failed", operation: "fetch" as const },
        { source: "https://example.com/missing", operation: "fetch" as const },
        { source: "https://example.com/clipped", operation: "fetch" as const },
        {
          source: "https://example.com/inspect",
          operation: "row" as const,
          selector: ".item",
          row: "title=",
          jsonEnvelope: true,
        },
      ],
    };
    const call = tool.renderCall!(params, theme, {} as never)
      .render(200)
      .join("\n");
    expect(call).toContain("batch · 5 requests");
    expect(call).toContain("fetch×4");
    expect(call).toContain("row×1");

    const result = await tool.execute("batch", params, undefined, undefined, {
      cwd: tmpdir(),
    } as Parameters<ToolDefinition["execute"]>[4]);
    const context = { isError: false } as Parameters<
      NonNullable<ToolDefinition["renderResult"]>
    >[3];
    const collapsed = tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      theme,
      context,
    )
      .render(200)
      .join("\n");
    expect(collapsed).toContain("ACTION · 5/5 started · 4 completed · 1 failed");
    expect(collapsed).toContain("1 HTTP/diagnostic review");
    expect(collapsed).toContain("2 follow-up");
    expect(collapsed).toContain("#0 OK");
    expect(collapsed).toContain("#1 ERROR");
    expect(collapsed).toContain("#2 REVIEW");
    expect(collapsed).toContain("#3 READ");
    expect(collapsed).toContain("HTTP 200 · response received · read saved output first");
    expect(collapsed).toContain("#4 REVIEW");
    const narrow = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, context)
      .render(24)
      .join("\n");
    for (let index = 0; index < 5; index += 1) {
      expect(narrow).toContain(`#${index} `);
    }
    const expanded = tool.renderResult!(
      result,
      { expanded: true, isPartial: false },
      theme,
      context,
    )
      .render(500)
      .join("\n");
    expect(expanded).toContain("#0 OK");
    expect(expanded).toContain("#1 ERROR");
    expect(expanded).toContain("#2 REVIEW");
    expect(expanded).toContain("HTTP 404");
    expect(expanded).toContain("#3 READ");
    expect(expanded).toContain("Saved #3");
    expect(expanded).toContain("Next #4");
    const details = result.details as AxBatchDetails;
    expect(details.items[3]?.continuation?.action).toBe("read_saved_output");
    expect(details.items[4]?.continuation?.action).toBe("inspect");
  });

  it.each([false, true])("renders persisted legacy results (expanded=%s)", (expanded) => {
    let tool!: ToolDefinition;
    extension({
      registerTool(value: ToolDefinition) {
        tool = value;
      },
    } as ExtensionAPI);
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Parameters<NonNullable<ToolDefinition["renderResult"]>>[2];
    const render = (details: unknown, text = "legacy output") =>
      tool.renderResult!(
        { details, content: [{ type: "text", text }] },
        { expanded, isPartial: false },
        theme,
        { isError: false } as never,
      )
        .render(500)
        .join("\n");
    const single = {
      operation: "row",
      source: "https://example.com",
      elapsedMs: 10,
      outcome: { summary: "HTTP 404", attention: true, notes: "legacy diagnostic" },
      continuation: { action: "continue", summary: "more rows", message: "use offset 7" },
      fullOutputPath: "/tmp/legacy-output.txt",
    };
    const renderedSingle = render(single);
    expect(renderedSingle).toContain("ACTION · HTTP 404");
    expect(renderedSingle).toContain("more rows");
    if (expanded) {
      expect(renderedSingle).toContain("legacy output");
      expect(renderedSingle).toContain("use offset 7");
      expect(render(single, "")).not.toContain("undefined");
      expect(render({ ...single, stdoutPreview: "saved preview" })).toContain("saved preview");
    }
    const details = {
      batch: true,
      total: 4,
      completed: 2,
      succeeded: 1,
      failed: 1,
      unfinished: 2,
      elapsedMs: 20,
      deadlineMs: 100,
      items: [
        {
          index: 0,
          source: single.source,
          status: "success",
          result: {
            details: single,
            content: [{ type: "text", text: "nested output" }],
          },
        },
        { index: 1, source: single.source, status: "error", error: "legacy failure" },
        { index: 2, source: single.source, status: "cancelled" },
        { index: 3, source: single.source, status: "not_started" },
      ],
    };
    const before = JSON.stringify(details);
    const batch = render(details);
    expect(batch).toContain("3/4 started · 1 completed · 1 failed · 2 unfinished");
    expect(batch).toContain("1 HTTP/diagnostic review · 1 follow-up");
    expect(batch).toContain("#0 MORE");
    expect(batch).toContain("HTTP 404 · more rows");
    expect(batch).toContain("#1 ERROR");
    expect(batch).toContain("legacy failure");
    expect(batch).toContain("#2 CANCELLED");
    expect(batch).toContain("#3 NOT STARTED");
    expect(batch).not.toContain("undefined");
    if (expanded) {
      expect(batch).toContain("nested output");
      expect(batch).toContain("legacy diagnostic");
      expect(batch).toContain("use offset 7");
      expect(batch).toContain("/tmp/legacy-output.txt");
    }
    expect(JSON.stringify(details)).toBe(before);
  });

  it("renders untrusted terminal controls visibly without emitting raw control sequences", async () => {
    let tool!: ToolDefinition;
    extension({
      registerTool(value: ToolDefinition) {
        tool = value;
      },
      async exec(_command: string, args: string[]) {
        return args[0] === "--version"
          ? { stdout: MIN_AX_VERSION, stderr: "", code: 0, killed: false }
          : {
              stdout: "safe\u001b[31mred\u001b]8;;https://evil.test\u0007link\u202Espoof",
              stderr: "ax: note: alert\u001b[2J\u2066",
              code: 0,
              killed: false,
            };
      },
    } as unknown as ExtensionAPI);
    const result = await tool.execute(
      "controls",
      { source: "https://example.com/controls", operation: "fetch" },
      undefined,
      undefined,
      { cwd: tmpdir() } as Parameters<ToolDefinition["execute"]>[4],
    );
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Parameters<NonNullable<ToolDefinition["renderResult"]>>[2];
    const rendered = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, {
      isError: false,
    } as never)
      .render(80)
      .join("\n");
    expect(rendered).toContain("<0x1B>[31mred");
    expect(rendered).toContain("<0x1B>]8;;https://evil.test<0x07>link");
    expect(rendered).toContain("<U+202E>spoof");
    expect(rendered).toContain("alert<0x1B>[2J<U+2066>");
    expect(
      Array.from(rendered).filter((character) => {
        const code = character.charCodeAt(0);
        return code !== 0x09 && code !== 0x0a && (code < 0x20 || (code >= 0x7f && code <= 0x9f));
      }),
    ).toEqual([]);
  });
});
