import childProcess, * as childProcessNamespace from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join } from "node:path";
import { ACTIVE_JOB_PROBE_HELPER_COMMAND } from "../../src/windows-job-process-host.js";

type Case = "healthy-active-job" | "prepared-active-job" | "restored-active-job";
type Fact = Readonly<Record<string, unknown>>;
const MAX_CALLS = 8;
const MAX_FAULTS = 8;
const MAX_REPORT_BYTES = 16 * 1024;

/** Disabled: no I/O, builtin patch, or additional Promise boundary. */
export function withWindowsJobProbeObserver(caseId: Case, action: () => Promise<void>): Promise<void> {
  if (process.env.RUNNER_V2_SEMANTIC_PROBE_OBSERVER !== "1") return action();
  return observe(caseId, action);
}

/** Test-only observation of the existing default call, never a certification. */
async function observe(caseId: Case, action: () => Promise<void>): Promise<void> {
  const wrapperStartedAt = Date.now();
  const calls: Fact[] = [];
  const faults: unknown[] = [];
  let faultCount = 0;
  let droppedCalls = 0;
  let nativeCalls = 0;
  let directory: string | undefined;
  let wrapperFailed = false;
  let actionInvoked = false;
  let wrapperError: unknown;
  let restore: (() => void) | undefined;
  let builtinRestored = false;
  let namedExportRestored = false;
  let wrapperCompletedAt: number | undefined;
  const fault = (error: unknown) => {
    faultCount++;
    if (faults.length < MAX_FAULTS) faults.push(error);
  };
  const guard = (operation: () => void) => { try { operation(); } catch (error) { fault(error); } };
  const commandDigest = createHash("sha256").update(ACTIVE_JOB_PROBE_HELPER_COMMAND).digest("hex");
  try {
    const root = process.env.RUNNER_V2_QUALIFICATION_EVIDENCE_ROOT;
    if (!root || !isAbsolute(root)) throw new Error("Job observer requires an absolute evidence root.");
    mkdirSync(root, { recursive: true });
    const canonicalRoot = realpathSync.native(root);
    const rootStat = lstatSync(canonicalRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Job observer evidence root is not a canonical directory.");
    directory = join(canonicalRoot, "job-probe-" + caseId);
    // Unique fixed case leaf, no existing/symlink destination adoption.
    mkdirSync(directory);
    writeFileSync(join(directory, "marker.json"), JSON.stringify({
      schema: "runner-v2-job-probe-observer-v1", caseId,
      observationOnly: true, nativeCertification: false,
      commandSha256: commandDigest,
    }) + "\n", { flag: "wx" });

    const descriptor = Object.getOwnPropertyDescriptor(childProcess, "spawnSync");
    if (!descriptor || typeof descriptor.value !== "function") throw new Error("Job observer requires the existing spawnSync data descriptor.");
    const original = descriptor.value as (...args: unknown[]) => unknown;
    const originalNamed = childProcessNamespace.spawnSync;
    if (originalNamed !== original) throw new Error("Job observer refuses divergent builtin and named spawnSync exports.");
    // Establish restoration before attempting mutation or named-export sync.
    restore = () => {
      Object.defineProperty(childProcess, "spawnSync", descriptor);
      builtinRestored = Object.getOwnPropertyDescriptor(childProcess, "spawnSync")?.value === original;
      syncBuiltinESMExports();
      namedExportRestored = childProcessNamespace.spawnSync === originalNamed;
      if (!builtinRestored || !namedExportRestored) throw new Error("Job observer builtin restoration could not be verified.");
    };
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      let matched = false;
      guard(() => { matched = matchesDefaultCommand(args); });
      if (!matched) return Reflect.apply(original, this, args);
      const startedAt = Date.now();
      nativeCalls++;
      let result: unknown;
      let thrown: unknown;
      let didThrow = false;
      try { result = Reflect.apply(original, this, args); }
      catch (error) { didThrow = true; thrown = error; }
      const endedAt = Date.now();
      guard(() => {
        if (calls.length >= MAX_CALLS) { droppedCalls++; return; }
        const options = args[2] as Record<string, unknown> | undefined;
        const returned = result as Record<string, unknown> | undefined;
        calls.push({
          ordinal: nativeCalls,
          startedUtc: new Date(startedAt).toISOString(), endedUtc: new Date(endedAt).toISOString(),
          startOffsetMs: startedAt - wrapperStartedAt, elapsedMs: endedAt - startedAt,
          commandSha256: commandDigest,
          requestedTimeoutMs: scalar(options?.timeout), requestedKillSignal: scalar(options?.killSignal),
          stdio: stdioFact(options?.stdio),
          // Ignored streams cannot supply diagnostic stderr; no pipe change.
          stderrAvailable: false, stderrUnavailableReason: "Original default invocation ignores stderr.",
          didThrow,
          ...(didThrow ? { thrown: errorFact(thrown) } : {
            status: scalar(returned?.status), signal: scalar(returned?.signal),
            error: returned?.error === undefined ? null : errorFact(returned.error),
          }),
        });
      });
      if (didThrow) throw thrown;
      return result;
    };
    Object.defineProperty(childProcess, "spawnSync", { ...descriptor, value: wrapper });
    syncBuiltinESMExports();
    if (childProcessNamespace.spawnSync !== wrapper) throw new Error("Job observer named export installation failed.");
    actionInvoked = true;
    await action();
  } catch (error) {
    wrapperFailed = true;
    wrapperError = error;
  } finally {
    if (restore) guard(restore);
    wrapperCompletedAt = Date.now();
  }
  if (droppedCalls) fault(new Error("Job observer call ledger overflowed; observation is incomplete."));
  // Complete observer wrapper time; setup failure can prevent the original body.
  guard(() => {
  const report = {
    schema: "runner-v2-job-probe-observer-v1", caseId,
    observationOnly: true, nativeCertification: false,
    commandSha256: commandDigest,
    wrapperStartedUtc: new Date(wrapperStartedAt).toISOString(),
    wrapperCompletedUtc: new Date(wrapperCompletedAt).toISOString(),
    wrapperElapsedMs: wrapperCompletedAt - wrapperStartedAt,
    timingScope: "Observer setup, optionally invoked original body, and restoration; ends before report publication. Not isolated preparation or compiler timing.",
    nativeBoundaryReached: nativeCalls > 0, nativeCalls, calls,
    limits: { maxCalls: MAX_CALLS, maxFaults: MAX_FAULTS, maxReportBytes: MAX_REPORT_BYTES },
    droppedCalls, faultCount, retainedFaults: faults.map(errorFact),
    actionInvoked,
    failureScope: wrapperFailed ? (actionInvoked ? "original-action" : "observer-setup-or-installation") : null,
    wrapperFailed, wrapperError: wrapperFailed ? errorFact(wrapperError) : null,
    builtinRestored, namedExportRestored,
    overhead: "Enabled wrapper adds bounded bookkeeping, hashing and artifact I/O; no zero-overhead claim.",
  };
    if (!directory) throw new Error("Job observer has no initialized evidence directory.");
    const bytes = Buffer.from(JSON.stringify(report, null, 2) + "\n", "utf8");
    if (bytes.byteLength > MAX_REPORT_BYTES) throw new Error("Job observer report exceeds its publication bound.");
    writeFileSync(join(directory, "observation.json"), bytes, { flag: "wx" });
  });
  const errors = [...(wrapperFailed ? [wrapperError] : []), ...faults];
  if (faultCount > faults.length) errors.push(new Error("Additional Job observer faults were dropped: " + (faultCount - faults.length)));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Original Job probe body and/or observation failed; original error objects retained.");
}

