import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { snapshotNativeBuildAmbientEnvironment } from "../../src/native-build-factory.js";
import { minimalWindowsSemanticProbeEnvironment } from "../../src/windows-process-semantic-probes.js";

export interface WindowsFixtureJob {
  readonly pid: number;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export function normalizeFixtureWindowsEnvironment(input: NodeJS.ProcessEnv): Record<string, string> {
  const entries = new Map<string, [string, string]>();
  for (const [key, value] of Object.entries(input)) if (value !== undefined) entries.set(key.toLowerCase(), [key, value]);
  return Object.fromEntries(entries.values());
}

/** Test infrastructure only. Its private pipe and native Job HANDLE own the
 * synthetic supervisor plus every descendant from suspended process creation.
 * This containment is NOT a product-backend capability or a substitute for the
 * product assertions. It permits safe disposal of intentionally broken probes.
 */
export function observeWindowsFixtureJob(child: ChildProcessWithoutNullStreams, options: {
  startupTimeoutMs: number; closeTimeoutMs: number; record(event: unknown): void;
}): Promise<WindowsFixtureJob> {
  const failures: unknown[] = [];
  let pid: number | undefined;
  let proof = false;
  let didClose = false;
  let resolveStarted!: () => void;
  let resolveClosed!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let closing: Promise<void> | undefined;
  const lines = createInterface({ input: child.stdout });
  const fail = (message: string) => failures.push(new Error(message));
  lines.on("line", (line) => {
    try {
      if (line.length > 16_384) throw new Error("Fixture Job record exceeded its bound.");
      const event = JSON.parse(line) as { type: string; pid: number; activeProcesses: number; error: unknown };
      if (!Number.isSafeInteger(event.pid) || event.pid <= 0 || !Number.isSafeInteger(event.activeProcesses) || event.activeProcesses < 0)
        throw new Error("Fixture Job record identity/count is invalid.");
      options.record({ type: event.type, pid: event.pid, activeProcesses: event.activeProcesses, hasError: event.error !== null });
      if (event.type === "started") {
        if (pid !== undefined) throw new Error("Fixture Job duplicated startup identity.");
        pid = event.pid; resolveStarted();
      } else {
        if (pid !== event.pid) throw new Error("Fixture Job terminal identity differs from its acquired root.");
        if (event.type === "stopped" || event.type === "natural_stopped") {
          if (event.activeProcesses !== 0 || event.error !== null) throw new Error("Fixture Job did not prove empty.");
          proof = true;
        } else if (event.type === "error") throw new Error("Fixture Job reported a native ownership failure.");
        else if (event.type !== "root_exited") throw new Error("Fixture Job emitted an unsupported record.");
      }
    } catch (error) { failures.push(error); }
  });
  child.stderr.on("data", (bytes) => {
    // Keep private diagnostics local, and never confuse stderr with a certificate.
    options.record({ type: "host-stderr", byteLength: Buffer.byteLength(bytes) });
  });
  child.on("error", (error) => { failures.push(error); });
  child.stdin.on("error", (error) => { if (!proof) failures.push(error); });
  child.once("close", (code, signal) => {
    didClose = true;
    if (code !== 0 || signal !== null) fail("Fixture Job host close was not successful.");
    options.record({ type: "host-close", code, signal, proof });
    resolveClosed(); resolveStarted(); lines.close();
  });
  const certify = () => {
    if (!proof) fail("Fixture Job zero-member proof is missing.");
    if (failures.length) throw new AggregateError(failures, "Fixture Job cleanup remains unverified; retain its exact root.");
  };
  const close = (): Promise<void> => closing ??= (async () => {
    if (!didClose && !proof) child.stdin.write(JSON.stringify({ deadlineMs: options.closeTimeoutMs }) + "\n");
    await bounded(closed, options.closeTimeoutMs + 25, "Fixture Job host close remains unconfirmed after its deadline.");
    certify();
  })();
  return (async () => {
    try {
      await bounded(started, options.startupTimeoutMs, "Fixture Job startup deadline expired.");
      if (pid === undefined || failures.length) throw new AggregateError(failures, "Fixture Job startup identity was not established.");
      return Object.freeze({ pid, closed, close });
    } catch (primary) {
      // Closing this retained pipe invokes native Job containment. It never
      // enumerates, kills or adopts a numeric process/tree as a fallback.
      if (!didClose) child.stdin.end();
      try { await bounded(closed, options.closeTimeoutMs + 25, "Fixture Job failed-start close remains unconfirmed."); }
      catch (cleanup) { throw new AggregateError([primary, cleanup], "Fixture Job startup and cleanup failed; evidence retained."); }
      throw primary;
    }
  })();
}

export async function spawnContainedWindowsFixture(root: string, command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; windowsHide?: boolean; stdio?: unknown } = {}): Promise<WindowsFixtureJob> {
  if (process.platform !== "win32") throw new Error("The Windows fault-fixture containment helper is Windows-only.");
  const helper = fileURLToPath(new URL("../../src/managed-process-job-host.ps1", import.meta.url));
  const ambientEnvironment = snapshotNativeBuildAmbientEnvironment();
  const fixtureEnvironment = minimalWindowsSemanticProbeEnvironment(ambientEnvironment);
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: fixtureEnvironment,
  });
  const opening = observeWindowsFixtureJob(child, { startupTimeoutMs: 15_000, closeTimeoutMs: 15_000,
    record: (event) => appendFileSync(join(root, "fixture-job-events.jsonl"), JSON.stringify(event) + "\n"),
  });
  child.stderr.on("data", (bytes) => appendFileSync(join(root, "fixture-job-host.stderr.log"), bytes));
  const productionSupervisor = fileURLToPath(new URL("../../src/portable-process-supervisor.mjs", import.meta.url));
  const launchedArgs = args[0] === productionSupervisor
    ? [fileURLToPath(new URL("./windows-fixture-supervisor.mjs", import.meta.url)), root, ...args]
    : args;
  child.stdin.write(JSON.stringify({ command, args: launchedArgs, cwd: options.cwd ?? process.cwd(), env: normalizeFixtureWindowsEnvironment(options.env ?? fixtureEnvironment),
    stdoutPath: join(root, "fixture-job-stdout.log"), stderrPath: join(root, "fixture-job-stderr.log") }) + "\n");
  return await opening;
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
