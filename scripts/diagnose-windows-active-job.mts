// Manual experiment: user-authorized longer bound, no warmup/retry/workload.
import assert from "node:assert/strict";
import childProcess, { type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { createWindowsJobProcessHost } from "../runner-v2/src/windows-job-process-host.js";

const verifyOnly = process.argv.includes("--verify-only");
assert(verifyOnly || process.platform === "win32", "Native diagnostic requires Windows.");
const rootInput = process.env.RUNNER_V2_ACTIVE_JOB_DIAGNOSTIC_ROOT;
assert(rootInput && isAbsolute(rootInput), "Explicit absolute fresh diagnostic root required.");
const root = resolve(rootInput);
assert(!existsSync(root), "Diagnostic root is already spent.");
mkdirSync(root, { recursive: true });
const experimentDeadlineMs = 5_000;
const originalSpawn = childProcess.spawnSync;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let callCount = 0;
let transport: SpawnSyncReturns<string | Buffer> | undefined;
let commandDigest: string | undefined;
let elapsedMs: number | undefined;
let originalDeadlineMs: number | undefined;
let probeResult = false;
let failure: unknown;
writeFileSync(join(root, "started.json"), JSON.stringify({ verifyOnly, pid: process.pid, node: process.version }));
try {
  if (verifyOnly) Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
  childProcess.spawnSync = ((executable: string, args: string[], options: SpawnSyncOptions) => {
    assert.equal(++callCount, 1, "Exactly one probe invocation permitted.");
    assert.equal(executable, "powershell.exe");
    assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    assert.equal(args.length, 5);
    assert([2_000, 5_000].includes(options.timeout!), "Only reviewed product deadlines are supported.");
    originalDeadlineMs = options.timeout;
    assert.equal(options.killSignal, "SIGKILL");
    assert.equal(options.windowsHide, true);
    assert.equal(options.stdio, "ignore");
    commandDigest = createHash("sha256").update(args[4]!).digest("hex");
    writeFileSync(join(root, "original-command.ps1"), args[4]!);
    const experimentOptions = { ...options, timeout: experimentDeadlineMs };
    assert.deepEqual({ ...experimentOptions, timeout: options.timeout }, options);
    const started = performance.now();
    transport = verifyOnly ? { pid: 0, status: 0, signal: null, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
      : Reflect.apply(originalSpawn, childProcess, [executable, args, experimentOptions]);
    elapsedMs = performance.now() - started;
    return transport;
  }) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  probeResult = await createWindowsJobProcessHost({ stateDirectory: join(root, "host"), platform: "win32" }).probeActiveJobCreateClose();
  assert.equal(callCount, 1);
} catch (error) { failure = error; }
finally {
  childProcess.spawnSync = originalSpawn;
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", originalPlatform);
  const summary = { verifyOnly, node: process.version, callCount, probeResult, commandDigest, elapsedMs,
    originalDeadlineMs, experimentDeadlineMs, status: transport?.status, signal: transport?.signal,
    errorCode: (transport?.error as NodeJS.ErrnoException | undefined)?.code,
    failure: failure instanceof Error ? { name: failure.name, message: failure.message, stack: failure.stack } : failure,
    limitation: "The experimental deadline is fixed at 5s; originalDeadlineMs records the product bound. Command and all other options are unchanged. No workload assigned. Standalone completion is not factory/platform/T8 qualification; verify-only uses simulated transport and executes no native call." };
  writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
if (failure) throw failure;
if (!verifyOnly && !probeResult) process.exitCode = 1;
