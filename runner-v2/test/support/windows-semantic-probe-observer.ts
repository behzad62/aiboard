import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync,
  readSync, realpathSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { BackpressuredInteractiveProcessChannelProvider } from "../../src/interactive-process-channel.js";
import { parseProcessLaunchResult, parseProcessReconciliation, type ProcessLaunchRequest } from "../../src/process-backend.js";
import { WindowsProcessBackend } from "../../src/windows-process-backend.js";

const CASE = "live-windows-portable-semantic-probes";
const MAX_CALLS = 64;
const MAX_ENTRIES = 64;
const MAX_READ_BYTES = 32 * 1024;
const MAX_ARTIFACT_BYTES = 128 * 1024;

type Fact = Readonly<Record<string, unknown>>;
type Call = { kind: string; startMs: number; remainingMs?: number; endMs?: number; result?: Fact };
type Counter = { chunks: number; bytes: number; firstMs?: number; lastMs?: number; lastDigest?: string };
type Channel = Awaited<ReturnType<BackpressuredInteractiveProcessChannelProvider["acquire"]>>;
type Batch = {
  root: string; deadline?: number; identity?: string; directory?: string;
  launch?: Fact; lastReconcile?: Fact; channel?: Channel;
};

/** Disabled: no observer I/O, patching, or extra Promise boundary. */
export function withWindowsSemanticProbeObserver(action: () => Promise<void>): Promise<void> {
  if (process.env.RUNNER_V2_SEMANTIC_PROBE_OBSERVER !== "1") return action();
  return observe(action);
}

