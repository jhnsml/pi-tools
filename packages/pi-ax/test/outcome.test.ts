import { describe, expect, it } from "vite-plus/test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/ax.js";
import { MIN_AX_VERSION, type Operation } from "../src/types.js";

async function run(operation: Operation, stdout: string, stderr = "") {
  let tool!: ToolDefinition;
  extension({
    registerTool(value: ToolDefinition) {
      tool = value;
    },
    async exec(_command: string, args: string[]) {
      return {
        stdout: args[0] === "--version" ? MIN_AX_VERSION : stdout,
        stderr: args[0] === "--version" ? "" : stderr,
        code: 0,
        killed: false,
      };
    },
  } as unknown as ExtensionAPI);
  const result = await tool.execute(
    "outcome",
    {
      source: "https://example.com",
      operation,
      ...(["row", "table"].includes(operation) ? { selector: "table" } : {}),
      ...(operation === "row" ? { row: "title=" } : {}),
    },
    undefined,
    undefined,
    { cwd: "/tmp" } as Parameters<ToolDefinition["execute"]>[4],
  );
  const renderer = tool.renderResult!;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Parameters<typeof renderer>[2];
  const rendered = renderer(result, { expanded: false, isPartial: false }, theme, {
    isError: false,
  } as Parameters<typeof renderer>[3])
    .render(200)
    .join("\n");
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  const output = (JSON.parse(text.split("\n")[1]!) as { content: string }).content;
  return { text, output, rendered, result };
}

describe("native outcomes through the registered tool", () => {
  it.each([200, 404, 500])("reports HTTP %i without throwing", async (status) => {
    const { text, rendered } = await run(
      "fetch",
      JSON.stringify({ status, ok: status === 200, body: "response", redirected: true }),
    );
    expect(text).toContain(`HTTP ${status} · response received · redirected`);
    expect(rendered).toContain(`HTTP ${status} · response received · redirected`);
    expect(rendered.startsWith(status === 200 ? "OK" : "ACTION")).toBe(true);
  });

  it.each([
    "not json",
    "null",
    "[]",
    '{"status":999,"ok":false,"body":"x"}',
    '{"status":200,"ok":false,"body":"x"}',
    '{"status":200,"ok":true}',
  ])("preserves unfamiliar reports: %s", async (stdout) => {
    const { output, rendered } = await run("fetch", stdout);
    expect(output).toBe(stdout);
    expect(rendered).toContain("ax completed");
  });

  it("does not interpret fetched page text as a fetch report", async () => {
    const stdout = '{"status":404,"ok":false,"body":"x"}';
    expect((await run("markdown", stdout)).output).toBe(stdout);
  });

  it("surfaces upstream body and download caps before a clipped report", async () => {
    const { text, rendered } = await run(
      "fetch",
      JSON.stringify({
        status: 200,
        ok: true,
        body: "x".repeat(25_000),
        body_truncated: "hidden",
        download_capped: "stopped",
      }),
    );
    expect(text).toContain("Response body truncated by ax");
    expect(text).toContain("Download capped by ax");
    expect(rendered).toContain("diagnostics available");
  });

  it("keeps only exact routine cache notes out of model text", async () => {
    const { text, output, rendered, result } = await run(
      "markdown",
      "page",
      "ax: note: using 12s-old cached fetch (--fresh to refetch)\n",
    );
    expect(output).toBe("page");
    expect(text).not.toContain("cached fetch");
    expect(rendered).toContain("cache 12s old");
    expect(JSON.stringify(result.details)).toContain("cached fetch");
  });

  it.each(["row", "table"] as const)(
    "reports %s extraction totals without claiming returned row counts",
    async (operation) => {
      const { text, rendered } = await run(
        operation,
        "some rows",
        "ax: note: 2 tables, 50 rows extracted, no empty fields\n",
      );
      expect(text).toContain("50 rows extracted (before output limits)");
      expect(rendered).toContain("50 rows extracted (before output limits)");
      expect(text).not.toContain("[ax diagnostics]");
    },
  );

  it.each([
    "ax: note: 50 rows extracted — check: title: 2 empty",
    "ax: note: single oversized item exceeds budget",
    "ax: note: unknown charset foo",
    "ax: note: no repeating structures found — likely a JS-rendered SPA",
    "ax: note: using cache failed",
  ])("preserves correctness and unknown diagnostics: %s", async (stderr) => {
    const { text, rendered } = await run("row", "rows", stderr);
    expect(text).toContain(stderr);
    expect(rendered).toContain("diagnostics available");
  });

  it("bounds and redacts model-visible diagnostics", async () => {
    const { text, result } = await run(
      "markdown",
      "page",
      "?token=secret-value " + "x".repeat(10_000),
    );
    expect(text).not.toContain("secret-value");
    expect(JSON.stringify(result.details)).not.toContain("secret-value");
    expect(text).toContain("[Diagnostics truncated]");
    expect(text.length).toBeLessThan(4500);
  });
});
