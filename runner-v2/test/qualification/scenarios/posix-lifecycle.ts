import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPosixProcessBackend } from "../../../src/posix-process-backend.js";
import { boundedConverge, createQualificationFixtureRoot, exitScenarioMain } from "../../support/qualification-harness.js";
import { isQualificationScenarioEntry } from "../../support/qualification-scenario-entry.js";
import {
  QUAL_FENCE,
  bindingFor,
  finalizePosixLiveFixture,
  opaqueDirectory,
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessReconciliation,
  processLaunchRequest,
} from "../../support/qualification-process-fixture.js";

async function runPosixLauncherExit(): Promise<void> {
  if (process.platform === "win32") throw new Error("POSIX lifecycle qualification ran on Windows.");
  const root = createQualificationFixtureRoot("posix-launcher-exit");
  const backend = createPosixProcessBackend({ stateDirectory: root, pollIntervalMs: 20 });
  let binding: ReturnType<typeof bindingFor> | undefined;
  let authorityDirectory: string | undefined;
  let settleAndDetachChannel: (() => Promise<void>) | undefined;
  let primaryFailure: unknown;
  try {
    const launch = parseProcessLaunchResult(await backend.launch(processLaunchRequest({
      invocationId: "posix-native-descendant",
      args: [
        "-e",
        "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n',()=>process.exit(0))",
      ],
    })));
    const liveBinding = bindingFor(launch, "runner-posix-process-group-v1");
    binding = liveBinding;
    const supervisorPid = liveBinding.rootPid;
    if (typeof supervisorPid !== "number" || !Number.isSafeInteger(supervisorPid) || supervisorPid < 1) {
      throw new Error("POSIX live fixture launch returned no exact supervisor witness PID.");
    }
    authorityDirectory = opaqueDirectory(launch);
    const channel = await backend.backpressuredChannelProvider().acquire(liveBinding, QUAL_FENCE);
    const observedOutput: Buffer[] = [];
    let outputAcknowledgementReleased = false;
    let releaseOutputAcknowledgement!: () => void;
    const outputAcknowledgement = new Promise<void>((resolve) => { releaseOutputAcknowledgement = resolve; });
    const releaseOutput = () => {
      if (outputAcknowledgementReleased) return;
      outputAcknowledgementReleased = true;
      releaseOutputAcknowledgement();
    };
    const unsubscribe = channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
      if (metadata.stream === "stderr") return metadata;
      observedOutput.push(Buffer.from(bytes));
      await outputAcknowledgement;
      return metadata;
    });
    settleAndDetachChannel = async () => {
      releaseOutput();
      const settlement = await channel.settleBackpressuredOutput?.(Date.now() + 5_000);
      if (settlement?.status !== "settled") throw new Error("POSIX live fixture output settlement did not reach the exact terminal proof.");
      unsubscribe();
      await channel.detach();
    };
    await boundedConverge({
      label: "posix descendant output",
      deadlineMs: 5_000,
      sample: () => observedOutput.length > 0 ? { kind: "pass" } : { kind: "retry" },
      evidence: () => authorityDirectory ? readFileSync(join(authorityDirectory, "state.json"), "utf8") : "no-authority",
    });
    await boundedConverge({
      label: "posix running after launcher exit",
      deadlineMs: 5_000,
      sample: async () => {
        const reconciliation = parseProcessReconciliation(await backend.reconcile(liveBinding, QUAL_FENCE));
        if (reconciliation.state === "running") return { kind: "pass" };
        if (reconciliation.state === "exited" || reconciliation.state === "identity_mismatch") {
          return { kind: "fail", reason: `definitive ${reconciliation.state}` };
        }
        return { kind: "retry" };
      },
      evidence: () => readFileSync(join(authorityDirectory!, "state.json"), "utf8"),
    });
    assert.deepEqual(await backend.signal(liveBinding, "terminate", QUAL_FENCE), { state: "running" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!parseProcessEmptyVerification(await backend.verifyEmpty(liveBinding, QUAL_FENCE)).empty) {
      assert.deepEqual(await backend.signal(liveBinding, "force_terminate", QUAL_FENCE), { state: "exited" });
    }
    const retired = JSON.parse(readFileSync(join(authorityDirectory, "state.json"), "utf8")) as {
      workloadGroupRetirement?: { state?: unknown };
    };
    assert.equal(retired.workloadGroupRetirement?.state, "retired");
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(liveBinding, QUAL_FENCE)).empty, false);
    assert.doesNotThrow(() => process.kill(supervisorPid, 0));
    assert.match(Buffer.concat(observedOutput).toString("utf8"), /^\d+\r?\n$/);
    releaseOutput();
    assert.equal((await channel.waitForTerminal() as { state: string }).state, "exited");
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (binding && authorityDirectory) {
      try {
        await finalizePosixLiveFixture(backend, binding, QUAL_FENCE, root, authorityDirectory, settleAndDetachChannel, true);
      } catch (cleanupError) {
        if (primaryFailure) throw new AggregateError([primaryFailure, cleanupError], "POSIX live fixture and exact cleanup both failed.");
        throw cleanupError;
      }
    } else if (primaryFailure) {
      throw new AggregateError([primaryFailure], `POSIX live fixture failed before authenticated cleanup identity; evidence retained at ${root}.`);
    } else {
      throw new Error(`POSIX live fixture completed without an authenticated cleanup identity; evidence retained at ${root}.`);
    }
  }
}

if (isQualificationScenarioEntry(import.meta.url)) {
  await exitScenarioMain(runPosixLauncherExit);
}
