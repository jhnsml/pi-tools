import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AxPolicyError, validateHeaders, validateSource } from "./policy.js";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  OPERATIONS,
  MAX_BATCH_REQUESTS,
  type AxParams,
  type AxRequestParams,
  type Operation,
  type PreparedAxRequest,
} from "./types.js";

const PARSE_OPERATIONS = OPERATIONS.filter((operation) => operation !== "fetch");
const PAGINATED_OPERATIONS = PARSE_OPERATIONS.filter((operation) => operation !== "count");
const ROW_OPERATIONS: readonly Operation[] = ["row", "table"];

// One source for conditional requirements, applicability, and model guidance.
// Order also keeps aggregated validation errors deterministic.
const FIELD_RULES = {
  selector: { operations: ["count", "row", "table", "text", "attr", "html"], required: true },
  text: { operations: ["locate"], required: true },
  row: { operations: ["row"], required: true },
  attribute: { operations: ["attr"], required: true },
  where: { operations: ROW_OPERATIONS },
  json: { operations: ROW_OPERATIONS },
  jsonEnvelope: { operations: ["locate", "row", "table"] },
  fresh: { operations: PARSE_OPERATIONS },
  noCache: { operations: PARSE_OPERATIONS },
  limit: { operations: PAGINATED_OPERATIONS },
  offset: { operations: PAGINATED_OPERATIONS },
  all: { operations: ["fetch", ...PAGINATED_OPERATIONS] },
  budget: { operations: ["fetch", ...PAGINATED_OPERATIONS] },
} satisfies Record<string, { operations: readonly Operation[]; required?: boolean }>;

type OperationField = keyof typeof FIELD_RULES;
// SAFETY: FIELD_RULES is the owner of every operation field key.
const operationFields = Object.keys(FIELD_RULES) as OperationField[];

function allows(field: OperationField, operation: Operation): boolean {
  const operations: readonly Operation[] = FIELD_RULES[field].operations;
  return operations.includes(operation);
}

function describeField(field: OperationField, description: string): string {
  const rule = FIELD_RULES[field];
  return `${description} ${"required" in rule && rule.required ? "Required" : "Valid"} for: ${rule.operations.join(", ")}.`;
}

// Keep a flat, provider-compatible schema; runtime validation enforces the
// conditional requirements described from FIELD_RULES above.
export const axRequestSchema = Type.Object(
  {
    source: Type.String({ description: "HTTP(S) URL or an existing regular local file path." }),
    operation: StringEnum(OPERATIONS, { description: "Read-only ax operation to perform." }),
    selector: Type.Optional(
      Type.String({ description: describeField("selector", "CSS selector.") }),
    ),
    text: Type.Optional(
      Type.String({
        description: describeField(
          "text",
          "Page text or attribute value to locate (substring match; attributes such as href/title are searched too). Run outline first to discover page structure.",
        ),
      }),
    ),
    row: Type.Optional(
      Type.String({
        description: describeField(
          "row",
          "ax row expression: comma-separated name=selector or name=selector@attr pairs. Bare name= uses the row element's own text, name=@attr its attribute. Example: title=, href=a@href. Do not use $ or jQuery-style syntax.",
        ),
      }),
    ),
    attribute: Type.Optional(
      Type.String({ description: describeField("attribute", "Attribute name.") }),
    ),
    where: Type.Optional(
      Type.String({ description: describeField("where", "ax filter expression.") }),
    ),
    headers: Type.Optional(
      Type.Array(Type.String({ description: "Safe public header in Name: value form." })),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, description: describeField("limit", "Maximum results.") }),
    ),
    budget: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: describeField("budget", "Approximate output token budget."),
      }),
    ),
    offset: Type.Optional(
      Type.Integer({ minimum: 0, description: describeField("offset", "Skip this many results.") }),
    ),
    all: Type.Optional(
      Type.Boolean({
        description: describeField("all", "Remove the fetch body cap or return all parse results."),
      }),
    ),
    fresh: Type.Optional(
      Type.Boolean({
        description: describeField("fresh", "Refetch instead of using ax parse cache."),
      }),
    ),
    noCache: Type.Optional(
      Type.Boolean({
        description: describeField("noCache", "Do not read or write ax parse cache."),
      }),
    ),
    json: Type.Optional(
      Type.Boolean({ description: describeField("json", "Return output as JSON.") }),
    ),
    jsonEnvelope: Type.Optional(
      Type.Boolean({
        description: describeField(
          "jsonEnvelope",
          "Return {data, meta} JSON with continuation state and next_offset; do not combine with json.",
        ),
      }),
    ),
    timeout: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        description: "Wrapper timeout in milliseconds.",
      }),
    ),
  },
  { additionalProperties: false },
);

