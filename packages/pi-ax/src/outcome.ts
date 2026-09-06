import { truncateHead } from "@earendil-works/pi-coding-agent";
import { redactSensitiveText, sanitizeUntrustedText } from "./policy.js";
import { MAX_STDERR_BYTES, MAX_STDERR_LINES, type AxOutcome, type Operation } from "./types.js";

/** Interpret only known ax reports, never page content or guessed line counts. */
export function interpretOutcome(operation: Operation, stdout: string, stderr: string): AxOutcome {
  let summary = "ax completed";
  let attention = false;
  const notes: string[] = [];
  let cache: string | undefined;

  if (operation === "fetch") {
    try {
      const report = JSON.parse(stdout);
      if (
        report &&
        !Array.isArray(report) &&
        Number.isInteger(report.status) &&
        report.status >= 100 &&
        report.status <= 599 &&
        typeof report.ok === "boolean" &&
        report.ok === (report.status >= 200 && report.status < 300) &&
        Object.hasOwn(report, "body")
      ) {
        summary = `HTTP ${report.status} · response received`;
        if (report.redirected === true) summary += " · redirected";
        attention = !report.ok;
        if (report.body_truncated)
          notes.push("Response body truncated by ax; received body is incomplete.");
        if (report.download_capped)
          notes.push("Download capped by ax; received body is incomplete.");
      }
    } catch {
      // Preserve unfamiliar output verbatim rather than inventing an outcome.
    }
  }

  for (const line of stderr.split(/\r?\n/).filter(Boolean)) {
    const cached = /^ax: note: using (\d{1,15})s-old cached fetch \(--fresh to refetch\)$/.exec(
      line,
    );
    if (cached) {
      cache = `cache ${cached[1]}s old`;
      continue;
    }
    const rows =
      /^ax: note: (?:\d{1,15} tables, )?(\d{1,15}) rows extracted(?:, no empty fields| — check: .+)$/.exec(
        line,
      );
    if ((operation === "row" || operation === "table") && rows) {
      summary = `${rows[1]} rows extracted (before output limits)`;
      if (line.endsWith(", no empty fields")) continue;
    }
    // Unknown diagnostics stay visible. Do not broadly suppress "note" lines:
    // they also carry data-loss, charset, missing-field, and SPA warnings.
    notes.push(line);
  }

  const bounded = truncateHead(sanitizeUntrustedText(redactSensitiveText(notes.join("\n"))), {
    maxBytes: MAX_STDERR_BYTES,
    maxLines: MAX_STDERR_LINES,
  });
  return {
    summary,
    attention: attention || notes.length > 0,
    ...(bounded.content || bounded.truncated
      ? { notes: bounded.content + (bounded.truncated ? "\n[Diagnostics truncated]" : "") }
      : {}),
    ...(cache ? { cache } : {}),
  };
}
