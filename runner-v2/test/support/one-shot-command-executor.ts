import { spawn } from "node:child_process";

import type { OneShotCommandExecutor } from "../../src/one-shot-command-executor.js";

/** Test-only native fixture. Production command families may never use this path. */
export function createTestOneShotCommandExecutor(): OneShotCommandExecutor {
  return {
    execute: async (request) => await new Promise((resolve) => {
      const child = spawn(request.executable, [...request.arguments], {
        cwd: request.workingDirectory,
        env: { ...process.env, ...(request.explicitEnvironment ?? {}) },
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const stop = () => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          });
          killer.unref();
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch {}
        }
        try { child.kill("SIGKILL"); } catch {}
      };
      const abort = () => { cancelled = true; stop(); };
      request.context.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; stop(); }, request.timeoutMs);
      timer.unref();
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.context.signal?.removeEventListener("abort", abort);
        const output = [
          disposition("stdout", Buffer.concat(stdout)),
          disposition("stderr", Buffer.concat(stderr)),
        ];
        resolve({
          process: {
            logicalProcessId: `test-${request.context.callId}`,
            outcome: timedOut ? "timed_out" : cancelled ? "cancelled" : "exited",
            ...(exitCode === null ? {} : { exitCode }),
            ...(signal ? { signal } : {}),
            finishedAt: new Date().toISOString(),
            output,
            cleanup: { state: "verified_empty", verifiedAt: new Date().toISOString() },
          },
          enforcement: "unconfined_explicit_full",
          disclosure: "unconfined_explicit_full",
        });
      };
      child.once("error", () => finish(null, null));
      child.once("close", finish);
    }),
  };
}

function disposition(stream: "stdout" | "stderr", bytes: Buffer) {
  return {
    stream,
    tail: bytes.toString("utf8"),
    totalBytes: bytes.byteLength,
    truncated: false,
    spillBytes: 0,
    lossyBytes: 0,
  } as const;
}
