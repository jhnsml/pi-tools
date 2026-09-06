import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/ax.js";
import { MAX_OUTPUT_BYTES, MIN_AX_VERSION, type AxDetails, type AxParams } from "../src/types.js";

const spills: string[] = [];
afterEach(() => {
  for (const path of spills.splice(0)) rmSync(dirname(path), { recursive: true });
});

const more = { state: "more", total: 3, offset: 0, returned: 1, next_offset: 1 };
function envelope(meta: object = more, data: unknown[] = [{ title: "one" }]) {
  return JSON.stringify({ data, meta });
}

async function run(stdout: string, params: Partial<AxParams> = {}) {
  let tool!: ToolDefinition;
  const calls: string[][] = [];
  extension({
    registerTool(value: ToolDefinition) {
      tool = value;
    },
    async exec(_command: string, args: string[]) {
      calls.push(args);
      return {
        stdout: args[0] === "--version" ? MIN_AX_VERSION : stdout,
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  } as unknown as ExtensionAPI);
  const result = await tool.execute(
    "continuation",
    {
      source: "https://example.com",
      operation: "row",
      selector: ".item",
      row: "title=",
      jsonEnvelope: true,
      ...params,
    },
    undefined,
    undefined,
    { cwd: "/tmp" } as Parameters<ToolDefinition["execute"]>[4],
  );
  const details = result.details as AxDetails;
  if (details.fullOutputPath) spills.push(details.fullOutputPath);
  const renderer = tool.renderResult!;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Parameters<typeof renderer>[2];
  const rendered = renderer(result, { expanded: false, isPartial: false }, theme, {
    isError: false,
  } as Parameters<typeof renderer>[3])
    .render(300)
    .join("\n");
  return {
    text: result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
    details,
    rendered,
    calls,
  };
}

describe("continuation through the registered tool", () => {
  it("shows the exact next offset without fetching another page", async () => {
    const { text, details, rendered, calls } = await run(envelope());
    expect(text).toContain("offset=1; keep other parameters unchanged");
    expect(rendered).toContain("next offset 1");
    expect(details.continuation?.action).toBe("continue");
    expect(details.pagination?.nextOffset).toBe(1);
    expect(calls).toHaveLength(2); // version probe + one extraction
    expect(calls[1]).toContain("--json-envelope");
  });

  it.each([
    { state: "complete", total: 1, offset: 0, returned: 1, next_offset: null },
    { state: "complete", total: 0, offset: 0, returned: 0, next_offset: null },
    { state: "complete", total: 3, offset: 2, returned: 1, next_offset: null },
    { state: "past_end", total: 1, offset: 1, returned: 0, next_offset: null },
    { state: "past_end", total: 0, offset: 5, returned: 0, next_offset: null },
  ])("stops on $state at offset $offset with total $total", async (meta) => {
    const { text, details, rendered } = await run(envelope(meta, meta.returned ? [{}] : []), {
      offset: meta.offset,
    });
    expect(details.continuation?.action).toBe("stop");
    expect(text).toContain("Stop pagination");
    expect(rendered).toContain("stop");
    expect(rendered).not.toContain("next offset");
  });

  it.each(["more", "complete"])(
    "prioritizes saved output even when the page state is %s",
    async (state) => {
      const meta = state === "more" ? more : { ...more, state, total: 1, next_offset: null };
      const stdout = envelope(meta, [
        { title: "?token=secret " + "x".repeat(MAX_OUTPUT_BYTES + 100) },
      ]);
      const { text, details, rendered, calls } = await run(stdout);
      expect(details.truncated).toBe(true);
      expect(details.pagination?.state).toBe(state);
      expect(details.continuation?.action).toBe("read_saved_output");
      expect(rendered).toContain("read saved output first");
      expect(rendered).not.toContain("next offset");
      expect(text).toContain("before requesting another page");
      expect(text).toContain("After reading the saved output:");
      expect(text).toContain(state === "more" ? "offset=1" : "Stop pagination");
      const saved = readFileSync(details.fullOutputPath!, "utf8");
      expect(saved).toContain("[redacted]");
      expect(saved).not.toContain("token=secret");
      expect(JSON.parse(saved).data).toHaveLength(1);
      expect(text).toContain(details.fullOutputPath!);
      expect(calls).toHaveLength(2);
    },
  );

  it("handles line-limited previews without losing page state", async () => {
    const data = Array.from({ length: 700 }, () => ({}));
    const stdout = JSON.stringify(
      {
        data,
        meta: { state: "complete", total: 700, offset: 0, returned: 700, next_offset: null },
      },
      null,
      2,
    );
    // Empty objects only occupy one line: insert harmless JSON whitespace.
    const { details } = await run(stdout.replaceAll("{}", "{\n\n}"));
    expect(details.truncated).toBe(true);
    expect(details.continuation?.action).toBe("read_saved_output");
    expect(details.pagination?.state).toBe("complete");
  });

  it("counts multi-table envelope items as tables, not nested rows", async () => {
    const { details } = await run(
      envelope(more, [{ headers: ["title"], rows: [{ title: "a" }, { title: "b" }] }]),
      { operation: "table", row: undefined },
    );
    expect(details.pagination?.returned).toBe(1);
    expect(details.continuation?.action).toBe("continue");
  });

  it.each([
    "not JSON",
    "null",
    "{}",
    JSON.stringify({ meta: more }),
    envelope({ ...more, total: -1 }),
    envelope({ ...more, returned: 0 }),
    envelope({ ...more, returned: 1.5 }),
    envelope({ ...more, offset: 2 }),
    envelope({ ...more, next_offset: 0 }),
    envelope({ ...more, next_offset: null }),
    envelope({ ...more, state: "unknown" }),
    envelope({ ...more, total: 1 }),
    envelope({ ...more, state: "complete", next_offset: null }),
    envelope({ ...more, state: "past_end", next_offset: null }),
    envelope({ ...more, total: Number.MAX_SAFE_INTEGER + 1 }),
  ])("does not guess from invalid metadata: %s", async (stdout) => {
    const { text, details, rendered } = await run(stdout);
    expect(details.pagination).toBeUndefined();
    expect(details.continuation?.action).toBe("inspect");
    expect(text).toContain("do not guess an offset or assume completion");
    expect(rendered).toContain("continuation unavailable");
    expect(rendered).not.toContain("next offset");
  });

  it("still prioritizes a saved page when its metadata is invalid", async () => {
    const { details, text } = await run("x".repeat(MAX_OUTPUT_BYTES + 1));
    expect(details.continuation?.action).toBe("read_saved_output");
    expect(text).toContain(
      "After reading the saved output: Continuation metadata is missing or inconsistent",
    );
  });

  it("does not opt into envelopes or infer completion for ordinary results", async () => {
    const { text, details, calls } = await run("title\none", { jsonEnvelope: false });
    const output = JSON.parse(text.split("\n")[1]!) as { content: string };
    expect(output.content).toBe("title\none");
    expect(details.continuation).toBeUndefined();
    expect(calls[1]).not.toContain("--json-envelope");
  });

  it("recovers a clipped ordinary result without inventing page state", async () => {
    const { text, details } = await run("x".repeat(MAX_OUTPUT_BYTES + 1), { jsonEnvelope: false });
    expect(details.continuation?.action).toBe("read_saved_output");
    expect(details.pagination).toBeUndefined();
    expect(text).not.toContain("After reading the saved output:");
    expect(text).not.toContain("Stop pagination");
  });
});