const {
  source: _source,
  operation: _operation,
  ...optionalRequestFields
} = axRequestSchema.properties;

// Keep the top-level schema flat for provider compatibility. Runtime validation
// enforces either source+operation or requests, never both.
export const axSchema = Type.Object(
  {
    source: Type.Optional(
      Type.String({
        description:
          "HTTP(S) URL or existing regular local file. Required with operation for a single request; omit when requests is used.",
      }),
    ),
    operation: Type.Optional(
      StringEnum(OPERATIONS, {
        description:
          "Read-only ax operation for a single request. Required with source; omit when requests is used.",
      }),
    ),
    ...optionalRequestFields,
    requests: Type.Optional(
      Type.Array(axRequestSchema, {
        minItems: 1,
        maxItems: MAX_BATCH_REQUESTS,
        description: `Complete independent ax requests in input order. Use for 1–${MAX_BATCH_REQUESTS} requests; omit all sibling fields.`,
      }),
    ),
  },
  { additionalProperties: false },
);

const REQUEST_FIELDS = new Set(Object.keys(axRequestSchema.properties));
const TOP_LEVEL_FIELDS = new Set(Object.keys(axSchema.properties));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Safe preflight that runs before Pi's schema validator can echo raw arguments. */
export function prepareAxArguments(args: unknown): AxParams {
  if (!isRecord(args)) throw new AxPolicyError("ax input must be an object");
  if (Object.keys(args).some((field) => !TOP_LEVEL_FIELDS.has(field))) {
    throw new AxPolicyError("ax input contains unsupported fields");
  }

  if (Object.hasOwn(args, "requests")) {
    if (Object.keys(args).some((field) => field !== "requests")) {
      throw new AxPolicyError("Batch input cannot include fields outside the requests array.");
    }
    if (!Array.isArray(args.requests)) throw new AxPolicyError("requests must be an array");
    if (args.requests.length < 1 || args.requests.length > MAX_BATCH_REQUESTS) {
      throw new AxPolicyError(`requests must contain between 1 and ${MAX_BATCH_REQUESTS} items`);
    }
    for (let index = 0; index < args.requests.length; index += 1) {
      const item = args.requests[index];
      if (!isRecord(item)) {
        throw new AxPolicyError(`Invalid batch item ${index}: request must be an object`);
      }
      if (Object.keys(item).some((field) => !REQUEST_FIELDS.has(field))) {
        throw new AxPolicyError(`Invalid batch item ${index}: request contains unsupported fields`);
      }
      if (!Value.Check(axRequestSchema, item)) {
        throw new AxPolicyError(
          `Invalid batch item ${index}: required fields are missing or have invalid types`,
        );
      }
    }
  } else if (!Value.Check(axSchema, args)) {
    throw new AxPolicyError("Single ax request fields have invalid types");
  }

  // SAFETY: Value.Check validated the complete single or batch shape above.
  return args as AxParams;
}

function throwAggregatedError(
  params: AxRequestParams,
  invalid: string[],
  missing: string[],
): never {
  const parts: string[] = [];
  if (invalid.length > 0) {
    parts.push(`Invalid fields for operation "${params.operation}": ${invalid.join(", ")}.`);
  }
  if (missing.length > 0) {
    parts.push(`Missing required fields: ${missing.join(", ")}.`);
  }
  const valid = [
    ...operationFields.filter((field) => allows(field, params.operation)),
    "headers",
    "timeout",
  ];
  parts.push(`Valid fields: ${valid.join(", ")}.`);
  if (params.operation === "fetch") {
    parts.push(
      'Example: { "source": "https://api.example.com/items", "operation": "fetch", "timeout": 20000 }',
    );
  } else if (params.operation === "row" && !params.row?.trim()) {
    parts.push(
      'Example: { "source": "https://example.com", "operation": "row", "selector": "a", "row": "title=, href=@href" }',
    );
  }
  throw new AxPolicyError(parts.join(" "));
}

