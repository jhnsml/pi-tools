import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  getAgentDir,
  truncateHead,
  withFileMutationQueue,
  type ExtensionAPI,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

type CommandOptions = {
  cwd: string;
  signal?: AbortSignal;
  timeout: number;
  okCodes?: number[];
  emptyOutput?: string;
  mutationPath?: string;
  /** Override the package-owned Pi temp directory; useful for deterministic tests. */
  tempDir?: string;
};

type OutputDetails = {
  truncation?: TruncationResult;
  fullOutputPath?: string;
};

function shellQuote(arg: string) {
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

const DEFAULT_TEMP_DIR = "tmp/pi-bash-tools";

async function boundOutput(output: string, tempDir = join(getAgentDir(), DEFAULT_TEMP_DIR)) {
  let truncation = truncateHead(output);
  const details: OutputDetails = {};
  if (!truncation.truncated) return { text: output, details };

  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(tempDir, "output-"));
  const path = join(dir, "output.txt");
  await withFileMutationQueue(path, () => writeFile(path, output, "utf8"));
  const notice = `\n\n[Output truncated. Full output saved to: ${path}]`;
  // Include the recovery notice in the output budget, not just the command's text.
  truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES - 3,
    maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice),
  });
  details.truncation = truncation;
  details.fullOutputPath = path;
  return { text: truncation.content + notice, details };
}

async function spawn(
  pi: Pick<ExtensionAPI, "exec">,
  command: string,
  args: string[],
  options: CommandOptions,
) {
  for (let attempt = 0; ; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await pi.exec(command, args, {
        cwd: options.cwd,
        signal: options.signal,
        timeout: options.timeout,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 2 || !/\b(EBADF|EAGAIN|EMFILE|ENFILE)\b/i.test(message)) throw error;
      await delay(100 * (attempt + 1), undefined, { signal: options.signal });
    }
  }
}

/** Execute argv and return bounded Pi tool output; failures throw bounded errors.
 * The injected exec is the seam for production Pi execution and deterministic tests.
 */
export async function runCommand(
  pi: Pick<ExtensionAPI, "exec">,
  command: string,
  args: string[],
  options: CommandOptions,
) {
  try {
    const execute = async () => {
      const result = await spawn(pi, command, args, options);
      options.signal?.throwIfAborted();
      if (result.killed) throw new Error("command was killed or timed out");
      if (!(options.okCodes ?? [0]).includes(result.code)) {
        const output = (
          result.stderr ||
          result.stdout ||
          `${command} exited with code ${result.code}`
        ).trim();
        throw new Error(`exit ${result.code}: ${output}`);
      }
      return result;
    };
    const result =
      options.mutationPath === undefined
        ? await execute()
        : await withFileMutationQueue(resolve(options.cwd, options.mutationPath), execute);
    // Put diagnostics first so a large stdout cannot hide a warning behind truncation.
    const stdout = result.stdout || options.emptyOutput || "";
    const output = result.stderr ? `[stderr]\n${result.stderr}\n\n[stdout]\n${stdout}` : stdout;
    const { text, details } = await boundOutput(output, options.tempDir);
    options.signal?.throwIfAborted();
    const rawStdout = truncateHead(result.stdout);
    return {
      content: [{ type: "text" as const, text }],
      // Stream completeness is independent of the combined presentation budget.
      details: {
        ...details,
        exitCode: result.code,
        stdout: rawStdout.content,
        stdoutTruncated: rawStdout.truncated,
      },
    };
  } catch (error) {
    const formatted = [command, ...args].map(shellQuote).join(" ");
    const message = error instanceof Error ? error.message : String(error);
    const { text } = await boundOutput(`${formatted} failed: ${message}`, options.tempDir);
    throw new Error(text);
  }
}
