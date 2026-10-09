import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WindowsProcessBackend } from "../../../src/windows-process-backend.js";
import {
  boundedConverge,
  createQualificationFixtureRoot,
  deferQualificationFixtureRemoval,
  exitScenarioMain,
  qualificationArtifactRoot,
  writeQualificationDiagnostics,
} from "../../support/qualification-harness.js";
import { isQualificationScenarioEntry } from "../../support/qualification-scenario-entry.js";
import {
  QUAL_FENCE,
  bindingFor,
  cleanupPortableBackendFixture,
  opaqueDirectory,
  parseProcessLaunchResult,
  processLaunchRequest,
} from "../../support/qualification-process-fixture.js";
import type { BackpressuredOutputMetadata } from "../../../src/interactive-process-channel.js";

async function runDuplexOrdered(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows portable qualification ran on a non-Windows host.");
  const root = createQualificationFixtureRoot("portable-duplex");
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10, replayCapacityChunks: 2, replayCapacityBytes: 32 });
  const launch = parseProcessLaunchResult(await backend.launch(processLaunchRequest({
    invocationId: "portable-duplex",
    args: ["-e", "process.stdin.on('data',b=>{process.stdout.write(b);process.stderr.write(Buffer.from(b).reverse())});process.stdin.on('end',()=>process.exit(0))"],
  })));
  const binding = bindingFor(launch, "runner-windows-supervisor-v1");
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string };
  const provider = backend.backpressuredChannelProvider();
  const channel = await provider.acquire(binding, QUAL_FENCE);
  const seen: Array<{ metadata: BackpressuredOutputMetadata; bytes: Buffer }> = [];
  const unsubscribe = channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
    seen.push({ metadata, bytes: Buffer.from(bytes) });
    return metadata;
  });
  try {
    for (const [sequence, text] of [[1, "abc"], [2, "def"]] as const) {
      const payload = Buffer.from(text);
      assert.deepEqual(await channel.write({
        sequence, byteLength: payload.byteLength,
        digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 2_000,
      }, payload), { acknowledged: true, sequence });
    }
    await channel.closeInput();
    assert.equal((await channel.waitForTerminal() as { state: string }).state, "exited");
    const supervisorState = JSON.parse(readFileSync(join(identity.directory, "state.json"), "utf8")) as {
      revision?: number; windowsTreeRefreshCount?: number; windowsTreeRefreshMinimumGapMs?: number | null;
    };
    assert.ok((supervisorState.windowsTreeRefreshCount ?? 0) >= 2);
    assert.ok((supervisorState.windowsTreeRefreshMinimumGapMs ?? 0) >= 250);
    await boundedConverge({
      label: "portable duplex streams", deadlineMs: 5_000,
      sample: () => seen.some((e) => e.metadata.stream === "stdout") && seen.some((e) => e.metadata.stream === "stderr")
        ? { kind: "pass" } : { kind: "retry" },
      evidence: () => JSON.stringify(supervisorState),
    });
    assert.equal(Buffer.concat(seen.filter((e) => e.metadata.stream === "stdout").map((e) => e.bytes)).toString(), "abcdef");
    const stderrText = Buffer.concat(seen.filter((e) => e.metadata.stream === "stderr").map((e) => e.bytes)).toString()
      .replace(/^\(node:\d+\) ExperimentalWarning:[\s\S]*?(?=\r?\n\r?\n|\r?\n(?! {2}))/gm, "")
      .replace(/\(Use `node --trace-warnings[\s\S]*?\)\r?\n/g, "")
      .trim();
    assert.equal(stderrText, "cbafed");
  } finally {
    unsubscribe();
    await channel.detach();
    await backend.signal(binding, "force_terminate", QUAL_FENCE).catch(() => undefined);
    await backend.release(binding, QUAL_FENCE).catch(() => undefined);
    deferQualificationFixtureRemoval(root);
  }
}

async function runReleaseUnsettled(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows portable qualification ran on a non-Windows host.");
  // Scenario-local failure diagnostics (read-only; this scenario only).
  // Pre-cleanup precedes finally force_terminate; post-cleanup is separate and never overwrites it.
  // No live SQLite contact, no ownership claim, no whole-DB hash, no second parsed projection.
  type Boundary = { phase: string; at: string; atMs: number; elapsedMs: number };
  type SinkEvent = { index: number; at: string; atMs: number; elapsedMs: number; stream: string; sequence: number; startOffset: number; endOffset: number; byteLength: number; digest: string; observedBytes: number; callbackReturnedMetadata: true };
  type DrainSample = { at: string; atMs: number; elapsedMs: number; outputCount: number; ackCount: number | null; ackNotRead: boolean };
  type FileObs = { relativePath: string; status: "present" | "missing" | "unreadable"; bytes?: number; mtimeMs?: number; prefixBase64?: string; prefixBytes?: number; truncated?: boolean; prefixSha256?: string; concurrentChange?: boolean; code?: string; error?: string; closeCode?: string; closeError?: string };
  type DirObs = { relativePath: string; status: "present" | "missing" | "unreadable"; names?: string[]; nameCount?: number; truncated?: boolean; code?: string; error?: string };
  type FenceMeta = { relativePath: ".fence.lock"; status: "present" | "missing" | "unreadable"; bytes?: number; mtimeMs?: number; code?: string; error?: string; note: string };
  type SignalOutcome = { status: "not-run"; note: string } | { status: "resolved"; value: string } | { status: "rejected"; error: string };
  const TEXT_CAP = 16_384, DIR_NAMES = 64, CHUNK_TOTAL = 8, SINK_CAP = 32, TRANS_CAP = 32;
  const scenarioStartedAtMs = Date.now();
  const boundaries: Boundary[] = [];
  const sinkEvents: SinkEvent[] = [];
  const sinkObserverErrors: string[] = [];
  const drainTransitions: DrainSample[] = [];
  let sinkCalls = 0;
  let sinkBytesTotal = 0;
  let drainStartedAtMs: number | undefined;
  let lastDrainSample: DrainSample | undefined;
  let lastEvidenceAt: Boundary | undefined;
  let lastObservedStateText: string | undefined;
  let signalOutcome: SignalOutcome = { status: "not-run", note: "Finally force_terminate has not run; pre-cleanup precedes it." };
  let primaryFailed = false;
  let preCleanupDir: string | undefined;
  const noteBoundary = (phase: string): void => {
    const atMs = Date.now();
    boundaries.push({ phase, at: new Date(atMs).toISOString(), atMs, elapsedMs: atMs - scenarioStartedAtMs });
  };
  const describeError = (error: unknown): string => {
    if (error instanceof Error) {
      const code = (error as { code?: unknown }).code;
      return `${error.name}: ${error.message}`.slice(0, 500) + (typeof code === "string" && code ? ` [${code}]` : "");
    }
    return String(error).slice(0, 500);
  };
  const summarizeSignalValue = (value: unknown): string => {
    if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}...(truncated)` : value;
    if (value === undefined) return "undefined";
    try {
      const text = JSON.stringify(value) ?? String(value);
      return text.length > 2000 ? `${text.slice(0, 2000)}...(truncated)` : text;
    } catch {
      return `unserializable ${Object.prototype.toString.call(value)}`;
    }
  };
  const observeCappedFile = (authorityDir: string, relativePath: string, cap: number): FileObs => {
    const full = join(authorityDir, relativePath);
    let fd: number | undefined;
    try {
      fd = openSync(full, "r");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { relativePath, status: "missing", code };
      return { relativePath, status: "unreadable", code: typeof code === "string" ? code : "unknown", error: describeError(error) };
    }
    let result: FileObs;
    let closeFailure: { closeCode: string; closeError: string } | undefined = undefined;
    try {
      const st = fstatSync(fd);
      const buf = Buffer.alloc(cap + 1);
      const readBytes = readSync(fd, buf, 0, cap + 1, 0);
      const truncated = readBytes > cap;
      const prefix = buf.subarray(0, Math.min(readBytes, cap));
      result = {
        relativePath, status: "present", bytes: st.size, mtimeMs: st.mtimeMs,
        prefixBase64: prefix.toString("base64"), prefixBytes: prefix.byteLength, truncated,
        prefixSha256: createHash("sha256").update(prefix).digest("hex"),
        concurrentChange: !truncated && st.size !== readBytes ? true : undefined,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      result = { relativePath, status: "unreadable", code: typeof code === "string" ? code : "unknown", error: describeError(error) };
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          closeFailure = { closeCode: typeof code === "string" ? code : "unknown", closeError: describeError(error) };
        }
      }
    }
    if (closeFailure !== undefined) {
      result = { ...result, ...closeFailure };
    }
    return result;
  };
  const observeDir = (authorityDir: string, relativePath: string): DirObs => {
    const full = join(authorityDir, relativePath);
    let names: string[];
    try {
      names = readdirSync(full).sort();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { relativePath, status: "missing", code };
      return { relativePath, status: "unreadable", code: typeof code === "string" ? code : "unknown", error: describeError(error) };
    }
    return { relativePath, status: "present", names: names.slice(0, DIR_NAMES), nameCount: names.length, truncated: names.length > DIR_NAMES ? true : undefined };
  };
  const observeFenceMeta = (authorityDir: string): FenceMeta => {
    const note = "Filesystem metadata only; live coordination file is never opened, queried, or parsed. Concurrent observation, not ownership proof.";
    const full = join(authorityDir, ".fence.lock");
    try {
      const st = statSync(full);
      return { relativePath: ".fence.lock", status: "present", bytes: st.size, mtimeMs: st.mtimeMs, note };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { relativePath: ".fence.lock", status: "missing", code, note };
      return { relativePath: ".fence.lock", status: "unreadable", code: typeof code === "string" ? code : "unknown", error: describeError(error), note };
    }
  };
  const safeEntryName = (name: string): boolean =>
    name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("..");
  const recordDrainSample = (outputCount: number, ackCount: number | null): void => {
    const atMs = Date.now();
    const sample: DrainSample = { at: new Date(atMs).toISOString(), atMs, elapsedMs: atMs - scenarioStartedAtMs, outputCount, ackCount, ackNotRead: ackCount === null };
    lastDrainSample = sample;
    const prev = drainTransitions[drainTransitions.length - 1];
    if (drainTransitions.length < TRANS_CAP && (prev === undefined || prev.outputCount !== outputCount || prev.ackCount !== ackCount)) {
      drainTransitions.push(sample);
    }
  };
  const captureReleaseSnapshot = (input: { label: "pre-cleanup" | "post-cleanup"; reason: string; root: string; identity: string; signal: SignalOutcome; error: unknown }): string => {
    const atMs = Date.now();
    const files: FileObs[] = [
      observeCappedFile(input.identity, "state.json", TEXT_CAP),
      observeCappedFile(input.identity, "fence.json", TEXT_CAP),
      observeCappedFile(input.identity, "lock-holder.json", TEXT_CAP),
      observeCappedFile(input.identity, "control.json", TEXT_CAP),
      observeCappedFile(input.identity, "channel/client-state.json", TEXT_CAP),
      observeCappedFile(input.identity, "channel/output-checkpoint.json", TEXT_CAP),
      observeCappedFile(input.identity, "channel/output-retirement.json", TEXT_CAP),
    ];
    const outputDir = observeDir(input.identity, "channel/output");
    const ackDir = observeDir(input.identity, "channel/ack");
    const chunkFiles: FileObs[] = [];
    const collectChunks = (dir: DirObs, relativeDir: string): void => {
      if (dir.status !== "present" || dir.names === undefined) return;
      for (const name of dir.names) {
        if (chunkFiles.length >= CHUNK_TOTAL) return;
        if (!safeEntryName(name)) {
          chunkFiles.push({ relativePath: `${relativeDir}/${name}`, status: "unreadable", code: "unsafe-name", error: "unsafe entry name; not read" });
          continue;
        }
        chunkFiles.push(observeCappedFile(input.identity, `${relativeDir}/${name}`, TEXT_CAP));
      }
    };
    collectChunks(outputDir, "channel/output");
    collectChunks(ackDir, "channel/ack");
    const evidenceRoot = process.env.RUNNER_V2_QUALIFICATION_EVIDENCE_ROOT?.trim() || qualificationArtifactRoot();
    const extra: Record<string, unknown> = {
      phase: input.label,
      reason: input.reason,
      scenario: "portable-release-unsettled",
      immutable: input.label === "pre-cleanup"
        ? "This pre-cleanup record is never overwritten; any post-cleanup snapshot is a separate capture."
        : "Separate post-cleanup record; the pre-cleanup record is left untouched.",
      snapshotAt: new Date(atMs).toISOString(),
      snapshotAtMs: atMs,
      elapsedMsSinceScenarioStart: atMs - scenarioStartedAtMs,
      unchangedBounds: { retainedOutputMs: 5_000, drainMs: 10_000, settleDelayMs: 1_500 },
      ownershipNote: "Snapshot only: no settle/drain/reattach, no fence claim, no release, and no signal was issued to produce it; filesystem metadata plus bounded prefix reads only, no live SQLite contact.",
      harnessNote: "writeQualificationDiagnostics also writes a concurrent noncoherent fixture-tree copy; live supervisor/subscription may advance during capture, so it is not atomic with the scenario-local prefix reads.",
      boundaries: [...boundaries],
      failingSample: { evidenceAt: lastEvidenceAt ?? null, stateText: lastObservedStateText ?? null },
      sink: {
        calls: sinkCalls, bytesTotal: sinkBytesTotal, events: [...sinkEvents], observerErrors: [...sinkObserverErrors],
        note: "The sink wrapper returned the actual metadata object unchanged (callback acceptance, not durable ACK publication); counts/bytes are observed deliveries only.",
      },
      drain: { deadlineMs: 10_000, startedAtMs: drainStartedAtMs ?? null, lastSample: lastDrainSample ?? null, countTransitions: [...drainTransitions] },
      signal: input.signal,
      authorityDirectory: input.identity,
      files,
      outputDir,
      ackDir,
      chunkFiles,
      fenceLock: observeFenceMeta(input.identity),
    };
    return writeQualificationDiagnostics({ evidenceRoot, scenario: "portable-release-unsettled", fixtureRoots: [input.root], extra, error: input.error });
  };
  const root = createQualificationFixtureRoot("portable-release");
  noteBoundary("fixture-root");
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10 });
  const launch = parseProcessLaunchResult(await backend.launch(processLaunchRequest({
    invocationId: "portable-release",
    args: ["-e", "process.stdout.write('retained')"],
  })));
  noteBoundary("launch");
  const binding = bindingFor(launch, "runner-windows-supervisor-v1");
  const identity = opaqueDirectory(launch);
  try {
    noteBoundary("retained-output-start");
    await boundedConverge({
      label: "retained output appears", deadlineMs: 5_000,
      sample: () => readdirSync(join(identity, "channel/output")).length > 0 ? { kind: "pass" } : { kind: "retry" },
      evidence: () => {
        const stateText = readFileSync(join(identity, "state.json"), "utf8");
        lastObservedStateText = stateText;
        const atMs = Date.now();
        lastEvidenceAt = { phase: "retained-failing-sample", at: new Date(atMs).toISOString(), atMs, elapsedMs: atMs - scenarioStartedAtMs };
        return stateText;
      },
    });
    noteBoundary("retained-output");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    noteBoundary("settle-delay");
    assert.ok(readdirSync(join(identity, "channel/output")).length > 0);
    const channel = await backend.backpressuredChannelProvider().acquire(binding, QUAL_FENCE);
    noteBoundary("acquire");
    await assert.rejects(backend.release(binding, QUAL_FENCE), /output.*unsettled|release.*refused/i);
    noteBoundary("expected-release-refusal");
    channel.subscribeBackpressuredOutput(async (metadata, ownedBytes) => {
      const callAtMs = Date.now();
      sinkCalls += 1;
      let observedBytes = 0;
      try {
        observedBytes = (ownedBytes as Uint8Array | undefined)?.byteLength ?? 0;
        sinkBytesTotal += observedBytes;
        if (sinkEvents.length < SINK_CAP) {
          sinkEvents.push({
            index: sinkCalls, at: new Date(callAtMs).toISOString(), atMs: callAtMs, elapsedMs: callAtMs - scenarioStartedAtMs,
            stream: metadata.stream, sequence: metadata.sequence, startOffset: metadata.startOffset,
            endOffset: metadata.endOffset, byteLength: metadata.byteLength, digest: metadata.digest,
            observedBytes, callbackReturnedMetadata: true,
          });
        }
      } catch (observerError) {
        if (sinkObserverErrors.length < 8) sinkObserverErrors.push(describeError(observerError));
      }
      return metadata;
    });
    noteBoundary("subscribe");
    drainStartedAtMs = Date.now();
    noteBoundary("ack-drain-start");
    await boundedConverge({
      label: "output and ack drain", deadlineMs: 10_000,
      sample: () => {
        const outputCount = readdirSync(join(identity, "channel/output")).length;
        if (outputCount !== 0) {
          recordDrainSample(outputCount, null);
          return { kind: "retry" };
        }
        const ackCount = readdirSync(join(identity, "channel/ack")).length;
        recordDrainSample(outputCount, ackCount);
        return ackCount === 0 ? { kind: "pass" } : { kind: "retry" };
      },
      evidence: () => {
        const stateText = readFileSync(join(identity, "state.json"), "utf8");
        lastObservedStateText = stateText;
        const atMs = Date.now();
        lastEvidenceAt = { phase: "drain-failing-sample", at: new Date(atMs).toISOString(), atMs, elapsedMs: atMs - scenarioStartedAtMs };
        return stateText;
      },
    });
    noteBoundary("ack-drain");
    assert.equal((await channel.waitForTerminal() as { state: string }).state, "exited");
    noteBoundary("wait-terminal");
    await channel.detach();
    noteBoundary("detach");
    assert.deepEqual(await backend.release(binding, QUAL_FENCE), { released: true });
    noteBoundary("final-release");
  } catch (primary) {
    primaryFailed = true;
    let captureError: unknown;
    try {
      preCleanupDir = captureReleaseSnapshot({
        label: "pre-cleanup",
        reason: "Scenario-body failure; this snapshot precedes the finally force_terminate/cleanup.",
        root, identity, signal: signalOutcome, error: primary,
      });
      noteBoundary("pre-cleanup-capture");
    } catch (error) {
      captureError = error;
    }
    if (captureError !== undefined) {
      throw new AggregateError([primary, captureError], "portable-release-unsettled failed and its pre-cleanup diagnostics also failed.");
    }
    throw primary;
  } finally {
    noteBoundary("finally-entry");
    try {
      signalOutcome = { status: "resolved", value: summarizeSignalValue(await backend.signal(binding, "force_terminate", QUAL_FENCE)) };
    } catch (error) {
      signalOutcome = { status: "rejected", error: describeError(error) };
    }
    noteBoundary("finally-signal");
    deferQualificationFixtureRemoval(root);
    noteBoundary("finally-defer");
    if (primaryFailed) {
      try {
        const postDir = captureReleaseSnapshot({
          label: "post-cleanup",
          reason: "Post-cleanup observation after the finally force_terminate/cleanup; separate from the pre-cleanup record.",
          root, identity, signal: signalOutcome,
          error: preCleanupDir === undefined ? "Primary failure (pre-cleanup capture unavailable)." : `Primary failure (pre-cleanup record at ${preCleanupDir}).`,
        });
        noteBoundary("post-cleanup-capture");
        void postDir;
      } catch (postError) {
        try {
          process.stderr.write(`portable-release-unsettled post-cleanup diagnostics failed: ${describeError(postError)}\n`);
        } catch {
          // stderr itself is unavailable; the primary error still fails the scenario.
        }
      }
    }
  }
}

