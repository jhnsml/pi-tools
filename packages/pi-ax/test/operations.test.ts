import { describe, expect, it } from "vite-plus/test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/ax.js";
import { MIN_AX_VERSION, type AxRequestParams, type Operation } from "../src/types.js";

// Independent compatibility expectations, not imported implementation rules.
const operations: Operation[] = [
  "fetch",
  "outline",
  "locate",
  "count",
  "row",
  "table",
  "text",
  "attr",
  "html",
  "markdown",
];
const required: Partial<Record<Operation, Partial<AxRequestParams>>> = {
  locate: { text: "release" },
  count: { selector: "a" },
  row: { selector: "a", row: "title=" },
  table: { selector: "table" },
  text: { selector: "main" },
  attr: { selector: "a", attribute: "href" },
  html: { selector: "main" },
};
const parse: Operation[] = [
  "outline",
  "locate",
  "count",
  "row",
  "table",
  "text",
  "attr",
  "html",
  "markdown",
];
const paginated: Operation[] = [
  "outline",
  "locate",
  "row",
  "table",
  "text",
  "attr",
  "html",
  "markdown",
];
const fields: Array<{
  field: keyof AxRequestParams;
  value: string | number | boolean;
  allowed: Operation[];
  required?: boolean;
}> = [
  {
    field: "selector",
    value: "a",
    allowed: ["count", "row", "table", "text", "attr", "html"],
    required: true,
  },
  { field: "text", value: "release", allowed: ["locate"], required: true },
  { field: "row", value: "title=", allowed: ["row"], required: true },
  { field: "attribute", value: "href", allowed: ["attr"], required: true },
  { field: "where", value: "title ~ /a/", allowed: ["row", "table"] },
  { field: "json", value: true, allowed: ["row", "table"] },
  { field: "jsonEnvelope", value: true, allowed: ["locate", "row", "table"] },
  { field: "fresh", value: true, allowed: parse },
  { field: "noCache", value: true, allowed: parse },
  { field: "limit", value: 10, allowed: paginated },
  { field: "offset", value: 0, allowed: paginated },
  { field: "all", value: true, allowed: ["fetch", ...paginated] },
  { field: "budget", value: 100, allowed: ["fetch", ...paginated] },
];

function harness() {
  let tool!: ToolDefinition;
  const calls: string[][] = [];
  extension({
    registerTool(value: ToolDefinition) {
      tool = value;
    },
    async exec(_command: string, args: string[]) {
      calls.push(args);
      return {
        stdout: args[0] === "--version" ? MIN_AX_VERSION : "result",
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  } as unknown as ExtensionAPI);
  const execute = (params: AxRequestParams) =>
    tool.execute("rules", params, undefined, undefined, { cwd: "/tmp" } as Parameters<
      ToolDefinition["execute"]
    >[4]);
  const schema = tool.parameters as unknown as {
    type: string;
    required?: string[];
    additionalProperties?: boolean;
    properties: Record<
      string,
      { description?: string; items?: { additionalProperties?: boolean } }
    >;
  };
  return { tool, schema, execute, calls };
}

function input(operation: Operation): AxRequestParams {
  return { source: "https://example.com", operation, ...required[operation] };
}

describe("operation compatibility through the registered tool", () => {
  it("requires a complete single request at runtime", async () => {
    const { execute, calls } = harness();
    await expect(execute({} as AxRequestParams)).rejects.toThrow(/operation is required/);
    await expect(execute({ operation: "fetch" } as AxRequestParams)).rejects.toThrow(
      /source is required/,
    );
    expect(calls).toHaveLength(0);
  });

  it("keeps a flat provider-compatible schema with a batch field", () => {
    const { schema } = harness();
    expect(schema.type).toBe("object");
    expect(schema.required).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.requests?.items?.additionalProperties).toBe(false);
    const properties = schema.properties;
    expect(Object.keys(properties).sort((a, b) => a.localeCompare(b))).toEqual(
      [
        "source",
        "operation",
        "headers",
        "timeout",
        "requests",
        ...fields.map(({ field }) => field),
      ].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("preflights unsafe argument shapes without echoing values", () => {
    const { tool } = harness();
    const prepare = tool.prepareArguments!;
    const secret = "Bearer should-never-be-echoed";

    for (const args of [
      { source: `https://example.com/?token=${secret}`, operation: "fetch", rogue: secret },
      { source: "https://example.com", operation: "fetch", requests: [] },
      { requests: [] },
      { requests: Array.from({ length: 17 }, () => input("fetch")) },
      { requests: [{ ...input("fetch"), rogue: secret }] },
      { requests: secret },
    ]) {
      let message = "";
      try {
        prepare(args);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message.length).toBeLessThan(200);
      expect(message).not.toContain(secret);
    }
  });

  for (const { field, value, allowed, required: isRequired } of fields) {
    it(`${field} advertises precisely its accepted operations`, () => {
      const { schema } = harness();
      const properties = schema.properties;
      const description = properties[field].description!;
      expect(description).toContain(
        `${isRequired ? "Required" : "Valid"} for: ${allowed.join(", ")}.`,
      );
    });

    for (const operation of operations) {
      it(`${operation}: ${allowed.includes(operation) ? "accepts" : "rejects"} ${field}`, async () => {
        const { execute, calls } = harness();
        const result = execute({ ...input(operation), [field]: value });
        if (allowed.includes(operation)) {
          await result;
          expect(calls).toHaveLength(2);
        } else {
          await expect(result).rejects.toThrow(
            `Invalid fields for operation "${operation}": ${field}`,
          );
          expect(calls).toHaveLength(0);
        }
      });
    }
  }

  for (const operation of operations) {
    for (const field of Object.keys(required[operation] ?? {}) as Array<keyof AxRequestParams>) {
      it(`${operation} requires non-empty ${field} before spawning`, async () => {
        for (const value of [undefined, "", "   "]) {
          const { execute, calls } = harness();
          await expect(execute({ ...input(operation), [field]: value })).rejects.toThrow(
            `Missing required fields: ${field}`,
          );
          expect(calls).toHaveLength(0);
        }
      });
    }
  }

  it("does not silently ignore false flags on unsupported operations", async () => {
    for (const field of ["json", "jsonEnvelope", "fresh", "noCache"] as const) {
      const { execute, calls } = harness();
      await expect(execute({ ...input("fetch"), [field]: false })).rejects.toThrow(
        `Invalid fields for operation "fetch": ${field}`,
      );
      expect(calls).toHaveLength(0);
    }
  });

  it("lists only valid recovery fields when multiple fields are wrong", async () => {
    const { execute, calls } = harness();
    await expect(
      execute({ ...input("fetch"), noCache: true, limit: 10, offset: 0, budget: 100 }),
    ).rejects.toThrow(
      'Invalid fields for operation "fetch": noCache, limit, offset. Valid fields: all, budget, headers, timeout.',
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    { fresh: true, noCache: true },
    { all: true, limit: 5 },
    { json: true, jsonEnvelope: true },
  ])("preserves mutually exclusive options: %o", async (options) => {
    const { execute, calls } = harness();
    await expect(execute({ ...input("row"), ...options })).rejects.toThrow(
      "cannot be used together",
    );
    expect(calls).toHaveLength(0);
  });
});
