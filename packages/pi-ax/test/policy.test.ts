import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  AxPolicyError,
  boundedSourceLabel,
  redactSensitiveText,
  safeSourceLabel,
  sanitizeUntrustedText,
  validateHeaders,
  validateSource,
} from "../src/policy.js";

const fixture = join(tmpdir(), "pi-ax-policy-fixture.html");
writeFileSync(fixture, "fixture");

describe("source policy", () => {
  it("accepts HTTP(S) and existing regular files", () => {
    expect(validateSource("https://example.com/docs?q=1", tmpdir()).kind).toBe("url");
    expect(validateSource(fixture, tmpdir()).value).toBe(fixture);
    expect(validateSource("./pi-ax-policy-fixture.html", tmpdir()).kind).toBe("file");
  });

  it("rejects directories with a specific message", () => {
    expect(() => validateSource(tmpdir(), tmpdir())).toThrow(/source is a directory, not a file/);
  });

  it("rejects non-read-only sources and metadata endpoints", () => {
    for (const source of [
      "data:text/plain,secret",
      "ftp://example.com/a",
      "http://169.254.169.254/latest/meta-data",
      "http://metadata.google.internal/",
      "http://[::ffff:169.254.169.254]/",
      "https://example.com/?token=secret",
      "https://example.com/?access_token=secret",
      "https://example.com/?client_secret=secret",
      "https://example.com/?secret_key=secret",
      "https://example.com/?oauth_token=secret",
      "https://example.com/?x-api-key=secret",
      "https://user:pass@example.com/",
      "missing-file.html",
    ]) {
      expect(() => validateSource(source, tmpdir())).toThrow(AxPolicyError);
    }
  });

  it("produces a display label without URL credentials or query data", () => {
    expect(safeSourceLabel("https://user:pass@example.com/docs?token=secret#part")).toBe(
      "https://example.com/docs",
    );
    expect(safeSourceLabel("not a url?client_secret=secret")).toBe(
      "not a url?client_secret=[redacted]",
    );
    expect(safeSourceLabel("local\u202Egnp.txt")).toBe("local<U+202E>gnp.txt");
  });

  it("does not mistake ordinary query parameter names for credentials", () => {
    for (const source of [
      "https://example.com/?monkey=banana",
      "https://example.com/?keyboard=qwerty",
      "https://example.com/?author=me",
    ]) {
      expect(validateSource(source, tmpdir()).kind).toBe("url");
    }
  });
});

describe("header and diagnostic policy", () => {
  it("allows harmless public headers and rejects credential headers", () => {
    expect(validateHeaders(["Accept: text/html", "User-Agent: pi-ax"])).toEqual([
      "Accept: text/html",
      "User-Agent: pi-ax",
    ]);
    expect(() => validateHeaders(["Authorization: Bearer secret"])).toThrow(AxPolicyError);
    expect(() => validateHeaders(["X-Api-Key: secret"])).toThrow(AxPolicyError);
    expect(() => validateHeaders(["Accept: okay\nX-Evil: yes"])).toThrow(AxPolicyError);
    expect(() => validateHeaders(["X-Unknown: value"])).toThrow(AxPolicyError);
  });

  it("visibly encodes terminal and Unicode format controls while preserving layout whitespace", () => {
    const untrusted =
      "safe\n\t\u001b[31mred\u001b]8;;https://evil.test\u0007link\u0000\u202Ertl\u2066iso\u200D";
    const sanitized = sanitizeUntrustedText(untrusted);
    expect(sanitized).toContain(
      "safe\n\t<0x1B>[31mred<0x1B>]8;;https://evil.test<0x07>link<0x00><U+202E>rtl<U+2066>iso<U+200D>",
    );
    expect(sanitized).not.toContain("\u202E");
    expect(sanitized).not.toContain("\u2066");
    expect(sanitized).not.toContain("\u200D");
    expect(
      Array.from(sanitized).filter((character) => {
        const code = character.charCodeAt(0);
        return code !== 0x09 && code !== 0x0a && (code < 0x20 || (code >= 0x7f && code <= 0x9f));
      }),
    ).toEqual([]);
  });

  it("bounds long source labels by UTF-8 bytes without exposing URL secrets", () => {
    const label = boundedSourceLabel(
      safeSourceLabel(`https://example.com/${"界".repeat(200)}?token=secret`),
      64,
    );
    expect(Buffer.byteLength(label, "utf8")).toBeLessThanOrEqual(64);
    expect(label).not.toContain("secret");
    expect(label.endsWith("…")).toBe(true);
  });

  it("redacts credential URLs, query parameters, and headers from diagnostics", () => {
    const diagnostic = [
      "https://user:pass@example.com/callback?access_token=abc&monkey=banana",
      "Authorization: Digest opaque-secret",
      "X-Api-Key: key-secret",
      "Cookie: sid=123",
      "request failed: authorization: Bearer inline-secret",
      "request failed: x-api-key: inline-key",
    ].join("\n");

    expect(redactSensitiveText(diagnostic)).toBe(
      [
        "https://[redacted]@example.com/callback?access_token=[redacted]&monkey=banana",
        "Authorization: [redacted]",
        "X-Api-Key: [redacted]",
        "Cookie: [redacted]",
        "request failed: authorization: [redacted]",
        "request failed: x-api-key: [redacted]",
      ].join("\n"),
    );
  });
});