async function runFenceTakeover(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows portable qualification ran on a non-Windows host.");
  const root = createQualificationFixtureRoot("portable-takeover");
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10 });
  const launch = parseProcessLaunchResult(await backend.launch(processLaunchRequest({
    invocationId: "portable-takeover",
    args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
  })));
  const binding = bindingFor(launch, "runner-windows-supervisor-v1");
  const provider = backend.backpressuredChannelProvider();
  const oldChannel = await provider.acquire(binding, QUAL_FENCE);
  const nextFence = { ownerId: "recovery-owner", fencingToken: QUAL_FENCE.fencingToken + 1 };
  const recovered = await provider.reattach(binding, nextFence);
  const payload = Buffer.from("x");
  try {
    await assert.rejects(
      oldChannel.write({ sequence: 1, byteLength: 1, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 1_000 }, payload),
      /stale|fence|writer/i,
    );
    assert.deepEqual(await recovered.channel.write({
      sequence: recovered.nextSequence, byteLength: 1,
      digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 5_000,
    }, payload), { acknowledged: true, sequence: recovered.nextSequence });
  } finally {
    await oldChannel.detach(); await recovered.channel.detach();
    await cleanupPortableBackendFixture(backend, binding, nextFence);
    deferQualificationFixtureRemoval(root);
  }
}

