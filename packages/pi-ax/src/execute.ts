import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatSize, getAgentDir, truncateHead } from "@earendil-works/pi-coding-agent";
import { buildAxRequest } from "./argv.js";
import { interpretOutcome } from "./outcome.js";
import { interpretContinuation } from "./continuation.js";
import {
  AxPolicyError,
  boundedSourceLabel,
  redactSensitiveText,
  sanitizeUntrustedText,
} from "./policy.js";
import {
  MAX_BATCH_CONCURRENCY,
  MAX_BATCH_DEADLINE_MS,
  MAX_BATCH_ITEM_DIAGNOSTIC_BYTES,
  MAX_BATCH_ITEM_DIAGNOSTIC_LINES,
  MAX_BATCH_ITEM_OUTPUT_BYTES,
  MAX_BATCH_ITEM_OUTPUT_LINES,
  MAX_BATCH_PREVIEW_BYTES,
  MAX_BATCH_PREVIEW_LINES,
  MAX_BATCH_REQUESTS,
  MAX_OUTPUT_BYTES,
  MAX_SOURCE_LABEL_BYTES,
  MAX_OUTPUT_LINES,
  MAX_STDERR_BYTES,
  MAX_STDERR_LINES,
  MIN_AX_VERSION,
  type AxBatchDetails,
  type AxBatchItem,
  type AxBatchProgressDetails,
  type AxBatchState,
  type AxBatchToolResult,
  type AxDetails,
  type AxExecOptions,
  type AxExecResult,
  type AxFailure,
  type AxParams,
  type AxRequestParams,
  type AxResult,
  type AxToolResult,
  type PreparedAxRequest,
} from "./types.js";

export type AxExec = (
  command: string,
  args: string[],
  options: AxExecOptions,
) => Promise<AxExecResult>;

export class AxExecutionError extends Error {
  readonly details?: Partial<AxDetails>;

  constructor(message: string, details?: Partial<AxDetails>) {
    super(message);
    this.name = "AxExecutionError";
    this.details = details;
  }
}

const PROBE_TIMEOUT_MS = 3_000;
const NOT_FOUND_MESSAGE =
  "ax executable was not found on PATH; install ax and ensure it is on PATH, or set AX_BIN to the ax binary path";

export function axBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.AX_BIN?.trim() || "ax";
}

function truncateOutput(
  value: string,
  limits: { maxBytes: number; maxLines: number } = {
    maxBytes: MAX_OUTPUT_BYTES,
    maxLines: MAX_OUTPUT_LINES,
  },
) {
  return truncateHead(sanitizeUntrustedText(redactSensitiveText(value)), limits);
}

function truncateDiagnostic(value: string) {
  return truncateHead(sanitizeUntrustedText(redactSensitiveText(value)), {
    maxBytes: MAX_STDERR_BYTES,
    maxLines: MAX_STDERR_LINES,
  });
}

const LOCATE_HINT =
  'Hint: locate matches page text and attribute values (substring match), but this page has no such content. Run operation "outline" to discover headings, or "markdown" to read the page.';
const SELECTOR_HINT =
  'Hint: the top-level CSS selector is invalid. Use a standard CSS selector (for example "main", ".item", "table tr"); run "outline" to discover the page structure.';
const ROW_HINT =
  'Hint: row expressions use comma-separated name=selector or name=selector@attr pairs; bare name= selects the row element itself, name=@attr its attribute (example: "title=, href=a@href"). Do not use $ or jQuery-style syntax.';
const WHERE_HINT =
  "Hint: where filters use comparisons and regex matches such as price > 100 && name ~ /^foo/i, with `col name` for headers with spaces. Do not use CSS selectors or jQuery syntax in where.";

