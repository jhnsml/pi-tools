import { isIP } from "node:net";
import { resolve } from "node:path";
import { statSync } from "node:fs";

const FORBIDDEN_HEADER =
  /(?:authorization|cookie|proxy-authorization|set-cookie|api[-_]?key|token|secret|credential|password)/i;
const SAFE_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "user-agent",
]);
const SENSITIVE_QUERY_KEYS = new Set([
  "apikey",
  "auth",
  "authorization",
  "clientsecret",
  "credential",
  "credentials",
  "key",
  "oauthtoken",
  "password",
  "passwd",
  "refreshtoken",
  "secret",
  "secretkey",
  "sessiontoken",
  "signature",
  "sig",
  "token",
  "accesstoken",
  "xapikey",
  "xauthtoken",
]);
const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "100.100.100.200",
  "metadata.google.internal",
  "metadata.goog",
]);

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isSensitiveQueryKey(key: string): boolean {
  return SENSITIVE_QUERY_KEYS.has(key.toLowerCase().replace(/[-_.]/g, ""));
}

export class AxPolicyError extends Error {
  readonly code = "AX_POLICY";
}

export type ValidatedSource = {
  value: string;
  safeLabel: string;
  kind: "url" | "file";
};

function isMetadataHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (METADATA_HOSTS.has(host)) return true;

  const ipVersion = isIP(host);
  if (ipVersion === 4) return METADATA_HOSTS.has(host);
  if (ipVersion === 6) {
    const dotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
    if (dotted && METADATA_HOSTS.has(dotted)) return true;

    const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (!hex) return false;
    const packed = `${hex[1].padStart(4, "0")}${hex[2].padStart(4, "0")}`;
    const mapped = [0, 2, 4, 6]
      .map((offset) => Number.parseInt(packed.slice(offset, offset + 2), 16))
      .join(".");
    return METADATA_HOSTS.has(mapped);
  }
  return false;
}

const UNICODE_FORMAT_CONTROL = /\p{Cf}/u;

export function sanitizeUntrustedText(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let output = "";
  for (const character of normalized) {
    const code = character.codePointAt(0)!;
    const allowedWhitespace = code === 0x09 || code === 0x0a;
    if (!allowedWhitespace && (code < 0x20 || (code >= 0x7f && code <= 0x9f))) {
      output += `<0x${code.toString(16).toUpperCase().padStart(2, "0")}>`;
    } else if (UNICODE_FORMAT_CONTROL.test(character)) {
      output += `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`;
    } else {
      output += character;
    }
  }
  return output;
}

export function safeSourceLabel(source: string): string {
  try {
    const url = new URL(source);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return sanitizeUntrustedText(`${url.origin}${url.pathname || "/"}`);
    }
  } catch {
    // Local paths and partial tool-call input are displayed without URL parsing.
  }
  return sanitizeUntrustedText(redactSensitiveText(source));
}

export function boundedSourceLabel(source: string, maxBytes: number): string {
  const label = safeSourceLabel(source).replace(/\s+/g, " ").trim();
  if (Buffer.byteLength(label, "utf8") <= maxBytes) return label;

  const suffix = "…";
  const available = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let output = "";
  let bytes = 0;
  for (const character of label) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > available) break;
    output += character;
    bytes += size;
  }
  return `${output}${suffix}`;
}

function validateUrl(source: string): ValidatedSource | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AxPolicyError("source must be an HTTP(S) URL or an existing regular local file");
  }
  if (url.username || url.password || isMetadataHost(url.hostname)) {
    throw new AxPolicyError("source URL is not permitted by the read-only source policy");
  }
  for (const key of url.searchParams.keys()) {
    if (isSensitiveQueryKey(key)) {
      throw new AxPolicyError("credential-bearing source URLs are not permitted");
    }
  }

  return {
    value: url.toString(),
    safeLabel: safeSourceLabel(url.toString()),
    kind: "url",
  };
}

export function validateSource(source: string, cwd: string): ValidatedSource {
  if (!source || source === "-") {
    throw new AxPolicyError("source must be an HTTP(S) URL or an existing regular local file");
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(source)) {
    const urlSource = validateUrl(source);
    if (!urlSource) {
      throw new AxPolicyError("source must be an HTTP(S) URL or an existing regular local file");
    }
    return urlSource;
  }

  const filePath = resolve(cwd, source);
  try {
    const stats = statSync(filePath);
    if (stats.isDirectory()) {
      throw new AxPolicyError(
        "source is a directory, not a file; pass a specific file path or an HTTP(S) URL",
      );
    }
    if (!stats.isFile()) {
      throw new AxPolicyError("source must be an existing regular local file");
    }
  } catch (error) {
    if (error instanceof AxPolicyError) throw error;
    throw new AxPolicyError("source must be an existing regular local file");
  }
  return { value: filePath, safeLabel: filePath, kind: "file" };
}

export function validateHeaders(headers: string[] | undefined): string[] {
  if (!headers) return [];
  return headers.map((header) => {
    const separator = header.indexOf(":");
    if (separator <= 0 || hasControlCharacters(header)) {
      throw new AxPolicyError("headers must use the form 'Name: value' without control characters");
    }
    const name = header.slice(0, separator).trim();
    const value = header.slice(separator + 1).trim();
    if (
      !SAFE_HEADERS.has(name.toLowerCase()) ||
      FORBIDDEN_HEADER.test(name) ||
      hasControlCharacters(value)
    ) {
      throw new AxPolicyError("the requested header is not permitted by the safe read-only policy");
    }
    return `${name}: ${value}`;
  });
}

/** Remove common credential forms before diagnostics are exposed to the model. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/([?&])([^=&#\s]+)=([^&\s#]*)/g, (match, separator, key) =>
      isSensitiveQueryKey(key) ? `${separator}${key}=[redacted]` : match,
    )
    .replace(
      /((?:authorization|cookie|proxy-authorization|set-cookie|x-api-key|api-key|x-auth-token)\s*:\s*)[^\r\n]*/gi,
      "$1[redacted]",
    );
}
