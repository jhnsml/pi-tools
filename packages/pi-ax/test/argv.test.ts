import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { buildAxRequest } from "../src/argv.js";

const cwd = tmpdir();
const fixture = join(tmpdir(), "pi-ax-argv-fixture.html");
writeFileSync(fixture, "<p>fixture</p>");

describe("buildAxRequest", () => {
  it("maps every operation without shell interpolation", () => {
    const cases = [
      [
        { source: "https://example.com/docs", operation: "fetch" as const },
        ["https://example.com/docs"],
      ],
      [{ source: fixture, operation: "outline" as const }, [fixture, "--outline"]],
      [
        { source: fixture, operation: "locate" as const, text: "a; rm -rf /" },
        [fixture, "--locate", "a; rm -rf /"],
      ],
      [
        { source: fixture, operation: "count" as const, selector: ".item" },
        [fixture, ".item", "--count"],
      ],
      [
        {
          source: fixture,
          operation: "row" as const,
          selector: ".item",
          row: "title=a, href=a@href",
        },
        [fixture, ".item", "--row", "title=a, href=a@href"],
      ],
      [
        { source: fixture, operation: "table" as const, selector: "table" },
        [fixture, "table", "--table"],
      ],
      [
        { source: fixture, operation: "text" as const, selector: "main" },
        [fixture, "main", "--text"],
      ],
      [
        { source: fixture, operation: "attr" as const, selector: "a", attribute: "href" },
        [fixture, "a", "--attr", "href"],
      ],
      [
        { source: fixture, operation: "html" as const, selector: "main" },
        [fixture, "main", "--html"],
      ],
      [
        { source: fixture, operation: "markdown" as const, budget: 80 },
        [fixture, "--md", "--budget", "80"],
      ],
    ] as const;

    for (const [params, expected] of cases) {
      expect(buildAxRequest(params, cwd).argv).toEqual(expected);
    }
  });

  it.each([
    ["https://nextjs.org/docs/llms.txt", { budget: 800 }, ["--budget", "800"]],
    ["https://tanstack.com/", { all: true }, ["--all"]],
    ["https://react.dev/", { all: false }, []],
    ["https://react.dev/", { budget: 500, all: true }, ["--budget", "500", "--all"]],
  ] as const)("maps fetch body controls for %s", (source, controls, flags) => {
    expect(buildAxRequest({ source, operation: "fetch", ...controls }, cwd).argv).toEqual([
      source,
      ...flags,
    ]);
  });

  it.each([0, -1, 1.5])("rejects invalid fetch budget %s", (budget) => {
    expect(() =>
      buildAxRequest(
        { source: "https://nextjs.org/docs/llms.txt", operation: "fetch", budget },
        cwd,
      ),
    ).toThrow("budget must be a positive integer");
  });

  it("maps safe headers and extraction flags as separate argv values", () => {
    expect(
      buildAxRequest(
        {
          source: fixture,
          operation: "table",
          selector: "table[data-x=';']",
          headers: ["Accept: text/html"],
          where: "Stars > 3 && name ~ /foo/",
          offset: 25,
          all: true,
          json: true,
        },
        cwd,
      ).argv,
    ).toEqual([
      fixture,
      "table[data-x=';']",
      "--table",
      "-H",
      "Accept: text/html",
      "--where",
      "Stars > 3 && name ~ /foo/",
      "--offset",
      "25",
      "--all",
      "--json",
    ]);
  });

  it("maps pagination and JSON envelopes for supported parse operations", () => {
    expect(
      buildAxRequest(
        {
          source: fixture,
          operation: "locate",
          text: "release",
          limit: 10,
          offset: 20,
          jsonEnvelope: true,
        },
        cwd,
      ).argv,
    ).toEqual([
      fixture,
      "--locate",
      "release",
      "--limit",
      "10",
      "--offset",
      "20",
      "--json-envelope",
    ]);

    expect(
      buildAxRequest(
        { source: fixture, operation: "attr", selector: "a", attribute: "href", all: true },
        cwd,
      ).argv,
    ).toEqual([fixture, "a", "--attr", "href", "--all"]);

    expect(
      buildAxRequest({ source: fixture, operation: "markdown", offset: 5, all: true }, cwd).argv,
    ).toEqual([fixture, "--md", "--offset", "5", "--all"]);
  });

  it("labels URL sources without query strings", () => {
    const request = buildAxRequest(
      { source: "https://example.com/docs?page=2", operation: "fetch" },
      cwd,
    );
    expect(request.safeSource).toBe("https://example.com/docs");
    expect(request.argv[0]).toBe("https://example.com/docs?page=2");
  });

  it("rejects fetch on local files with an actionable message", () => {
    expect(() => buildAxRequest({ source: fixture, operation: "fetch" }, cwd)).toThrow(
      /fetch requires an HTTP\(S\) URL.*markdown/,
    );
  });

  it("aggregates multiple invalid fields for fetch in one error", () => {
    expect(() =>
      buildAxRequest(
        { source: fixture, operation: "fetch", limit: 10, noCache: true, timeout: 20000 },
        cwd,
      ),
    ).toThrow(/Invalid fields for operation "fetch": noCache, limit/);
  });

  it("suggests a corrected payload for fetch with parse fields", () => {
    expect(() =>
      buildAxRequest(
        { source: fixture, operation: "fetch", budget: 1200, noCache: true, timeout: 20000 },
        cwd,
      ),
    ).toThrow(/Valid fields:.*timeout/);
  });

  it("rejects pagination and envelope fields where ax ignores or cannot use them", () => {
    expect(() =>
      buildAxRequest({ source: fixture, operation: "count", selector: "a", offset: 1 }, cwd),
    ).toThrow(/Invalid fields for operation "count": offset/);
    expect(() =>
      buildAxRequest(
        { source: fixture, operation: "text", selector: "a", jsonEnvelope: true },
        cwd,
      ),
    ).toThrow(/Invalid fields for operation "text": jsonEnvelope/);
    expect(() =>
      buildAxRequest(
        {
          source: fixture,
          operation: "row",
          selector: "a",
          row: "title=",
          json: true,
          jsonEnvelope: true,
        },
        cwd,
      ),
    ).toThrow(/json and jsonEnvelope cannot be used together/);
    expect(() =>
      buildAxRequest({ source: fixture, operation: "markdown", offset: -1 }, cwd),
    ).toThrow(/offset must be a non-negative integer/);
  });

  it("includes valid fields for row when row expression is missing", () => {
    expect(() => buildAxRequest({ source: fixture, operation: "row", selector: "a" }, cwd)).toThrow(
      /Missing required fields: row/,
    );
    expect(() => buildAxRequest({ source: fixture, operation: "row", selector: "a" }, cwd)).toThrow(
      /Valid fields:.*selector.*row/,
    );
  });

  it("rejects missing and irrelevant operation fields", () => {
    expect(() => buildAxRequest({ source: fixture, operation: "locate" }, cwd)).toThrow(
      /Missing required fields: text/,
    );
    expect(() => buildAxRequest({ source: fixture, operation: "count" }, cwd)).toThrow(
      /Missing required fields: selector/,
    );
    expect(() =>
      buildAxRequest({ source: fixture, operation: "fetch", selector: ".x" }, cwd),
    ).toThrow(/Invalid fields for operation "fetch": selector/);
    expect(() =>
      buildAxRequest({ source: fixture, operation: "attr", selector: ".x" }, cwd),
    ).toThrow(/Missing required fields: attribute/);
    expect(() =>
      buildAxRequest({ source: fixture, operation: "markdown", selector: ".x" }, cwd),
    ).toThrow(/Invalid fields for operation "markdown": selector/);
    expect(() =>
      buildAxRequest(
        { source: fixture, operation: "table", selector: "table", all: true, limit: 1 },
        cwd,
      ),
    ).toThrow(/all and limit/);
    expect(() =>
      buildAxRequest({ source: fixture, operation: "markdown", fresh: true, noCache: true }, cwd),
    ).toThrow(/fresh and noCache/);
  });
});