/** Recovery hints for the ax CLI failure modes most often hit by models. */
function errorHint(stderr: string, params: AxRequestParams): string | undefined {
  if (/\btext not found:/.test(stderr)) return LOCATE_HINT;
  if (/\bselector matched nothing:/.test(stderr)) {
    return 'Hint: the element is absent, or the source is not HTML (JSON and plain-text responses have no DOM). Use "outline" to inspect page structure, or "fetch"/"markdown" for non-HTML sources.';
  }
  // `bad selector: <token>` is emitted for both the top-level CSS selector and
  // selectors inside row expressions; locate the offending token to target the hint.
  const badSelector = stderr.match(/\bbad selector: (\S+)/)?.[1];
  if (badSelector) {
    const inRow = params.row?.includes(badSelector) ?? false;
    const inSelector = params.selector?.includes(badSelector) ?? false;
    if (inRow && !inSelector) return ROW_HINT;
    if (inSelector && !inRow) return SELECTOR_HINT;
    return `${SELECTOR_HINT} If the token comes from the row expression: ${ROW_HINT}`;
  }
  // Expression-parser diagnostics come from malformed --where filters.
  if (
    /\bcannot parse expression\b|\btrailing tokens in expression\b|\bunexpected (?:token in|end of) expression\b|\binvalid regex:/.test(
      stderr,
    )
  ) {
    return WHERE_HINT;
  }
  if (/\bmissing selector\b/.test(stderr)) {
    return 'Hint: this source needs a selector or a display mode; use operation "outline" or "markdown", or provide a selector.';
  }
  return undefined;
}

function errorMessage(
  stdout: string,
  stderr: string,
  code: number,
  params: AxRequestParams,
): string {
  const output = truncateOutput(stdout).content;
  const diagnostic = truncateDiagnostic(stderr).content;
  const parts = [`ax exited with code ${code}.`];
  if (diagnostic) parts.push(`stderr:\n${diagnostic}`);
  if (output) parts.push(`stdout:\n${output}`);
  const hint = errorHint(stderr, params);
  if (hint) parts.push(hint);
  return parts.join("\n\n");
}

const DEFAULT_TEMP_DIR = "tmp/pi-ax";

async function spillOutput(
  output: string,
  signal?: AbortSignal,
  tempDir = join(getAgentDir(), DEFAULT_TEMP_DIR),
): Promise<string> {
  signal?.throwIfAborted();
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(tempDir, "output-"));
  const path = join(directory, "stdout.txt");
  try {
    await writeFile(path, output, { encoding: "utf8", signal });
    signal?.throwIfAborted();
    return path;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * pi.exec resolves with empty stdout/stderr and a non-zero code when the spawn
 * itself fails (for example ENOENT); the underlying error object is discarded.
 */
function isSpawnFailure(result: AxExecResult): boolean {
  return result.code !== 0 && !result.killed && !result.stdout && !result.stderr;
}

/** Defensive net for exec implementations that throw; pi.exec itself always resolves. */
function rethrowExecError(error: unknown, signal: AbortSignal | undefined): never {
  const message = error instanceof Error ? error.message : String(error);
  if (signal?.aborted) {
    throw new AxExecutionError("ax execution was cancelled", {
      failure: { kind: "cancelled", summary: "ax request cancelled" },
    });
  }
  if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    throw new AxExecutionError(NOT_FOUND_MESSAGE, {
      failure: { kind: "process", summary: "ax process could not start" },
    });
  }
  const diagnostic = truncateDiagnostic(message).content;
  throw new AxExecutionError(`ax execution failed: ${diagnostic}`, {
    failure: { kind: "process", summary: "ax process failure" },
  });
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(actual: [number, number, number], minimum: string): boolean {
  const required = parseVersion(minimum)!;
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index]! > required[index]!) return true;
    if (actual[index]! < required[index]!) return false;
  }
  return true;
}

const versionChecks = new WeakMap<AxExec, Set<string>>();

