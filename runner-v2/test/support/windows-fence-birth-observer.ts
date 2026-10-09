import childProcess, * as childProcessNamespace from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join } from "node:path";

const CASE = "legacy-fence-first-self-birth";
const MAX_CALLS = 8;
const MAX_FAULTS = 8;
const MAX_REPORT_BYTES = 16 * 1024;
type Fact = Readonly<Record<string, unknown>>;

/** Preserve synchronous action/return/throw; disabled and non-Windows do no I/O or patching. */
export function withWindowsFenceBirthObserver<T>(action: () => T): T {
  if (process.env.RUNNER_V2_SEMANTIC_PROBE_OBSERVER !== "1" || process.platform !== "win32") return action();
  return observe(action);
}

function observe<T>(action: () => T): T {
  const startedAt = Date.now();
  const command = `$ErrorActionPreference='Stop';$p=Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue;if($null -eq $p){'ABSENT'}else{'PRESENT:'+$p.StartTime.ToUniversalTime().ToString('o')}`;
  const commandSha256 = createHash("sha256").update(command).digest("hex");
  const calls: Fact[] = [];
  const faults: unknown[] = [];
  let faultCount = 0;
  let nativeCalls = 0;
  let droppedCalls = 0;
  let directory: string | undefined;
  let actionInvoked = false;
  let wrapperFailed = false;
  let wrapperError: unknown;
  let actionResult!: T;
  let restore: (() => void) | undefined;
  let builtinRestored = false;
  let namedExportRestored = false;
  let completedAt = startedAt;
  const fault = (error: unknown) => { faultCount++; if (faults.length < MAX_FAULTS) faults.push(error); };
  const guard = (operation: () => void) => { try { operation(); } catch (error) { fault(error); } };
  try {
    const root = process.env.RUNNER_V2_QUALIFICATION_EVIDENCE_ROOT;
    if (!root || !isAbsolute(root)) throw new Error("Fence birth observer requires an absolute evidence root.");
    mkdirSync(root, { recursive: true });
    const canonicalRoot = realpathSync.native(root);
    const rootStat = lstatSync(canonicalRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Fence birth observer requires a canonical directory.");
    directory = join(canonicalRoot, CASE);
    mkdirSync(directory);
    writeFileSync(join(directory, "marker.json"), JSON.stringify({
      schema: "runner-v2-fence-birth-observer-v1", caseId: CASE,
      observationOnly: true, ownershipAuthority: false, commandSha256,
    }) + "\n", { flag: "wx" });
    const descriptor = Object.getOwnPropertyDescriptor(childProcess, "execFileSync");
    if (!descriptor || typeof descriptor.value !== "function") throw new Error("Fence birth observer requires the existing execFileSync data descriptor.");
    const original = descriptor.value as (...args: unknown[]) => unknown;
    const originalNamed = childProcessNamespace.execFileSync;
    if (originalNamed !== original) throw new Error("Fence birth observer refuses divergent builtin and named exports.");
    restore = () => {
      Object.defineProperty(childProcess, "execFileSync", descriptor);
      builtinRestored = Object.getOwnPropertyDescriptor(childProcess, "execFileSync")?.value === original;
      syncBuiltinESMExports();
      namedExportRestored = childProcessNamespace.execFileSync === originalNamed;
      if (!builtinRestored || !namedExportRestored) throw new Error("Fence birth observer export restoration is unverified.");
    };
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      let matches = false;
      guard(() => {
        const expected = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
        matches = args[0] === "powershell.exe" && Array.isArray(args[1])
          && args[1].length === expected.length && args[1].every((value, index) => value === expected[index]);
      });
      if (!matches) return Reflect.apply(original, this, args);
      const start = Date.now();
      nativeCalls++;
      let result: unknown;
      let thrown: unknown;
      let didThrow = false;
      try { result = Reflect.apply(original, this, args); }
      catch (error) { didThrow = true; thrown = error; }
      const end = Date.now();
      guard(() => {
        if (calls.length >= MAX_CALLS) { droppedCalls++; return; }
        const options = args[2] as Record<string, unknown> | undefined;
        calls.push({
          ordinal: nativeCalls, startedUtc: new Date(start).toISOString(), endedUtc: new Date(end).toISOString(),
          startOffsetMs: start - startedAt, elapsedMs: end - start, commandSha256,
          requestedTimeoutMs: scalar(options?.timeout), requestedKillSignal: scalar(options?.killSignal),
          requestedEncoding: scalar(options?.encoding), explicitStdio: options?.stdio !== undefined,
          didThrow,
          ...(didThrow ? { returned: false, thrown: errorFact(thrown) } : {
            returned: true, exitStatusAvailable: false,
            exitStatusUnavailableReason: "execFileSync returns output, not a raw process result.",
            output: outputFact(result),
          }),
        });
      });
      if (didThrow) throw thrown;
      return result;
    };
    Object.defineProperty(childProcess, "execFileSync", { ...descriptor, value: wrapper });
    syncBuiltinESMExports();
    if (childProcessNamespace.execFileSync !== wrapper) throw new Error("Fence birth observer named export installation failed.");
    actionInvoked = true;
    actionResult = action();
  } catch (error) {
    wrapperFailed = true;
    wrapperError = error;
  } finally {
    if (restore) guard(restore);
    completedAt = Date.now();
  }
  if (droppedCalls) fault(new Error("Fence birth observer call ledger overflowed; observation is incomplete."));
  guard(() => {
    if (!directory) throw new Error("Fence birth observer has no initialized artifact directory.");
    const report = {
      schema: "runner-v2-fence-birth-observer-v1", caseId: CASE,
      observationOnly: true, ownershipAuthority: false, commandSha256,
      wrapperStartedUtc: new Date(startedAt).toISOString(), wrapperCompletedUtc: new Date(completedAt).toISOString(),
      wrapperElapsedMs: completedAt - startedAt,
      timingScope: "Observer setup, optionally invoked original synchronous body and restoration; ends before publication. Not isolated PowerShell startup timing.",
      actionInvoked, failureScope: wrapperFailed ? (actionInvoked ? "original-action" : "observer-setup-or-installation") : null,
      wrapperFailed, wrapperError: wrapperFailed ? errorFact(wrapperError) : null,
      nativeBoundaryReached: nativeCalls > 0, nativeCalls, calls,
      limits: { maxCalls: MAX_CALLS, maxFaults: MAX_FAULTS, maxReportBytes: MAX_REPORT_BYTES, maxOutputPrefixUnits: 4096 },
      droppedCalls, faultCount, retainedFaults: faults.map(errorFact), builtinRestored, namedExportRestored,
      overhead: "Enabled observation adds bounded bookkeeping, hashing and artifact I/O; no zero-overhead claim.",
    };
    const bytes = Buffer.from(JSON.stringify(report, null, 2) + "\n", "utf8");
    if (bytes.byteLength > MAX_REPORT_BYTES) throw new Error("Fence birth observer report exceeds its publication bound.");
    writeFileSync(join(directory, "observation.json"), bytes, { flag: "wx" });
  });
  const errors = [...(wrapperFailed ? [wrapperError] : []), ...faults];
  if (faultCount > faults.length) errors.push(new Error("Additional fence birth observer faults were dropped: " + (faultCount - faults.length)));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Original synchronous fence body and/or observer failed; original error objects retained.");
  return actionResult;
}