async function observe(action: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  const calls: Call[] = [];
  const faults: unknown[] = [];
  const restores: Array<() => void> = [];
  const batches = new WeakMap<WindowsProcessBackend, Batch>();
  const stdout: Counter = { chunks: 0, bytes: 0 };
  const stderr: Counter = { chunks: 0, bytes: 0 };
  let droppedCalls = 0;
  let batch: Batch | undefined;
  let snapshot: Fact | undefined;
  let captureAttempted = false;
  let evidenceDirectory: string | undefined;
  let primary: unknown;
  let failed = false;
  let restored = 0;
  const now = () => Date.now() - startedAt;
  const guard = (operation: () => void) => { try { operation(); } catch (error) { faults.push(error); } };
  const counters = () => ({ stdout: { ...stdout }, stderr: { ...stderr } });
  const addCall = (kind: string, context?: Batch): Call => {
    const call: Call = { kind, startMs: now(), ...(context?.deadline === undefined ? {} : { remainingMs: context.deadline - Date.now() }) };
    if (calls.length === MAX_CALLS) { calls.shift(); droppedCalls++; }
    calls.push(call);
    return call;
  };
  // Attach fulfilled/rejected observers, but return the exact original Promise.
  // Both handlers contain observation faults; their derived Promise cannot reject.
  const watch = <T>(kind: string, context: Batch, invoke: () => Promise<T>, fact: (value: T) => Fact): Promise<T> => {
    let call: Call | undefined;
    guard(() => { call = addCall(kind, context); });
    let result: Promise<T>;
    try { result = invoke(); }
    catch (error) {
      guard(() => { if (call) { call.endMs = now(); call.result = { error: errorFact(error) }; } });
      throw error;
    }
    void result.then(
      (value) => guard(() => {
        const valueFact = fact(value);
        if (call) { call.endMs = now(); call.result = valueFact; }
      }),
      (error) => guard(() => { if (call) { call.endMs = now(); call.result = { error: errorFact(error) }; } }),
    );
    return result;
  };
  const patch = (target: object, name: string, replacement: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    restores.push(() => {
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else if (!Reflect.deleteProperty(target, name)) throw new Error("Semantic observer descriptor restoration failed: " + name);
      restored++;
    });
    Object.defineProperty(target, name, descriptor
      ? { ...descriptor, value: replacement }
      : { configurable: true, writable: true, enumerable: false, value: replacement });
  };
  const installChannel = (channel: Channel, context: Batch) => {
    const subscribe = channel.subscribeBackpressuredOutput;
    patch(channel, "subscribeBackpressuredOutput", function (this: Channel, sink: Parameters<Channel["subscribeBackpressuredOutput"]>[0]) {
      return subscribe.call(this, function (metadata, bytes) {
        guard(() => {
          const counter = metadata.stream === "stdout" ? stdout : stderr;
          const at = now();
          counter.chunks++; counter.bytes += bytes.byteLength;
          counter.firstMs ??= at; counter.lastMs = at;
          counter.lastDigest = createHash("sha256").update(bytes).digest("hex");
        });
        return watch("output_sink", context, () => sink(metadata, bytes), (acknowledgement) => ({
          stream: metadata.stream, sequence: metadata.sequence, byteLength: bytes.byteLength,
          acknowledgementMatchesMetadata: JSON.stringify(acknowledgement) === JSON.stringify(metadata),
        }));
      });
    });
  };
  try {
    const evidenceRoot = process.env.RUNNER_V2_QUALIFICATION_EVIDENCE_ROOT;
    if (!evidenceRoot || !isAbsolute(evidenceRoot)) throw new Error("Semantic observer requires an absolute evidence root.");
    evidenceDirectory = join(resolve(evidenceRoot), CASE);
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(join(evidenceDirectory, "marker.json"), JSON.stringify({
      case: CASE, startedAt: new Date(startedAt).toISOString(),
      source: safeLabel(process.env.GITHUB_SHA), runId: safeLabel(process.env.GITHUB_RUN_ID),
      runAttempt: safeLabel(process.env.GITHUB_RUN_ATTEMPT), job: safeLabel(process.env.GITHUB_JOB),
      scope: "One complete semantic test file; not T8 or full qualification.",
    }) + "\n", { flag: "wx" });

    const prototype = WindowsProcessBackend.prototype;
    const launch = prototype.launch;
    const reconcile = prototype.reconcile;
    const signal = prototype.signal;
    const channelProvider = prototype.backpressuredChannelProvider;
    patch(prototype, "launch", function (this: WindowsProcessBackend, request: ProcessLaunchRequest) {
      const root = batchFixtureRoot(request);
      if (!root) return launch.call(this, request);
      const deadline = Reflect.get(this, "startupDeadlineAt") as unknown;
      const context: Batch = { root, ...(typeof deadline === "number" ? { deadline } : {}) };
      batches.set(this, context); batch = context;
      return watch("launch", context, () => launch.call(this, request), (value) => {
        const accepted = parseProcessLaunchResult(value);
        const identity = JSON.parse(Buffer.from(accepted.opaqueIdentity, "base64url").toString("utf8")) as { directory?: unknown; nonce?: unknown; supervisorPid?: unknown; supervisorBirth?: unknown };
        if (typeof identity.directory !== "string" || !samePath(dirname(identity.directory), join(root, "state")) ||
            !/^owned-[0-9a-f-]{36}$/.test(basename(identity.directory)))
          throw new Error("Semantic observer rejected an unexpected accepted directory.");
        context.identity = accepted.opaqueIdentity;
        context.directory = resolve(identity.directory);
        context.launch = {
          directory: context.directory, nonce: safeLabel(identity.nonce),
          supervisorPid: identity.supervisorPid, supervisorBirth: safeLabel(identity.supervisorBirth),
          rootPid: accepted.rootPid, startedAt: accepted.startedAt,
        };
        return context.launch;
      });
    });
    patch(prototype, "reconcile", function (this: WindowsProcessBackend, ...args: Parameters<WindowsProcessBackend["reconcile"]>) {
      const context = batches.get(this);
      if (!context || context.identity !== args[0].opaqueIdentity) return reconcile.apply(this, args);
      return watch("reconcile", context, () => reconcile.apply(this, args), (value) => {
        // The public result has no revision; state.json revision is captured separately.
        const terminal = parseProcessReconciliation(value);
        context.lastReconcile = { atMs: now(), terminal, ...counters() };
        return context.lastReconcile;
      });
    });
    patch(prototype, "backpressuredChannelProvider", function (this: WindowsProcessBackend) {
      const provider = channelProvider.call(this);
      const context = batches.get(this);
      if (!context) return provider;
      // Production freezes this provider. Only this enabled test gets a facade;
      // every original descriptor/capability is retained except observed acquire.
      const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(provider);
      descriptors.acquire = { ...descriptors.acquire, value: function (...args: Parameters<typeof provider.acquire>) {
        if (context.identity !== args[0].opaqueIdentity) return provider.acquire.apply(provider, args);
        return watch("acquire", context, () => provider.acquire.apply(provider, args), (channel) => {
          context.channel = channel;
          installChannel(channel, context);
          return { acquired: true };
        });
      } };
      return Object.freeze(Object.create(Object.getPrototypeOf(provider), descriptors)) as typeof provider;
    });
    patch(prototype, "signal", function (this: WindowsProcessBackend, ...args: Parameters<WindowsProcessBackend["signal"]>) {
      const context = batches.get(this);
      if (!context || context.identity !== args[0].opaqueIdentity) return signal.apply(this, args);
      if (!captureAttempted && args[1] === "force_terminate") {
        captureAttempted = true;
        guard(() => {
          snapshot = {
            phase: "after failure/detach, before forwarding the first existing force signal",
            atomic: false, captureStartMs: now(), lastNaturalReconcile: context.lastReconcile,
            countersBeforeCapture: counters(),
            alreadyStoredChannelFailure: errorFact(context.channel && Reflect.get(context.channel, "channelFailure")),
            ...captureOwnedState(context, faults), captureEndMs: now(),
          };
        });
      }
      return watch("signal", context, () => signal.apply(this, args), () => ({ forwarded: true }));
    });
    await action();
  } catch (error) { primary = error; failed = true; }
  finally {
    for (const restore of restores.reverse()) guard(restore);
    guard(() => {
      if (!evidenceDirectory) throw new Error("Semantic observer evidence directory was not established.");
      const report = Buffer.from(JSON.stringify({
        case: CASE, finishedAt: new Date().toISOString(), elapsedMs: now(),
        bodyFailed: failed, bodyError: failed ? errorFact(primary) : undefined,
        limits: { maxCalls: MAX_CALLS, maxChannelEntries: MAX_ENTRIES, maxReadBytes: MAX_READ_BYTES, maxArtifactBytes: MAX_ARTIFACT_BYTES },
        calls, droppedCalls, batchLaunch: batch?.launch, lastNaturalReconcile: batch?.lastReconcile,
        counters: counters(), captureAttempted, snapshot,
        restoredDescriptors: restored, attemptedDescriptors: restores.length,
        diagnosticFaults: faults.map(errorFact),
        limitations: [
          "Enabled observation adds Promise handlers, hashing and bounded filesystem reads; no zero-overhead claim.",
          "Provider object identity changes only in this enabled test; original acquire Promise/channel/ACK/error are preserved.",
          "Snapshot is non-atomic and follows detach; pending ACK work may have progressed before the existing force signal.",
          "No extra process inspection, reconciliation, subscription, control, retry or deadline extension.",
          "No snapshot on a healthy case is not universal release proof. No environment or encoded launch payload is captured.",
        ],
      }, null, 2) + "\n");
      if (report.byteLength > MAX_ARTIFACT_BYTES) throw new Error("Semantic observer report exceeded its fixed byte limit.");
      writeFileSync(join(evidenceDirectory, "observation.json"), report, { flag: "wx" });
    });
  }
  const errors = [...(failed ? [primary] : []), ...faults];
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Semantic probe and/or mandatory diagnostic failed.", failed ? { cause: primary } : undefined);
}

