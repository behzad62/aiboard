import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WindowsProcessBackend } from "../../../src/windows-process-backend.js";
import {
  boundedConverge,
  createQualificationFixtureRoot,
  exitScenarioMain,
} from "../../support/qualification-harness.js";
import { isQualificationScenarioEntry } from "../../support/qualification-scenario-entry.js";
import {
  QUAL_FENCE,
  bindingFor,
  withWindowsInspectionQualification,
  opaqueDirectory,
  processLaunchRequest,
} from "../../support/qualification-process-fixture.js";
import type { BackpressuredOutputMetadata } from "../../../src/interactive-process-channel.js";

async function runDuplexOrdered(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows portable qualification ran on a non-Windows host.");
  const root = createQualificationFixtureRoot("portable-duplex");
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10, replayCapacityChunks: 2, replayCapacityBytes: 32 });
  await withWindowsInspectionQualification({ fixtureName: "runDuplexOrdered", root, backend, body: async fixture => {
    const launch = await fixture.launch(processLaunchRequest({
        invocationId: "portable-duplex",
        args: ["-e", "process.stdin.on('data',b=>{process.stdout.write(b);process.stderr.write(Buffer.from(b).reverse())});process.stdin.on('end',()=>process.exit(0))"],
      }));
    const binding = bindingFor(launch, "runner-windows-supervisor-v1");
    const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string };
    const provider = backend.backpressuredChannelProvider();
    const channel = await provider.acquire(binding, QUAL_FENCE);
    fixture.deferCleanup(() => channel.detach());
    const seen: Array<{ metadata: BackpressuredOutputMetadata; bytes: Buffer }> = [];
    const unsubscribe = channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
        seen.push({ metadata, bytes: Buffer.from(bytes) });
        return metadata;
      });
    fixture.deferCleanup(() => unsubscribe());
    for (const [sequence, text] of [[1, "abc"], [2, "def"]] as const) {
          const payload = Buffer.from(text);
          assert.deepEqual(await channel.write({
            sequence, byteLength: payload.byteLength,
            digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 2_000,
          }, payload), { acknowledged: true, sequence });
        }
    let refreshSample = "";
    await boundedConverge({
      label: "portable duplex live refresh samples", deadlineMs: 5_000,
      sample: () => {
        refreshSample = readFileSync(join(identity.directory, "state.json"), "utf8");
        const state = JSON.parse(refreshSample) as { status?: string; error?: unknown; windowsTreeRefreshCount?: number };
        if (state.status !== "running" || state.error != null)
          return { kind: "fail", reason: "workload did not remain healthy before refresh sampling" };
        return (state.windowsTreeRefreshCount ?? 0) >= 2 ? { kind: "pass" } : { kind: "retry" };
      },
      evidence: () => refreshSample,
    });
    console.log(JSON.stringify({ qualification: "portable-duplex-live-refresh", state: JSON.parse(refreshSample) }));
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
  } });
}

async function runReleaseUnsettled(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows portable qualification ran on a non-Windows host.");
  const root = createQualificationFixtureRoot("portable-release");
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10 });
  await withWindowsInspectionQualification({ fixtureName: "runReleaseUnsettled", root, backend, body: async fixture => {
    const launch = await fixture.launch(processLaunchRequest({
        invocationId: "portable-release",
        args: ["-e", "process.stdout.write('retained')"],
      }));
    const binding = bindingFor(launch, "runner-windows-supervisor-v1");
    const identity = opaqueDirectory(launch);
    await boundedConverge({
          label: "retained output appears", deadlineMs: 5_000,
          sample: () => readdirSync(join(identity, "channel/output")).length > 0 ? { kind: "pass" } : { kind: "retry" },
          evidence: () => readFileSync(join(identity, "state.json"), "utf8"),
        });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.ok(readdirSync(join(identity, "channel/output")).length > 0);
    const channel = await backend.backpressuredChannelProvider().acquire(binding, QUAL_FENCE);
    fixture.deferCleanup(() => channel.detach());
    await assert.rejects(backend.release(binding, QUAL_FENCE), /output.*unsettled|release.*refused/i);
    const unsubscribe = channel.subscribeBackpressuredOutput(async (metadata) => metadata);
    fixture.deferCleanup(() => unsubscribe());
    await boundedConverge({
          label: "output and ack drain", deadlineMs: 10_000,
          sample: () => readdirSync(join(identity, "channel/output")).length === 0
            && readdirSync(join(identity, "channel/ack")).length === 0
            ? { kind: "pass" } : { kind: "retry" },
          evidence: () => readFileSync(join(identity, "state.json"), "utf8"),
        });
    assert.equal((await channel.waitForTerminal() as { state: string }).state, "exited");
    await channel.detach();
    assert.deepEqual(await fixture.release(), { released: true });
  } });
}

async function runFenceTakeover(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows portable qualification ran on a non-Windows host.");
  const root = createQualificationFixtureRoot("portable-takeover");
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10 });
  await withWindowsInspectionQualification({ fixtureName: "runFenceTakeover", root, backend, body: async fixture => {
    const launch = await fixture.launch(processLaunchRequest({
        invocationId: "portable-takeover",
        args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
      }));
    const binding = bindingFor(launch, "runner-windows-supervisor-v1");
    const provider = backend.backpressuredChannelProvider();
    const oldChannel = await provider.acquire(binding, QUAL_FENCE);
    fixture.deferCleanup(() => oldChannel.detach());
    const nextFence = { ownerId: "recovery-owner", fencingToken: QUAL_FENCE.fencingToken + 1 };
    fixture.useCleanupFence(nextFence);
    const recovered = await provider.reattach(binding, nextFence);
    fixture.deferCleanup(() => recovered.channel.detach());
    const payload = Buffer.from("x");
    await assert.rejects(
          oldChannel.write({ sequence: 1, byteLength: 1, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 1_000 }, payload),
          /stale|fence|writer/i,
        );
    assert.deepEqual(await recovered.channel.write({
          sequence: recovered.nextSequence, byteLength: 1,
          digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 5_000,
        }, payload), { acknowledged: true, sequence: recovered.nextSequence });
  } });
}

async function runStaleFenceReject(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows portable qualification ran on a non-Windows host.");
  const root = createQualificationFixtureRoot("portable-stale");
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10 });
  await withWindowsInspectionQualification({ fixtureName: "runStaleFenceReject", root, backend, body: async fixture => {
    const launch = await fixture.launch(processLaunchRequest({
        invocationId: "portable-stale",
        args: ["-e", "setInterval(()=>{},1000)"],
      }));
    const binding = bindingFor(launch, "runner-windows-supervisor-v1");
    const staleFence = { ownerId: QUAL_FENCE.ownerId, fencingToken: QUAL_FENCE.fencingToken - 1 };
    await assert.rejects(backend.signal(binding, "terminate", staleFence), /fence|identity/i);
  } });
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