async function probeSupportedAxVersion(
  exec: AxExec,
  binary: string,
  context: { cwd: string; signal?: AbortSignal },
  timeout: number,
): Promise<void> {
  let result: AxExecResult;
  try {
    result = await exec(binary, ["--version"], {
      cwd: context.cwd,
      signal: context.signal,
      timeout,
    });
  } catch (error) {
    rethrowExecError(error, context.signal);
  }
  if (context.signal?.aborted)
    throw new AxExecutionError("ax execution was cancelled", {
      failure: { kind: "cancelled", summary: "ax request cancelled" },
    });
  if (result.killed)
    throw new AxExecutionError("ax version check timed out", {
      failure: { kind: "timeout", summary: "ax version check timed out" },
    });
  if (isSpawnFailure(result))
    throw new AxExecutionError(NOT_FOUND_MESSAGE, {
      failure: { kind: "process", summary: "ax process could not start" },
    });
  if (result.code !== 0) {
    const diagnostic = truncateDiagnostic(result.stderr || result.stdout).content;
    throw new AxExecutionError(
      `could not determine ax version${diagnostic ? `: ${diagnostic}` : ""}`,
    );
  }

  const versionText = result.stdout.trim();
  const version = parseVersion(versionText);
  if (!version) {
    throw new AxExecutionError(
      `could not parse ax version from ${JSON.stringify(truncateDiagnostic(versionText).content)}`,
    );
  }
  if (!versionAtLeast(version, MIN_AX_VERSION)) {
    throw new AxExecutionError(
      `ax >= ${MIN_AX_VERSION} is required; found ${versionText}. Upgrade ax and try again.`,
    );
  }
}

async function assertSupportedAxVersion(
  exec: AxExec,
  binary: string,
  context: { cwd: string; signal?: AbortSignal },
  timeout: number,
): Promise<boolean> {
  let checks = versionChecks.get(exec);
  if (!checks) {
    checks = new Set();
    versionChecks.set(exec, checks);
  }
  const key = `${binary}\0${context.cwd}`;
  if (checks.has(key)) return false;
  await probeSupportedAxVersion(exec, binary, context, timeout);
  checks.add(key);
  return true;
}

function classifyFailure(code: number, stderr: string): AxFailure {
  // ax 0.1.23 emits this exact, line-oriented diagnostic when its request
  // transport throws. Do not inspect the message tail: it can include user input.
  const lines = stderr.split(/\r?\n/);
  if (lines.some((line) => /^ax: error: request timed out after \d+(?:\.\d+)?s$/.test(line))) {
    return { kind: "timeout", summary: "ax request timed out" };
  }
  if (lines.some((line) => line.startsWith("ax: error: request failed: "))) {
    return { kind: "network", summary: "ax network failure" };
  }
  return { kind: "process", summary: `ax process exited with code ${code}` };
}

function failureFromError(error: unknown): AxFailure {
  if (error instanceof AxExecutionError && error.details?.failure) return error.details.failure;
  return { kind: "process", summary: "ax process failure" };
}

function firstLineNotice(totalBytes: number): string {
  return `[The first output line exceeds the preview limit; no partial line is shown. Output size: ${formatSize(totalBytes)}.]`;
}

