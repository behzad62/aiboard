import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { isProcessStopUnprovenError } from "../src/process-stop-proof.js";
import { assertNeverStarted, quittingProcessArgs, readUntilExit, toolJson, withManagedLaunchRun } from "./support/managed-launch-fixture.js";

// CW5a, portable: a start that fails before any streaming session exists (here a command that is not found, on any
// OS) leaves a record saved stopped with pid 0. process.list and process.signal answer it from the record.
// On Windows the host facts are injected, so the run does not wait for the host probes.
const windowsFacts = process.platform === "win32"
  ? { portableDuplex: "verified", windowsBatchArgv: "verified", exactTreeBirth: "verified", jobContainment: "unavailable" } as const
  : undefined;

test("a never-started record is listed and signalled stopped, alone and beside a live process", { timeout: 60_000 }, async () => withManagedLaunchRun("never-started list", windowsFacts, async (f) => {
  const missing = await f.start("aiboard-cw5a-no-such-command");
  assert.ok(missing.error !== undefined && !(missing.error instanceof AggregateError), String(missing.error));
  assert.equal(isProcessStopUnprovenError(missing.error), false);
  const notFound = await f.failedId();
  await assertNeverStarted(f, notFound);

  // Only never-started records: the list consumes its call's grant once and answers from the records.
  const alone = await f.listTwice();
  const first = toolJson(alone.first) as { processes: Array<{ processId: string; status: string }> };
  assert.deepEqual(first.processes.map((entry) => [entry.processId, entry.status]), [[notFound, "stopped"]]);
  assert.equal((alone.again as { code?: unknown } | undefined)?.code, "grant_consumed", `a second list on the same call must be refused: ${String(alone.again)}`);

  // Beside a live process, which is authorized as its own batch.
  const quit = join(f.project, "quit");
  const live = await f.start(process.execPath, quittingProcessArgs(quit));
  assert.equal(live.error, undefined, String(live.error)); assert.ok(live.processId);
  const listed = toolJson(await f.invoke("process.list", {})) as { processes: Array<{ processId: string; status: string }> };
  assert.deepEqual(new Map(listed.processes.map((entry) => [entry.processId, entry.status])), new Map([[notFound, "stopped"], [live.processId!, "running"]]));
  assert.equal(toolJson(await f.invoke("process.signal", { processId: notFound, signal: "SIGTERM" })).status, "stopped");

  await writeFile(quit, "quit");
  assert.equal((await readUntilExit(f, live.processId!)).exitCode, 0);
}));
