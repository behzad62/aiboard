import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createWindowsProcessBackend, WindowsJobObjectProcessBackend } from "../../../src/windows-process-backend.js";
import { createWindowsJobProcessHost } from "../../../src/windows-job-process-host.js";
import { parseProcessSignalResult } from "../../../src/process-backend.js";
import {
  boundedConverge,
  createQualificationFixtureRoot,
  deferQualificationFixtureRemoval,
  exitScenarioMain,
} from "../../support/qualification-harness.js";
import { isQualificationScenarioEntry } from "../../support/qualification-scenario-entry.js";
import {
  QUAL_FENCE,
  bindingFor,
  drainAndCleanupWindowsFixture,
  opaqueDirectory,
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessReconciliation,
  processLaunchRequest,
  verifiedWindowsSemanticFacts,
  withCertifiedRoot,
} from "../../support/qualification-process-fixture.js";

async function runNativeDescendant(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows lifecycle qualification ran on a non-Windows host.");
  const root = createQualificationFixtureRoot("windows-native-descendant");
  const backend = createWindowsProcessBackend({ jobObjects: "unavailable", stateDirectory: root, pollIntervalMs: 20 });
  const launch = parseProcessLaunchResult(await backend.launch(processLaunchRequest({
    invocationId: "windows-native-descendant",
    args: ["-e", "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore',detached:true});c.unref();console.log(c.pid);setTimeout(()=>process.exit(0),7000)"],
  })));
  const binding = bindingFor(launch, "runner-windows-supervisor-v1");
  const directory = opaqueDirectory(launch);
  let cleanupReleased = false;
  await withCertifiedRoot({
    fixtureName: "windows-native-descendant", root,
    body: async () => {
      await new Promise((resolve) => setTimeout(resolve, 7_300));
      await boundedConverge({
        label: "windows native running after launcher exit", deadlineMs: 5_000, pollMs: 100,
        sample: async () => {
          const reconciled = parseProcessReconciliation(await backend.reconcile(binding, QUAL_FENCE));
          if (reconciled.state === "running") return { kind: "pass" };
          if (reconciled.state === "exited" || reconciled.state === "identity_mismatch") {
            return { kind: "fail", reason: `definitive ${reconciled.state}` };
          }
          return { kind: "retry" };
        },
        evidence: () => readFileSync(join(directory, "state.json"), "utf8"),
      });
      let terminated: unknown; const signalDeadline = Date.now() + 15_000;
      while (terminated === undefined) {
        try { terminated = await backend.signal(binding, "terminate", QUAL_FENCE); }
        catch (error) {
          if (!/unknown|unavailable|inspect/i.test(error instanceof Error ? error.message : String(error)) || Date.now() >= signalDeadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      assert.equal(parseProcessSignalResult(terminated).state, "running");
      assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, QUAL_FENCE)).empty, false);
    },
    cleanup: async () => {
      if (!cleanupReleased) { await drainAndCleanupWindowsFixture(backend, binding, QUAL_FENCE); cleanupReleased = true; }
    },
    certify: async () => { assert.equal(cleanupReleased, true); },
  });
}

async function runJobDescendant(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows lifecycle qualification ran on a non-Windows host.");
  const root = createQualificationFixtureRoot("windows-job-descendant");
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const service = createWindowsJobProcessHost({ stateDirectory: `${join(root, "state")}-job-host` });
  const backend = createWindowsProcessBackend({ jobObjects: { service }, semanticFacts: verifiedWindowsSemanticFacts });
  const attestation = await backend.probe() as { capabilities: Record<string, string> };
  assert.equal(attestation.capabilities.crash_cleanup, "enforced");
  const jobRequest = processLaunchRequest({
    invocationId: "windows-job-native",
    workingDirectory: workspace,
    requiredLifecycleScope: "contained_workload",
    args: ["-e", "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore',detached:true});c.unref();console.log(c.pid);setTimeout(()=>process.exit(0),30)"],
  });
  const launch = parseProcessLaunchResult(await backend.launch(jobRequest));
  const binding = { ...bindingFor(launch, "runner-windows-job-v1"), backendId: "runner-windows-job-v1" };
  const takeoverFence = { ownerId: "job-recovery", fencingToken: QUAL_FENCE.fencingToken + 1 };
  let cleanupReleased = false;
  await withCertifiedRoot({
    fixtureName: "windows-job-descendant", root,
    body: async () => {
      assert.equal(parseProcessReconciliation(await backend.reconcile(binding, takeoverFence)).state, "running");
      await assert.rejects(backend.signal(binding, "terminate", QUAL_FENCE), /fence|identity/i);
      await boundedConverge({
        label: "windows Job remains owned after stale-fence signal rejection",
        deadlineMs: 5_000,
        pollMs: 50,
        sample: async () => {
          const reconciled = parseProcessReconciliation(await backend.reconcile(binding, takeoverFence));
          if (reconciled.state === "running") return { kind: "pass" };
          if (reconciled.state === "exited" || reconciled.state === "identity_mismatch") {
            return { kind: "fail", reason: `definitive ${reconciled.state}` };
          }
          return { kind: "retry" };
        },
        evidence: () => JSON.stringify({ root, takeoverFence }),
      });
      const observation = backend.observe(binding, async () => undefined, takeoverFence);
      const stopped = await backend.signal(binding, "force_terminate", takeoverFence).catch((error) => error);
      if (stopped instanceof Error) assert.match(stopped.message, /output|close|deadline|timeout/i);
      else assert.ok(["running", "exited"].includes(parseProcessSignalResult(stopped).state));
      assert.equal((await observation as { state: string }).state, "exited");
      assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, takeoverFence)).empty, true);
    },
    cleanup: async () => {
      if (!cleanupReleased) { await drainAndCleanupWindowsFixture(backend, binding, takeoverFence); cleanupReleased = true; }
    },
    certify: async () => { assert.equal(cleanupReleased, true); },
  });
}