async function runStaleFenceReject(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows portable qualification ran on a non-Windows host.");
  const root = createQualificationFixtureRoot("portable-stale");
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10 });
  const launch = parseProcessLaunchResult(await backend.launch(processLaunchRequest({
    invocationId: "portable-stale",
    args: ["-e", "setInterval(()=>{},1000)"],
  })));
  const binding = bindingFor(launch, "runner-windows-supervisor-v1");
  const staleFence = { ownerId: QUAL_FENCE.ownerId, fencingToken: QUAL_FENCE.fencingToken - 1 };
  try {
    await assert.rejects(backend.signal(binding, "terminate", staleFence), /fence|identity/i);
  } finally {
    await cleanupPortableBackendFixture(backend, binding, QUAL_FENCE);
    deferQualificationFixtureRemoval(root);
  }
}

if (isQualificationScenarioEntry(import.meta.url)) {
  const name = process.env.RUNNER_V2_QUALIFICATION_SCENARIO ?? "";
  const runners: Record<string, () => Promise<void>> = {
    "portable-duplex": runDuplexOrdered,
    "portable-release-unsettled": runReleaseUnsettled,
    "portable-fence-takeover": runFenceTakeover,
    "portable-stale-fence": runStaleFenceReject,
  };
  await exitScenarioMain(async () => {
    const run = runners[name];
    if (!run) throw new Error(`Unknown portable scenario: ${name}`);
    await run();
  });
}
