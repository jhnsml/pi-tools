import type { Static } from "typebox";
import type { axRequestSchema, axSchema } from "./argv.js";

export const OPERATIONS = [
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
] as const;

export type Operation = (typeof OPERATIONS)[number];

// Type-only dependencies: the tool schemas are the input types' source of truth.
export type AxRequestParams = Static<typeof axRequestSchema>;
export type AxParams = Static<typeof axSchema>;

export type PreparedAxRequest = {
  source: string;
  argv: string[];
  operation: Operation;
  safeSource: string;
  timeout: number;
};

export type AxExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
};

export type AxExecOptions = {
  cwd: string;
  signal?: AbortSignal;
  timeout: number;
};

export type AxTruncationDetails = {
  outputBytes: number;
  outputLines: number;
  totalBytes: number;
  totalLines: number;
  firstLineExceedsLimit: boolean;
};

export type AxPaginationDetails = {
  state: "more" | "complete" | "past_end";
  total: number;
  offset: number;
  returned: number;
  nextOffset: number | null;
};

export type AxContinuation = {
  action: "read_saved_output" | "continue" | "stop" | "inspect";
  summary: string;
  message: string;
};

export type AxOutcome = {
  summary: string;
  attention: boolean;
  notes?: string;
  cache?: string;
};

export type AxFailure = {
  kind: "process" | "network" | "timeout" | "cancelled";
  summary: string;
};

export type AxDetails = {
  operation: Operation;
  source: string;
  exitCode: number;
  killed: boolean;
  elapsedMs: number;
  truncated: boolean;
  truncation?: AxTruncationDetails;
  fullOutputPath?: string;
  stderr?: string;
  stderrTruncated?: boolean;
  preview: string;
  pagination?: AxPaginationDetails;
  continuation?: AxContinuation;
  outcome?: AxOutcome;
  failure?: AxFailure;
};

export type AxBatchExecution = "completed" | "failed" | "cancelled" | "not_started";
export type AxBatchState = "complete" | "cancelled" | "deadline_exceeded" | "setup_failed";

export type AxBatchItem = {
  index: number;
  operation: Operation;
  source: string;
  execution: AxBatchExecution;
  outcome?: AxOutcome;
  failure?: AxFailure;
  error?: string;
  preview?: string;
  elapsedMs?: number;
  truncated?: boolean;
  truncation?: AxTruncationDetails;
  fullOutputPath?: string;
  stderr?: string;
  stderrTruncated?: boolean;
  pagination?: AxPaginationDetails;
  continuation?: AxContinuation;
};

export type AxBatchDetails = {
  batch: true;
  state: AxBatchState;
  total: number;
  started: number;
  completed: number;
  failed: number;
  unfinished: number;
  elapsedMs: number;
  deadlineMs: number;
  items: AxBatchItem[];
  failure?: AxFailure;
  error?: string;
};

export type AxBatchProgressDetails = {
  batchProgress: true;
  total: number;
  started: number;
  active: number;
};

export type AxToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: AxDetails;
};

export type AxBatchToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: AxBatchDetails;
};

export type AxResult = AxToolResult | AxBatchToolResult;

export const MIN_AX_VERSION = "0.1.23";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 20_000;
export const MAX_OUTPUT_LINES = 2_000;
export const MAX_STDERR_BYTES = 4_000;
export const MAX_STDERR_LINES = 200;
export const MAX_BATCH_REQUESTS = 10;
export const MAX_BATCH_CONCURRENCY = 4;
export const MAX_BATCH_DEADLINE_MS = 120_000;
export const MAX_BATCH_ITEM_OUTPUT_BYTES = 3_000;
export const MAX_BATCH_ITEM_OUTPUT_LINES = 200;
export const MAX_BATCH_ITEM_DIAGNOSTIC_BYTES = 1_000;
export const MAX_BATCH_ITEM_DIAGNOSTIC_LINES = 50;
export const MAX_BATCH_PREVIEW_BYTES = 50 * 1024;
export const MAX_BATCH_PREVIEW_LINES = 2_000;
export const MAX_SOURCE_LABEL_BYTES = 500;