function scalar(value: unknown): string | number | boolean | null | Fact {
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string") return value.slice(0, 160);
  return { unavailable: true, type: typeof value };
}

function outputFact(value: unknown): Fact {
  if (typeof value === "string") {
    const prefix = value.slice(0, 4096);
    return { type: "string", lengthCodeUnits: value.length, hashedPrefixCodeUnits: prefix.length,
      prefixSha256: createHash("sha256").update(prefix).digest("hex"),
      hashScope: prefix.length === value.length ? "Entire string." : "First 4096 code units only." };
  }
  if (Buffer.isBuffer(value)) {
    const prefix = value.subarray(0, 4096);
    return { type: "buffer", byteLength: value.byteLength, hashedPrefixBytes: prefix.byteLength,
      prefixSha256: createHash("sha256").update(prefix).digest("hex"),
      hashScope: prefix.byteLength === value.byteLength ? "Entire buffer." : "First 4096 bytes only." };
  }
  return { unavailable: true, type: typeof value };
}

function errorFact(error: unknown): Fact {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return { kind: typeof error, isNull: error === null };
  const entry = error as Record<string, unknown>;
  return {
    name: scalar(entry.name), code: scalar(entry.code), errno: scalar(entry.errno), syscall: scalar(entry.syscall),
    status: scalar(entry.status), signal: scalar(entry.signal),
    message: outputFact(entry.message), stdout: outputFact(entry.stdout), stderr: outputFact(entry.stderr),
  };
}