function matchesDefaultCommand(args: unknown[]): boolean {
  const expected = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ACTIVE_JOB_PROBE_HELPER_COMMAND];
  return args[0] === "powershell.exe" && Array.isArray(args[1])
    && args[1].length === expected.length && args[1].every((value, index) => value === expected[index]);
}

function scalar(value: unknown): string | number | boolean | null | Fact {
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string") return value.slice(0, 160);
  return { unavailable: true, type: typeof value };
}

function stdioFact(value: unknown): Fact {
  if (!Array.isArray(value)) return { unavailable: true };
  return { stdin: scalar(value[0]), stdout: scalar(value[1]), stderr: scalar(value[2]) };
}

function errorFact(error: unknown): Fact {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return { kind: typeof error, isNull: error === null };
  const entry = error as Record<string, unknown>;
  const message = typeof entry.message === "string" ? entry.message : undefined;
  const prefix = message?.slice(0, 4096);
  return {
    name: scalar(entry.name), code: scalar(entry.code), errno: scalar(entry.errno), syscall: scalar(entry.syscall),
    ...(prefix === undefined ? { messageUnavailable: true } : {
      messageLengthCodeUnits: message!.length, hashedPrefixCodeUnits: prefix.length,
      messagePrefixSha256: createHash("sha256").update(prefix).digest("hex"),
      messageHashScope: message!.length > prefix.length ? "First 4096 code units only." : "Entire message.",
    }),
  };
}
