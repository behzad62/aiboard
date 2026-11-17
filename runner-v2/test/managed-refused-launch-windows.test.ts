import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { isProcessStopUnprovenError } from "../src/process-stop-proof.js";
import { WindowsBatchLaunchUnavailableError } from "../src/windows-process-backend.js";
import { assertNeverStarted, quittingProcessArgs, readUntilExit, toolJson, withManagedLaunchRun } from "./support/managed-launch-fixture.js";

// CW5a: real `.cmd` launches through the production ExecutionHost, its managed runtime and ManagedProcessService.
// The refusal comes before backend selection, so the two fact sets below differ only in the facts the run is bound with.
const unverifiedPortableFacts = { portableDuplex: "verified", windowsBatchArgv: "unavailable", exactTreeBirth: "verified", jobContainment: "unavailable" } as const;
const unverifiedJobFacts = { portableDuplex: "unavailable", windowsBatchArgv: "unavailable", exactTreeBirth: "unavailable", jobContainment: "verified" } as const;
const verifiedPortableFacts = { ...unverifiedPortableFacts, windowsBatchArgv: "verified" } as const;
const windowsOnly = process.platform === "win32" ? false : "The batch-argv refusal is Windows-only.";

for (const [label, facts] of [["portable-only facts", unverifiedPortableFacts], ["Job-only facts", unverifiedJobFacts]] as const) {
  test(`a refused .cmd launch (${label}) is never started: coded refusal, stopped record, clean detach`, { timeout: 60_000, skip: windowsOnly }, async () => withManagedLaunchRun(label, facts, async (f) => {
    const shim = join(f.project, "tool.cmd");
    await writeFile(shim, "@echo off\r\necho unreachable\r\n");
    const { error } = await f.start(shim);
    assert.ok(error instanceof WindowsBatchLaunchUnavailableError, `expected the coded refusal, got ${String(error)}`);
    assert.equal(error.code, "windows_batch_argv_unverified");
    assert.equal(error instanceof AggregateError, false);
    assert.equal(error.cause, undefined);
    assert.equal(isProcessStopUnprovenError(error), false, "the scheduler must not pause for a launch that never started");
    await assertNeverStarted(f, await f.failedId());
  }));
}

test("a .cmd on a host whose batch-argv fact is verified still runs through the managed runtime", { timeout: 60_000, skip: windowsOnly }, async () => withManagedLaunchRun("verified", verifiedPortableFacts, async (f) => {
  const shim = join(f.project, "ran.cmd");
  await writeFile(shim, "@echo off\r\necho batch-ran\r\n");
  const { processId, error } = await f.start(shim);
  assert.equal(error, undefined, String(error));
  assert.ok(processId);
  let text = JSON.stringify(toolJson(await f.invoke("process.read_output", { processId, stream: "stdout", waitMs: 15_000, until: { pattern: "batch-ran" } })));
  text += JSON.stringify(await readUntilExit(f, processId));
  assert.match(text, /batch-ran/);
  toolJson(await f.invoke("process.signal", { processId, signal: "SIGTERM" }));
}));

test("after a refused .cmd and a command-not-found start, list and signal answer the stopped records beside a live process", { timeout: 60_000, skip: windowsOnly }, async () => withManagedLaunchRun("list", unverifiedPortableFacts, async (f) => {
  const shim = join(f.project, "tool.cmd");
  await writeFile(shim, "@echo off\r\necho unreachable\r\n");
  // The refused record comes first, so the live process sits at a shifted position in the list's batch.
  assert.ok((await f.start(shim)).error instanceof WindowsBatchLaunchUnavailableError);
  const refused = await f.failedId();
  const quit = join(f.project, "quit");
  const live = await f.start(process.execPath, quittingProcessArgs(quit));
  assert.equal(live.error, undefined, String(live.error)); assert.ok(live.processId);
  const missing = await f.start("aiboard-cw5a-no-such-command");
  assert.ok(missing.error !== undefined && !(missing.error instanceof AggregateError), String(missing.error));
  assert.equal(isProcessStopUnprovenError(missing.error), false);
  const notFound = await f.failedId();
  for (const processId of [refused, notFound]) await assertNeverStarted(f, processId);

  const listed = toolJson(await f.invoke("process.list", {})) as { processes: Array<{ processId: string; status: string }> };
  assert.deepEqual(new Map(listed.processes.map((entry) => [entry.processId, entry.status])),
    new Map([[refused, "stopped"], [live.processId!, "running"], [notFound, "stopped"]]));
  for (const processId of [refused, notFound]) assert.equal(toolJson(await f.invoke("process.signal", { processId, signal: "SIGTERM" })).status, "stopped");

  await writeFile(quit, "quit");
  assert.equal((await readUntilExit(f, live.processId!)).exitCode, 0);
  const after = toolJson(await f.invoke("process.list", {})) as { processes: Array<{ processId: string; status: string }> };
  const final = new Map(after.processes.map((entry) => [entry.processId, entry.status]));
  assert.equal(final.size, 3);
  assert.notEqual(final.get(live.processId!), "running");
  assert.equal(final.get(refused), "stopped"); assert.equal(final.get(notFound), "stopped");
}));