async function runJobDuplex(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows Job duplex qualification ran on a non-Windows host.");
  const root = createQualificationFixtureRoot("windows-job-duplex");
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const service = createWindowsJobProcessHost({ stateDirectory: join(root, "state-job-host") });
  const backend = new WindowsJobObjectProcessBackend(
    service,
    verifiedWindowsSemanticFacts.windowsBatchArgv,
    verifiedWindowsSemanticFacts.jobContainment,
  );
  const launch = parseProcessLaunchResult(await backend.launch(processLaunchRequest({
    invocationId: "windows-job-duplex",
    workingDirectory: workspace,
    requiredLifecycleScope: "contained_workload",
    args: ["-e", "process.stdin.pipe(process.stdout)"],
  })));
  const binding = { ...bindingFor(launch, "runner-windows-job-v1"), backendId: "runner-windows-job-v1" };
  let detachChannel: (() => Promise<void>) | undefined;
  let cleanupReleased = false;
  await withCertifiedRoot({
    fixtureName: "windows-job-duplex", root,
    body: async () => {
      const channel = await backend.backpressuredChannelProvider().acquire(binding, QUAL_FENCE);
      const observed: Buffer[] = [];
      const unsubscribe = channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
        observed.push(Buffer.from(bytes));
        return metadata;
      });
      detachChannel = async () => { unsubscribe(); await channel.detach(); };
      const payload = Buffer.from(`job-duplex:${"x".repeat(8 * 1024)}`);
      await channel.write({
        sequence: 1,
        byteLength: payload.byteLength,
        digest: createHash("sha256").update(payload).digest("hex"),
        timeoutMs: 10_000,
      }, payload);
      await boundedConverge({
        label: "windows Job duplex echo",
        deadlineMs: 10_000,
        pollMs: 25,
        sample: () => Buffer.concat(observed).byteLength >= payload.byteLength ? { kind: "pass" } : { kind: "retry" },
        evidence: () => JSON.stringify({ observedBytes: Buffer.concat(observed).byteLength, expectedBytes: payload.byteLength }),
      });
      assert.deepEqual(Buffer.concat(observed), payload);
      await channel.closeInput();
      assert.equal((await channel.waitForTerminal() as { state: string }).state, "exited");
      const settlement = await channel.settleBackpressuredOutput?.(Date.now() + 10_000);
      assert.deepEqual(settlement, { status: "settled" });
      assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, QUAL_FENCE)).empty, true);
    },
    cleanup: async () => {
      const failures: unknown[] = [];
      if (detachChannel) {
        try { await detachChannel(); } catch (error) { failures.push(error); }
        detachChannel = undefined;
      }
      try { await drainAndCleanupWindowsFixture(backend, binding, QUAL_FENCE); cleanupReleased = true; }
      catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, `windows-job-duplex cleanup remains unverified; exact evidence retained at ${root}.`);
    },
    certify: async () => { assert.equal(cleanupReleased, true); },
  });
}

if (isQualificationScenarioEntry(import.meta.url)) {
  const name = process.env.RUNNER_V2_QUALIFICATION_SCENARIO ?? "";
  const runners: Record<string, () => Promise<void>> = {
    "windows-native-descendant": runNativeDescendant,
    "windows-job-descendant": runJobDescendant,
    "windows-job-duplex": runJobDuplex,
  };
  await exitScenarioMain(async () => {
    const run = runners[name];
    if (!run) throw new Error(`Unknown windows lifecycle scenario: ${name}`);
    await run();
  });
}
