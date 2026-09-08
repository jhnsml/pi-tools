import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  withFileMutationQueue,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { runCommand } from "../extensions/lib/command-runner.js";

const cleanup = new Set<string>();
afterEach(() => {
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
  cleanup.clear();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function result(stdout = "ok", stderr = "", code = 0) {
  return { stdout, stderr, code, killed: false };
}
const outputDirectory = mkdtempSync(join(tmpdir(), "pi-bash-tools-output-test-"));
const options = { cwd: tmpdir(), timeout: 10000, tempDir: outputDirectory };
afterAll(() => rmSync(outputDirectory, { recursive: true, force: true }));

function expectBounded(text: string) {
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  expect(text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
}

function savedOutput(path: string | undefined) {
  expect(path).toBeDefined();
  cleanup.add(dirname(path!));
  return readFileSync(path!, "utf8");
}

describe("command runner", () => {
  it("forwards argv and execution controls without invoking a shell", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue(result("stats"));
    const signal = new AbortController().signal;
    const args = ["--sort", "code", "path with spaces; $(literal)"];
    const output = await runCommand({ exec }, "scc", args, { ...options, signal });
    expect(exec).toHaveBeenCalledExactlyOnceWith("scc", args, {
      cwd: options.cwd,
      signal,
      timeout: options.timeout,
    });
    expect(output).toEqual({
      content: [{ type: "text", text: "stats" }],
      details: { exitCode: 0, stdout: "stats", stdoutTruncated: false },
    });
  });

  it("accepts configured exit codes and empty-output text", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue(result("", "", 1));
    const output = await runCommand({ exec }, "sg", [], {
      ...options,
      okCodes: [0, 1],
      emptyOutput: "(no matches)",
    });
    expect(output.content[0]?.text).toBe("(no matches)");
    expect(output.details.exitCode).toBe(1);
  });

  it.each(["line\n".repeat(2500), "界".repeat(20000), "x".repeat(DEFAULT_MAX_BYTES)])(
    "bounds successful output and keeps a recoverable copy (%#)",
    async (stdout) => {
      const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue(result(stdout));
      const output = await runCommand({ exec }, "bat", [], options);
      expectBounded(output.content[0].text);
      if (output.details.fullOutputPath) {
        expect(output.details.fullOutputPath).toContain(outputDirectory);
        expect(savedOutput(output.details.fullOutputPath)).toBe(stdout);
      } else {
        expect(output.content[0]?.text).toBe(stdout);
      }
    },
  );

  it.each(["stderr", "stdout", "spawn"])(
    "bounds and preserves large %s failures and argv",
    async (kind) => {
      const output = "failure\n".repeat(10000);
      const input = JSON.stringify({ data: "x".repeat(100000) });
      const exec = vi.fn<ExtensionAPI["exec"]>(async () => {
        if (kind === "spawn") throw new Error(output);
        return result(kind === "stdout" ? output : "", kind === "stderr" ? output : "", 2);
      });
      const error = await runCommand({ exec }, "jq", [".", input], options).catch(
        (error: unknown) => error,
      );
      if (!(error instanceof Error)) throw new Error("Expected the command to fail with an Error");
      const message = error.message;
      expectBounded(message);
      const saved = savedOutput(message.match(/Full output saved to: (.+)\]/)?.[1]);
      expect(saved).toContain(output.trim());
      expect(saved).toContain(input);
    },
  );

  it.each(["", "data\n"])("preserves successful stderr alongside stdout: %j", async (stdout) => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue(result(stdout, "warning"));
    const output = await runCommand({ exec }, "gh", [], options);
    expect(output.content[0].text).toBe(`[stderr]\nwarning\n\n[stdout]\n${stdout}`);
    expect(output.details.stdout).toBe(stdout);
    expect(output.details.exitCode).toBe(0);
  });

  it.each(["warning", "warning\n".repeat(3000)])(
    "bounds and recovers both output streams (%#)",
    async (stderr) => {
      const stdout = "data\n".repeat(3000);
      const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue(result(stdout, stderr));
      const output = await runCommand({ exec }, "gh", [], options);
      expectBounded(output.content[0].text);
      expectBounded(output.details.stdout);
      expect(output.content[0].text).toContain("[stderr]\nwarning");
      expect(savedOutput(output.details.fullOutputPath)).toBe(
        `[stderr]\n${stderr}\n\n[stdout]\n${stdout}`,
      );
    },
  );

  it("retries transient spawn failures", async () => {
    const exec = vi
      .fn<ExtensionAPI["exec"]>()
      .mockRejectedValueOnce(new Error("spawn EAGAIN"))
      .mockResolvedValue(result("stats"));
    expect((await runCommand({ exec }, "scc", [], options)).content[0]?.text).toBe("stats");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("stops after two transient retries", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockRejectedValue(new Error("spawn EMFILE"));
    await expect(runCommand({ exec }, "bat", [], options)).rejects.toThrow("spawn EMFILE");
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("does not retry a command that ran and reported a transient-looking error", async () => {
    const exec = vi
      .fn<ExtensionAPI["exec"]>()
      .mockResolvedValue(result("", "EAGAIN after mutation", 2));
    await expect(runCommand({ exec }, "sd", [], options)).rejects.toThrow("exit 2");
    expect(exec).toHaveBeenCalledOnce();
  });

  it("rejects killed commands even if their exit code is accepted", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ ...result(), killed: true });
    await expect(runCommand({ exec }, "sd", [], options)).rejects.toThrow("killed or timed out");
  });

  it("does not spawn after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = vi.fn<ExtensionAPI["exec"]>();
    await expect(
      runCommand({ exec }, "sd", [], { ...options, signal: controller.signal }),
    ).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  it("cancels retry backoff without another spawn", async () => {
    const controller = new AbortController();
    const exec = vi.fn<ExtensionAPI["exec"]>(async () => {
      controller.abort();
      throw new Error("spawn EAGAIN");
    });
    await expect(
      runCommand({ exec }, "sd", [], { ...options, signal: controller.signal }),
    ).rejects.toThrow();
    expect(exec).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "coordinates mutations with Pi's queue (cancelled=%s)",
    async (cancelled) => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-command-queue-"));
      cleanup.add(cwd);
      const path = join(cwd, "file.txt");
      writeFileSync(path, "original");
      const entered = deferred();
      const release = deferred();
      const holder = withFileMutationQueue(path, async () => {
        entered.resolve();
        await release.promise;
        writeFileSync(path, "first mutation");
      });
      await entered.promise;
      const controller = new AbortController();
      const exec = vi.fn<ExtensionAPI["exec"]>(async () => {
        expect(readFileSync(path, "utf8")).toBe("first mutation");
        return result();
      });
      const pending = runCommand({ exec }, "sd", [], {
        ...options,
        cwd,
        mutationPath: "file.txt",
        signal: controller.signal,
      });
      expect(exec).not.toHaveBeenCalled();
      if (cancelled) controller.abort();
      release.resolve();
      // Attach the rejection handler before yielding to the released queue.
      if (cancelled) {
        await expect(pending).rejects.toThrow();
      } else {
        await expect(pending).resolves.toMatchObject({ details: { exitCode: 0 } });
      }
      await holder;
      expect(exec).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    },
  );

  it("supplies diagnostics when a command fails silently", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue(result("", "", 2));
    await expect(runCommand({ exec }, "bat", [], options)).rejects.toThrow(
      "bat exited with code 2",
    );
  });
});
