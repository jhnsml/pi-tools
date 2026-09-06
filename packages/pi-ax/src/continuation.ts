import type { AxContinuation, AxPaginationDetails, AxRequestParams } from "./types.js";

function nonNegativeInteger(value: unknown): value is number {
  // SAFETY: Number.isSafeInteger established that value is a safe number.
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Validate ax's item-based envelope; multi-table items are tables, not rows. */
function readPagination(stdout: string, requestedOffset: number): AxPaginationDetails | undefined {
  try {
    const value = JSON.parse(stdout);
    const meta = value?.meta;
    if (!Array.isArray(value?.data) || !meta) return undefined;
    const { state, total, offset, returned, next_offset: nextOffset } = meta;
    if (
      !nonNegativeInteger(total) ||
      !nonNegativeInteger(offset) ||
      !nonNegativeInteger(returned) ||
      offset !== requestedOffset ||
      returned !== value.data.length
    )
      return undefined;

    const end = offset + returned;
    if (!Number.isSafeInteger(end)) return undefined;
    if (state === "more") {
      if (returned === 0 || end >= total || nextOffset !== end) return undefined;
    } else if (state === "complete") {
      if (end !== total || nextOffset !== null || (offset > 0 && offset >= total)) return undefined;
    } else if (state === "past_end") {
      if (offset === 0 || offset < total || returned !== 0 || nextOffset !== null) return undefined;
    } else {
      return undefined;
    }
    return { state, total, offset, returned, nextOffset };
  } catch {
    return undefined;
  }
}

/** One recovery decision for model content and Pi rendering; never fetches pages. */
export function interpretContinuation(
  params: AxRequestParams,
  stdout: string,
  fullOutputPath?: string,
): { pagination?: AxPaginationDetails; continuation?: AxContinuation } {
  const pagination = params.jsonEnvelope ? readPagination(stdout, params.offset ?? 0) : undefined;
  let continuation: AxContinuation | undefined;
  if (pagination) {
    if (pagination.state === "more") {
      continuation = {
        action: "continue",
        summary: `next offset ${pagination.nextOffset}`,
        message: `More results exist. Continue the same ax request with offset=${pagination.nextOffset}; keep other parameters unchanged. Do not restart or increase the budget.`,
      };
    } else {
      continuation = {
        action: "stop",
        summary: pagination.state === "past_end" ? "past end · stop" : "complete · stop",
        message:
          pagination.state === "past_end"
            ? "Offset is past the end. Stop pagination; do not restart."
            : "Results are complete. Stop pagination.",
      };
    }
  } else if (params.jsonEnvelope) {
    continuation = {
      action: "inspect",
      summary: "continuation unavailable",
      message:
        "Continuation metadata is missing or inconsistent. Inspect the returned output; do not guess an offset or assume completion.",
    };
  }

  if (fullOutputPath) {
    continuation = {
      action: "read_saved_output",
      summary: "read saved output first",
      message: `Pi clipped this preview. Read the saved output at ${fullOutputPath} with the read tool before requesting another page or treating these results as consumed. The file contains only the output ax returned for this call, not all remaining results.${continuation ? `\nAfter reading the saved output: ${continuation.message}` : ""}`,
    };
  }
  return {
    ...(pagination ? { pagination } : {}),
    ...(continuation ? { continuation } : {}),
  };
}