export function validateOperationInput(params: AxRequestParams): void {
  if (Object.keys(params).some((field) => !REQUEST_FIELDS.has(field))) {
    throw new AxPolicyError("request contains unsupported fields");
  }
  if (typeof params.operation !== "string" || !OPERATIONS.includes(params.operation))
    throw new AxPolicyError("operation is required and must be supported");
  if (typeof params.source !== "string" || !params.source.trim())
    throw new AxPolicyError("source is required");

  const invalid: string[] = [];
  const missing: string[] = [];
  for (const field of operationFields) {
    const rule = FIELD_RULES[field];
    if (!allows(field, params.operation)) {
      if (params[field] !== undefined) invalid.push(field);
    } else if (
      "required" in rule &&
      rule.required &&
      // SAFETY: required operation fields are string-valued by axRequestSchema.
      !(params[field] as string | undefined)?.trim()
    ) {
      missing.push(field);
    }
  }
  if (invalid.length > 0 || missing.length > 0) throwAggregatedError(params, invalid, missing);

  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) {
    throw new AxPolicyError("limit must be a positive integer");
  }
  if (params.budget !== undefined && (!Number.isInteger(params.budget) || params.budget < 1)) {
    throw new AxPolicyError("budget must be a positive integer");
  }
  if (params.offset !== undefined && (!Number.isInteger(params.offset) || params.offset < 0)) {
    throw new AxPolicyError("offset must be a non-negative integer");
  }
  if (params.timeout !== undefined && (!Number.isInteger(params.timeout) || params.timeout < 1)) {
    throw new AxPolicyError("timeout must be a positive integer in milliseconds");
  }
  if (params.fresh && params.noCache)
    throw new AxPolicyError("fresh and noCache cannot be used together");
  if (params.all && params.limit !== undefined)
    throw new AxPolicyError("all and limit cannot be used together");
  if (params.json && params.jsonEnvelope)
    throw new AxPolicyError("json and jsonEnvelope cannot be used together");
}

function addOperation(argv: string[], params: AxRequestParams): void {
  switch (params.operation) {
    case "outline":
      argv.push("--outline");
      break;
    case "locate":
      argv.push("--locate", params.text!);
      break;
    case "count":
      argv.push("--count");
      break;
    case "row":
      argv.push("--row", params.row!);
      break;
    case "table":
      argv.push("--table");
      break;
    case "text":
      argv.push("--text");
      break;
    case "attr":
      argv.push("--attr", params.attribute!);
      break;
    case "html":
      argv.push("--html");
      break;
    case "markdown":
      argv.push("--md");
      break;
    case "fetch":
      break;
  }
}

export function buildAxRequest(params: AxRequestParams, cwd: string): PreparedAxRequest {
  validateOperationInput(params);
  const source = validateSource(params.source, cwd);
  if (params.operation === "fetch" && source.kind === "file") {
    throw new AxPolicyError(
      'fetch requires an HTTP(S) URL; ax cannot raw-fetch a local file. Use operation "markdown", "outline", "text", or "html" for local files.',
    );
  }
  const headers = validateHeaders(params.headers);
  const argv = [source.value];
  if (params.selector) argv.push(params.selector);
  addOperation(argv, params);
  for (const header of headers) argv.push("-H", header);
  if (params.where) argv.push("--where", params.where);
  if (params.limit !== undefined) argv.push("--limit", String(params.limit));
  if (params.offset !== undefined) argv.push("--offset", String(params.offset));
  if (params.budget !== undefined) argv.push("--budget", String(params.budget));
  if (params.all) argv.push("--all");
  if (params.fresh) argv.push("--fresh");
  if (params.noCache) argv.push("--no-cache");
  if (params.json) argv.push("--json");
  if (params.jsonEnvelope) argv.push("--json-envelope");

  return {
    source: source.value,
    argv,
    operation: params.operation,
    safeSource: source.safeLabel,
    timeout: Math.min(params.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
  };
}