function batchFixtureRoot(request: ProcessLaunchRequest): string | undefined {
  if (request.intent.runId !== "windows-semantic-probe" || request.fence.ownerId !== "windows-semantic-probe" ||
      request.fence.fencingToken !== 1 || basename(request.intent.executable) !== "capture-argv.cmd") return;
  const workspace = resolve(request.intent.workingDirectory);
  const root = dirname(workspace);
  return basename(workspace) === "workspace" && /^aiboard-windows-semantic-batch-[A-Za-z0-9]+$/.test(basename(root)) &&
    samePath(dirname(root), tmpdir()) ? root : undefined;
}

function captureOwnedState(batch: Batch, faults: unknown[]): Fact {
  if (!batch.directory) throw new Error("Semantic observer has no accepted owned directory.");
  const canonicalTemp = realpathSync(tmpdir());
  const expectedRoot = join(canonicalTemp, basename(batch.root));
  for (const directory of [batch.root, join(batch.root, "state"), batch.directory]) {
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
      throw new Error("Semantic observer refused an indirect fixture directory.");
  }
  if (!samePath(realpathSync(batch.root), expectedRoot) ||
      !samePath(realpathSync(batch.directory), join(expectedRoot, "state", basename(batch.directory))))
    throw new Error("Semantic observer refused a non-confined accepted directory.");
  let bytesRead = 0;
  let channelEntries = 0;
  let entriesTruncated = false;
  const files: Fact[] = [];
  const read = (relative: string) => {
    let fd: number | undefined;
    const at = Date.now();
    try {
      const path = join(batch.directory!, relative);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || !samePath(realpathSync(path), path))
        throw new Error("Semantic observer refused an indirect evidence file.");
      if (bytesRead >= MAX_READ_BYTES) { files.push({ path: relative, skipped: "byte_budget", at }); return; }
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
        throw new Error("Semantic observer evidence identity changed during open.");
      const buffer = Buffer.alloc(Math.min(4096, MAX_READ_BYTES - bytesRead));
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      bytesRead += count;
      const bytes = buffer.subarray(0, count);
      files.push({
        path: relative, at, sizeAtOpen: opened.size, bytesRead: count,
        truncated: opened.size > count, capturedBytesSha256: createHash("sha256").update(bytes).digest("hex"),
        capturedBytesBase64: bytes.toString("base64"),
      });
    } catch (error) {
      files.push({ path: relative, at, error: errorFact(error) });
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") faults.push(error);
    } finally { if (fd !== undefined) { try { closeSync(fd); } catch (error) { faults.push(error); } } }
  };
  for (const name of ["state.json", "child-status.json", "fence.json", "lock-holder.json", "stdout.log", "stderr.log"]) read(name);
  try {
    const channel = join(batch.directory, "channel");
    if (lstatSync(channel).isSymbolicLink() || !samePath(realpathSync(channel), channel))
      throw new Error("Semantic observer refused an indirect channel directory.");
  } catch (error) {
    files.push({ path: "channel", error: errorFact(error) });
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") faults.push(error);
    return { bytesRead, channelEntries, entriesTruncated, files };
  }
  for (const name of ["output-checkpoint.json", "output-retirement.json"]) read(join("channel", name));
  for (const name of ["output", "ack"]) {
    let directory: ReturnType<typeof opendirSync> | undefined;
    try {
      const path = join(batch.directory, "channel", name);
      if (lstatSync(path).isSymbolicLink() || !samePath(realpathSync(path), path))
        throw new Error("Semantic observer refused an indirect channel directory.");
      directory = opendirSync(path, { bufferSize: 1 });
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        if (channelEntries === MAX_ENTRIES) { entriesTruncated = true; break; }
        channelEntries++;
        if (/^(stdout|stderr)-[0-9]{12}\.json$/.test(entry.name)) read(join("channel", name, entry.name));
        else files.push({ path: join("channel", name, entry.name.slice(0, 160)), skipped: "not_fixed_output_or_ack_name" });
      }
    } catch (error) {
      files.push({ path: join("channel", name), error: errorFact(error) });
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") faults.push(error);
    } finally { if (directory) { try { directory.closeSync(); } catch (error) { faults.push(error); } } }
  }
  return { bytesRead, channelEntries, entriesTruncated, files };
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}
function safeLabel(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 160) : undefined;
}
function errorFact(error: unknown): Fact | undefined {
  if (error === undefined) return;
  return {
    name: error instanceof Error ? safeLabel(error.name) : typeof error,
    code: error && typeof error === "object" ? safeLabel(Reflect.get(error, "code")) : undefined,
    messageSha256: error instanceof Error ? createHash("sha256").update(error.message).digest("hex") : undefined,
  };
}