async function executePreparedAx(
  exec: AxExec,
  params: AxRequestParams,
  request: PreparedAxRequest,
  context: { cwd: string; signal?: AbortSignal; tempDir?: string },
  options: { skipVersionCheck?: boolean; batch?: boolean } = {},
): Promise<AxDetails> {
  const binary = axBinary();
  const startedAt = Date.now();
  const checkedVersion = options.skipVersionCheck
    ? false
    : await assertSupportedAxVersion(
        exec,
        binary,
        context,
        Math.min(PROBE_TIMEOUT_MS, request.timeout),
      );
  const remainingTimeout = checkedVersion
    ? Math.max(0, request.timeout - (Date.now() - startedAt))
    : request.timeout;
  if (remainingTimeout === 0) {
    throw new AxExecutionError(`ax execution timed out after ${request.timeout}ms`, {
      failure: { kind: "timeout", summary: "ax request timed out" },
    });
  }

  let result: AxExecResult;
  try {
    result = await exec(binary, request.argv, {
      cwd: context.cwd,
      signal: context.signal,
      timeout: remainingTimeout,
    });
  } catch (error) {
    rethrowExecError(error, context.signal);
  }

  if (context.signal?.aborted) {
    throw new AxExecutionError("ax execution was cancelled", {
      failure: { kind: "cancelled", summary: "ax request cancelled" },
    });
  }
  if (result.killed) {
    throw new AxExecutionError(`ax execution timed out after ${request.timeout}ms`, {
      failure: { kind: "timeout", summary: "ax request timed out" },
    });
  }
  if (result.code !== 0) {
    const failure = classifyFailure(result.code, result.stderr);
    throw new AxExecutionError(errorMessage(result.stdout, result.stderr, result.code, params), {
      operation: request.operation,
      source: boundedSourceLabel(request.safeSource, MAX_SOURCE_LABEL_BYTES),
      exitCode: result.code,
      killed: result.killed,
      elapsedMs: Date.now() - startedAt,
      failure,
    });
  }

  const safeOutput = sanitizeUntrustedText(redactSensitiveText(result.stdout));
  const visible = truncateOutput(
    safeOutput,
    options.batch
      ? { maxBytes: MAX_BATCH_ITEM_OUTPUT_BYTES, maxLines: MAX_BATCH_ITEM_OUTPUT_LINES }
      : undefined,
  );
  const preview = visible.firstLineExceedsLimit
    ? firstLineNotice(visible.totalBytes)
    : visible.content || "(ax returned no output)";
  const diagnostic = truncateDiagnostic(result.stderr);
  let fullOutputPath: string | undefined;
  // Account for JSON escaping and record overhead before deciding whether the
  // complete output needs a recoverable copy. Batch indices are single-digit.
  const serializedClipped =
    options.batch &&
    Buffer.byteLength(outputRecord(MAX_BATCH_REQUESTS - 1, preview, false), "utf8") >
      MAX_BATCH_ITEM_OUTPUT_BYTES;
  const truncated = visible.truncated || Boolean(serializedClipped);
  if (truncated) {
    try {
      fullOutputPath = await spillOutput(safeOutput, context.signal, context.tempDir);
    } catch (error) {
      rethrowExecError(error, context.signal);
    }
  }
  const truncation = visible.truncated
    ? {
        outputBytes: visible.outputBytes,
        outputLines: visible.outputLines,
        totalBytes: visible.totalBytes,
        totalLines: visible.totalLines,
        firstLineExceedsLimit: visible.firstLineExceedsLimit,
      }
    : undefined;
  const recovery = interpretContinuation(params, result.stdout, fullOutputPath);
  const outcome = interpretOutcome(params.operation, result.stdout, result.stderr);

  return {
    outcome,
    operation: request.operation,
    source: boundedSourceLabel(request.safeSource, MAX_SOURCE_LABEL_BYTES),
    exitCode: result.code,
    killed: result.killed,
    elapsedMs: Date.now() - startedAt,
    truncated,
    ...(truncation ? { truncation } : {}),
    ...(fullOutputPath ? { fullOutputPath } : {}),
    ...(diagnostic.content ? { stderr: diagnostic.content } : {}),
    ...(diagnostic.truncated ? { stderrTruncated: true } : {}),
    preview,
    ...recovery,
  };
}

function formatSingle(details: AxDetails): string {
  const metadata = JSON.stringify({
    type: "ax_result",
    trust: "trusted",
    operation: details.operation,
    source: details.source,
    execution: "completed",
    outcome: details.outcome?.summary ?? "ax completed",
    attention: details.outcome?.attention ?? false,
    elapsedMs: details.elapsedMs,
    ...(details.outcome?.notes ? { diagnostic: details.outcome.notes } : {}),
    ...(details.truncation ? { truncation: details.truncation } : {}),
    ...(details.fullOutputPath ? { fullOutputPath: details.fullOutputPath } : {}),
    ...(details.continuation
      ? {
          followUp: details.continuation.action,
          nextAction: details.continuation.message,
        }
      : { followUp: "none" }),
    ...(details.pagination?.nextOffset !== null && details.pagination?.nextOffset !== undefined
      ? { nextOffset: details.pagination.nextOffset }
      : {}),
  });
  const output = JSON.stringify({
    type: "ax_output",
    trust: "untrusted",
    content: details.preview,
  });
  return `${metadata}\n${output}`;
}

function singleToolResult(details: AxDetails): AxToolResult {
  return { content: [{ type: "text", text: formatSingle(details) }], details };
}

function validateBatch(params: AxParams, cwd: string) {
  if (!Array.isArray(params.requests)) {
    throw new AxPolicyError("requests must be an array");
  }
  // SAFETY: every non-requests field is a key in the validated AxParams shape.
  const hasSharedFields = Object.keys(params).some(
    (field) => field !== "requests" && params[field as keyof AxParams] !== undefined,
  );
  if (hasSharedFields) {
    throw new AxPolicyError("Batch input cannot include fields outside the requests array.");
  }
  if (params.requests.length < 1 || params.requests.length > MAX_BATCH_REQUESTS) {
    throw new AxPolicyError(`requests must contain between 1 and ${MAX_BATCH_REQUESTS} items`);
  }
  return params.requests.map((item, index) => {
    try {
      // SAFETY: batch items were validated as object-shaped request records before execution.
      if ("requests" in (item as object)) {
        throw new AxPolicyError("nested requests are not permitted");
      }
      return { params: item, request: buildAxRequest(item, cwd) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const source = boundedSourceLabel(
        typeof item?.source === "string" ? item.source : "",
        MAX_SOURCE_LABEL_BYTES,
      );
      const diagnostic = truncateDiagnostic(message).content;
      throw new AxPolicyError(
        `Invalid batch item ${index}${source ? ` (${source})` : ""}: ${diagnostic}`,
      );
    }
  });
}

function batchItemFromDetails(index: number, details: AxDetails): AxBatchItem {
  return {
    index,
    operation: details.operation,
    source: details.source,
    execution: "completed",
    outcome: details.outcome,
    preview: details.preview,
    elapsedMs: details.elapsedMs,
    truncated: details.truncated,
    ...(details.truncation ? { truncation: details.truncation } : {}),
    ...(details.fullOutputPath ? { fullOutputPath: details.fullOutputPath } : {}),
    ...(details.stderr ? { stderr: details.stderr } : {}),
    ...(details.stderrTruncated ? { stderrTruncated: true } : {}),
    ...(details.pagination ? { pagination: details.pagination } : {}),
    ...(details.continuation ? { continuation: details.continuation } : {}),
  };
}

function boundedBatchDiagnostic(value: string): string {
  const diagnostic = truncateHead(sanitizeUntrustedText(redactSensitiveText(value)), {
    maxBytes: MAX_BATCH_ITEM_DIAGNOSTIC_BYTES,
    maxLines: MAX_BATCH_ITEM_DIAGNOSTIC_LINES,
  });
  if (diagnostic.firstLineExceedsLimit) return "Diagnostic exceeded the batch item limit.";
  return diagnostic.content + (diagnostic.truncated ? "\n[Diagnostic truncated]" : "");
}

function itemMetadata(item: AxBatchItem): Record<string, unknown> {
  const diagnostic = item.outcome?.notes
    ? boundedBatchDiagnostic(item.outcome.notes)
    : item.error
      ? boundedBatchDiagnostic(item.error)
      : undefined;
  return {
    type: "ax_item",
    trust: "trusted",
    index: item.index,
    operation: item.operation,
    source: item.source,
    execution: item.execution,
    ...(item.outcome ? { outcome: item.outcome.summary, attention: item.outcome.attention } : {}),
    ...(item.failure ? { failureKind: item.failure.kind, failure: item.failure.summary } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    ...(item.continuation
      ? {
          followUp: item.continuation.action,
          nextAction: item.continuation.message,
        }
      : { followUp: "none" }),
    ...(item.fullOutputPath ? { fullOutputPath: item.fullOutputPath } : {}),
    ...(item.pagination?.nextOffset !== null && item.pagination?.nextOffset !== undefined
      ? { nextOffset: item.pagination.nextOffset }
      : {}),
  };
}

function outputRecord(index: number, content: string, clipped: boolean): string {
  return JSON.stringify({
    type: "ax_output",
    trust: "untrusted",
    index,
    content,
    ...(clipped ? { clipped: true } : {}),
  });
}

function fitOutputRecord(index: number, content: string, maxBytes: number): string | undefined {
  const make = (value: string, clipped: boolean) => outputRecord(index, value, clipped);
  const complete = make(content, false);
  if (Buffer.byteLength(complete, "utf8") <= maxBytes) return complete;

  const characters = Array.from(content);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = make(characters.slice(0, middle).join(""), true);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const result = make(characters.slice(0, low).join(""), true);
  return Buffer.byteLength(result, "utf8") <= maxBytes ? result : undefined;
}

function formatBatch(details: AxBatchDetails): string {
  const summary = JSON.stringify({
    type: "ax_batch",
    trust: "trusted",
    state: details.state,
    total: details.total,
    started: details.started,
    completed: details.completed,
    failed: details.failed,
    unfinished: details.unfinished,
    elapsedMs: details.elapsedMs,
    ...(details.failure
      ? { failureKind: details.failure.kind, failure: details.failure.summary }
      : {}),
    ...(details.error ? { diagnostic: boundedBatchDiagnostic(details.error) } : {}),
  });
  const metadata = details.items.map((item) => JSON.stringify(itemMetadata(item)));
  const lines = [summary, ...metadata];
  let usedBytes = Buffer.byteLength(lines.join("\n"), "utf8");
  const outputItems = details.items.filter(
    (item): item is AxBatchItem & { preview: string } =>
      item.execution === "completed" && typeof item.preview === "string",
  );
  const available = Math.max(0, MAX_BATCH_PREVIEW_BYTES - usedBytes - outputItems.length);
  const fairShare = outputItems.length > 0 ? Math.floor(available / outputItems.length) : 0;

  for (const item of outputItems) {
    const line = fitOutputRecord(
      item.index,
      item.preview,
      Math.min(MAX_BATCH_ITEM_OUTPUT_BYTES, fairShare),
    );
    if (!line) continue;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (usedBytes + lineBytes > MAX_BATCH_PREVIEW_BYTES) break;
    lines.push(line);
    usedBytes += lineBytes;
  }

  return truncateHead(lines.join("\n"), {
    maxBytes: MAX_BATCH_PREVIEW_BYTES,
    maxLines: MAX_BATCH_PREVIEW_LINES,
  }).content;
}

type ExecuteContext = {
  cwd: string;
  signal?: AbortSignal;
  /** Override the package-owned Pi temp directory; useful for deterministic tests. */
  tempDir?: string;
  batchDeadlineMs?: number;
  onProgress?: (progress: AxBatchProgressDetails) => void;
};

async function executeBatch(
  exec: AxExec,
  params: AxParams,
  context: ExecuteContext,
): Promise<AxBatchToolResult> {
  const prepared = validateBatch(params, context.cwd);
  const startedAt = Date.now();
  const deadlineMs = Math.max(
    1,
    Math.min(context.batchDeadlineMs ?? MAX_BATCH_DEADLINE_MS, MAX_BATCH_DEADLINE_MS),
  );
  const controller = new AbortController();
  const relayAbort = () => controller.abort(context.signal?.reason);
  context.signal?.addEventListener("abort", relayAbort, { once: true });
  if (context.signal?.aborted) relayAbort();
  let deadlineExceeded = false;
  const timer = setTimeout(() => {
    deadlineExceeded = true;
    controller.abort(new Error("batch deadline exceeded"));
  }, deadlineMs);
  timer.unref?.();

  const items: AxBatchItem[] = prepared.map(({ request }, index) => ({
    index,
    operation: request.operation,
    source: boundedSourceLabel(request.safeSource, MAX_SOURCE_LABEL_BYTES),
    execution: "not_started",
  }));
  let state: AxBatchState = "complete";
  let batchFailure: AxFailure | undefined;
  let batchError: string | undefined;
  let active = 0;
  let started = 0;
  const emitProgress = () => {
    try {
      context.onProgress?.({
        batchProgress: true,
        total: items.length,
        started,
        active,
      });
    } catch {
      // Rendering progress must never change execution behavior.
    }
  };
  emitProgress();

  try {
    if (controller.signal.aborted) {
      throw new AxExecutionError("ax execution was cancelled", {
        failure: { kind: "cancelled", summary: "ax request cancelled" },
      });
    }
    await assertSupportedAxVersion(
      exec,
      axBinary(),
      { cwd: context.cwd, signal: controller.signal },
      Math.min(PROBE_TIMEOUT_MS, deadlineMs),
    );

    // A fixed worker pool keeps cancellation and ordering local without another dependency.
    let nextIndex = 0;
    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = nextIndex;
        if (index >= prepared.length) return;
        nextIndex += 1;
        const current = prepared[index]!;
        started += 1;
        active += 1;
        emitProgress();
        try {
          const details = await executePreparedAx(
            exec,
            current.params,
            current.request,
            { cwd: context.cwd, signal: controller.signal, tempDir: context.tempDir },
            { skipVersionCheck: true, batch: true },
          );
          items[index] = batchItemFromDetails(index, details);
        } catch (error) {
          const failure = deadlineExceeded
            ? { kind: "timeout" as const, summary: "batch deadline exceeded" }
            : failureFromError(error);
          const cancelled = controller.signal.aborted || failure.kind === "cancelled";
          items[index] = {
            index,
            operation: current.request.operation,
            source: boundedSourceLabel(current.request.safeSource, MAX_SOURCE_LABEL_BYTES),
            execution: cancelled ? "cancelled" : "failed",
            error: deadlineExceeded
              ? "Batch deadline exceeded while this request was active."
              : boundedBatchDiagnostic(error instanceof Error ? error.message : String(error)),
            failure,
          };
        } finally {
          active -= 1;
          emitProgress();
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_BATCH_CONCURRENCY, prepared.length) }, () => worker()),
    );
    if (deadlineExceeded) {
      state = "deadline_exceeded";
      batchFailure = { kind: "timeout", summary: "batch deadline exceeded" };
      batchError = "The overall batch deadline expired before every request finished.";
    } else if (context.signal?.aborted) {
      state = "cancelled";
      batchFailure = { kind: "cancelled", summary: "ax batch cancelled" };
      batchError = "The batch was cancelled before every request finished.";
    }
  } catch (error) {
    if (deadlineExceeded) {
      state = "deadline_exceeded";
      batchFailure = { kind: "timeout", summary: "batch deadline exceeded" };
      batchError = "The overall batch deadline expired before request execution started.";
    } else if (controller.signal.aborted) {
      state = "cancelled";
      batchFailure = { kind: "cancelled", summary: "ax batch cancelled" };
      batchError = "The batch was cancelled before request execution started.";
    } else {
      state = "setup_failed";
      batchFailure = failureFromError(error);
      batchError = boundedBatchDiagnostic(error instanceof Error ? error.message : String(error));
    }
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", relayAbort);
  }

  const completed = items.filter((item) => item.execution === "completed").length;
  const failed = items.filter((item) => item.execution === "failed").length;
  const unfinished = items.length - completed - failed;
  const details: AxBatchDetails = {
    batch: true,
    state,
    total: items.length,
    started,
    completed,
    failed,
    unfinished,
    elapsedMs: Date.now() - startedAt,
    deadlineMs,
    items,
    ...(batchFailure ? { failure: batchFailure } : {}),
    ...(batchError ? { error: batchError } : {}),
  };
  return {
    content: [{ type: "text", text: formatBatch(details) }],
    details,
  };
}

export function executeAx(
  exec: AxExec,
  params: AxRequestParams,
  context: ExecuteContext,
): Promise<AxToolResult>;
export function executeAx(
  exec: AxExec,
  params: { requests: AxRequestParams[] },
  context: ExecuteContext,
): Promise<AxBatchToolResult>;
export function executeAx(
  exec: AxExec,
  params: AxParams,
  context: ExecuteContext,
): Promise<AxResult>;
export async function executeAx(
  exec: AxExec,
  params: AxParams,
  context: ExecuteContext,
): Promise<AxResult> {
  if (params.requests !== undefined) return executeBatch(exec, params, context);
  // SAFETY: the absence of requests selects the validated single-request branch.
  const requestParams = params as AxRequestParams;
  const request = buildAxRequest(requestParams, context.cwd);
  const details = await executePreparedAx(exec, requestParams, request, context);
  return singleToolResult(details);
}
