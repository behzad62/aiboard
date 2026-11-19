// A Job host's start, and a start the launcher gives up on (PR CI: cli-worker-processes failed when a loaded host had
// not reported startup within the former fixed 5 s, and the aborted start never settled):
// - the start wait ends at once when the supervisor is already gone, or when the call is cancelled (any host);
// - a start aborted by its launcher records the host's exit as its stop, so the run closes with its stop proven and no
//   process left, also when its workload already wrote output and when the start claimed a pre-started spare;
// - one-shot process.run keeps such a start's exact record for cleanup instead of recording "nothing to clean up";
// - a host that dies right after it created the root, before it resumed it, leaves no process: inside the Job
//   (PROC_THREAD_ATTRIBUTE_JOB_LIST) the Job's kill-on-close ends it; on the Assign path the supervisor ends that exact
//   process, and the launch fails at once instead of waiting out its ceiling.
// Windows cases use stricter-only faults in the real Job host and end the start wait once the supervisor is listening
// (the Job host's test seam for its ceiling, or the call's own cancellation for process.run), never on a fixed deadline.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import test, { after } from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { createProcessTools, processRunSupport } from "../src/process-tools.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { ToolBroker } from "../src/tool-broker.js";
import { createWindowsJobProcessHost, waitForSupervisor, WindowsJobStartFailedError, type WindowsJobInjectedLaunchFault } from "../src/windows-job-process-host.js";

const WINDOWS = process.platform === "win32";
const ownRoot = mkdtempSync(join(tmpdir(), `aiboard-start-abort-${randomUUID().slice(0, 8)}-`));
// Best effort: a run whose close refuses keeps its stores open by design, so on Windows its folder can stay locked
// until this process exits.
after(() => { try { rmSync(ownRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* see above */ } });

// The host's process facts are injected, not probed (the probe alone takes seconds on Windows).
const PROCESS_HOST_FACTS = { processHostFacts: { portableDuplex: "unavailable", windowsBatchArgv: "unavailable", exactTreeBirth: "verified", jobContainment: "verified" } as const };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

interface JobFolder { readonly name: string; readonly status: Record<string, unknown>; readonly events: string; readonly stdoutBytes: number }
/** Each process folder's last supervisor status, Job events and raw stdout length under one Job host state directory. */
function jobFolders(jobHost: string): JobFolder[] {
  if (!existsSync(jobHost)) return [];
  return readdirSync(jobHost, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("process_")).map((entry) => {
    const folder = join(jobHost, entry.name);
    const read = (name: string) => (existsSync(join(folder, name)) ? readFileSync(join(folder, name), "utf8") : "");
    const lines = read("supervisor.jsonl").split(/\r?\n/).filter(Boolean);
    let status: Record<string, unknown> = {};
    try { status = lines.length ? JSON.parse(lines.at(-1)!) as Record<string, unknown> : {}; } catch { /* a line being written */ }
    return { name: entry.name, status, events: read("job-events.jsonl"), stdoutBytes: existsSync(join(folder, "stdout.log")) ? statSync(join(folder, "stdout.log")).size : 0 };
  });
}

test("the start wait ends at once when the supervisor is already gone or the call is cancelled, without waiting out its ceiling", { timeout: 30_000 }, async () => {
  const folder = join(ownRoot, "gone");
  mkdirSync(folder, { recursive: true });
  const statusPath = join(folder, "supervisor.jsonl");
  const supervisor = { protocol: "aiboard-managed-process/v1", token: "t", statusPath, supervisorPid: 4242, port: 0 } as const;
  writeFileSync(statusPath, JSON.stringify({ protocol: "aiboard-managed-process/v1", processId: "p", supervisorPid: 4242, port: 1, status: "starting" }) + "\n");
  let started = Date.now();
  await assert.rejects(waitForSupervisor({ ...supervisor }, "p", 600_000, () => false), /exited before it reported startup/);
  assert.ok(Date.now() - started < 5_000, `it ended in ${Date.now() - started} ms`);
  // Cancellation ends the wait too, while the supervisor lives.
  const cancel = new AbortController();
  started = Date.now();
  setTimeout(() => cancel.abort(), 50);
  // Its ceiling is short only so a wait that ignored the cancellation would still end (and fail) soon.
  await assert.rejects(waitForSupervisor({ ...supervisor }, "p", 20_000, () => true, cancel.signal),
    (error: unknown) => (error as { code?: unknown }).code === "process_start_cancelled");
  assert.ok(Date.now() - started < 5_000, `the cancelled wait ended in ${Date.now() - started} ms`);
  // A supervisor that wrote its terminal status before it exited is read once more, and that status is the answer.
  writeFileSync(statusPath, JSON.stringify({ protocol: "aiboard-managed-process/v1", processId: "p", supervisorPid: 4242, port: 1, status: "stopped", error: "failed" }) + "\n");
  const status = await waitForSupervisor({ ...supervisor }, "p", 600_000, () => false);
  assert.equal(status.status, "stopped");
});

type Invoke = (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ isError?: boolean; content: unknown[] }>;
async function withRun<T>(name: string, fault: WindowsJobInjectedLaunchFault,
  options: { readonly spare?: boolean; readonly startWaitSignal?: AbortSignal },
  body: (input: { invoke: Invoke; jobHost: string; project: string }) => Promise<T>): Promise<{ value: T; closeError: unknown; jobHost: string }> {
  const root = join(ownRoot, name);
  const project = join(root, "project"), state = join(root, "state"), jobHost = join(state, "job-host");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const jobService = createWindowsJobProcessHost({ stateDirectory: jobHost, injectedLaunchFault: fault, ...(options.spare ? { spare: { keepWarm: false } } : {}),
    ...(options.startWaitSignal ? { startWaitSignal: options.startWaitSignal } : {}) });
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment(), ...PROCESS_HOST_FACTS, windowsJobHost: jobService });
  const runId = `start-abort-${name}`;
  const run = await host.bindRun({ runId, permissionProfile: "full", capabilityContract: { digest: "a".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: run.executionGrants, artifacts, maxInlineOutputBytes: 64 * 1024 });
  for (const tool of createProcessTools({ execution: run.commandExecution, support: processRunSupport(run.managedProcesses, artifacts) })) broker.register(tool);
  for (const tool of createManagedProcessTools(run.managedProcesses)) broker.register(tool);
  let sequence = 0;
  const invoke: Invoke = (tool, args, signal) => broker.invoke({ type: "tool_call", callId: `call-${++sequence}`, name: tool, arguments: args },
    { runId: run.runId, sessionId: "agent", actor: { role: "worker", id: "worker" }, workspacePath: project, ...(signal ? { signal } : {}) });
  let value: T;
  let closeError: unknown = null;
  try {
    if (options.spare) {
      assert.ok(jobService.prestartSpare, "the Job host pre-starts spares");
      // A spare serves the session it was started for: the tool calls' own session.
      await jobService.prestartSpare({ runId: run.runId, sessionId: "agent" });
    }
    value = await body({ invoke, jobHost, project });
  } finally {
    // The host closes even when the run's close refuses, so it lets go of what it can.
    try { await run.close(); } catch (error) { closeError = error; }
    try { await host.close(); } catch (error) { closeError ??= error; }
  }
  return { value, closeError, jobHost };
}

/**
 * The Job host's start wait ends, as its ceiling would, once the condition holds: the launcher gives up on the start
 * while the call itself stays live (a cancelled streaming call is answered at once and not followed).
 */
function giveUpWhen(condition: (folder: JobFolder) => boolean): { readonly signal: AbortSignal; arm(jobHost: string): void } {
  const controller = new AbortController();
  return { signal: controller.signal, arm: (jobHost) => { void waitUntil(() => jobFolders(jobHost).some(condition), 60_000).then(() => controller.abort()); } };
}
/** Aborts the call once the condition holds for a Job folder (the supervisor is listening, the workload wrote). */
function abortWhen(jobHost: string, condition: (folder: JobFolder) => boolean): AbortController {
  const controller = new AbortController();
  void waitUntil(() => jobFolders(jobHost).some(condition), 60_000).then(() => controller.abort());
  return controller;
}
const listening = (folder: JobFolder) => Number(folder.status.port) > 0 && folder.events.includes('"type":"helper"');
/**
 * A cancelled call returns at once; its launch then aborts the start and records the stop. Waits for that (every
 * record's supervisor stopped and gone) before the test reads the record or closes the run.
 */
async function abortedStartSettled(jobHost: string): Promise<JobFolder[]> {
  await waitUntil(() => {
    const folders = jobFolders(jobHost);
    return folders.length > 0 && folders.every((folder) => folder.status.status === "stopped" && !alive(Number(folder.status.supervisorPid)));
  }, 30_000);
  return jobFolders(jobHost);
}

async function assertAbortedStartSettled(started: { result: { isError?: boolean; content: unknown[] }; folders: JobFolder[] }, closeError: unknown, jobHost: string): Promise<void> {
  assert.equal(started.result.isError, true, JSON.stringify(started.result.content));
  assert.equal(started.folders.length, 1, JSON.stringify(started.folders));
  const status = started.folders[0]!.status;
  assert.equal(status.status, "stopped", `the aborted start's stop is recorded: ${JSON.stringify(status)}`);
  assert.equal(status.jobEmptyProof, true, JSON.stringify(status));
  assert.equal(status.terminationRequested, true, JSON.stringify(status));
  assert.equal(status.retainedOutputChunks, 0, JSON.stringify(status));
  assert.equal(status.retainedOutputBytes, 0, JSON.stringify(status));
  assert.ok(Number.isSafeInteger(status.supervisorPid) && await waitUntil(() => !alive(status.supervisorPid as number), 10_000), "its supervisor exited");
  assert.equal(closeError, null, `the run closes with the aborted start's cleanup certified: ${inspect(closeError, { depth: 8 })}`);
  assert.deepEqual(jobFolders(jobHost), [], "the aborted start's exact Job record was released through its binding");
}

test("a start its caller cancels records the host's exit, so the run closes with its stop proven and no process left", { skip: !WINDOWS && "Windows Job host", timeout: 60_000 }, async () => {
  // The host sleeps before it creates anything, and its close reaches its supervisor a second late, so the abort must
  // wait for it to record the stop.
  const giveUp = giveUpWhen(listening);
  const { value: started, closeError, jobHost } = await withRun("slow", "slow_start_late_close", { startWaitSignal: giveUp.signal }, async ({ invoke, jobHost, project }) => {
    const marker = join(project, "ran.txt");
    giveUp.arm(jobHost);
    const result = await invoke("process.start", { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`] });
    const folders = await abortedStartSettled(jobHost);
    assert.equal(existsSync(marker), false, "the aborted start never ran its workload");
    return { result, folders };
  });
  await assertAbortedStartSettled(started, closeError, jobHost);
});

test("an aborted start whose workload wrote past the retained bound drops that output and still settles", { skip: !WINDOWS && "Windows Job host", timeout: 60_000 }, async () => {
  // 400 KiB: the supervisor retains up to 256 KiB, then stops reading, so the workload blocks on a full pipe. The start
  // is abandoned only once the retained bound is reached.
  const giveUp = giveUpWhen((folder) => Number(folder.status.retainedOutputBytes) >= 256 * 1024);
  const { value: started, closeError, jobHost } = await withRun("wrote", "late_started_line", { startWaitSignal: giveUp.signal }, async ({ invoke, jobHost }) => {
    giveUp.arm(jobHost);
    const result = await invoke("process.start", { command: process.execPath, args: ["-e", `process.stdout.write("x".repeat(400 * 1024)); setTimeout(() => {}, 60000)`] });
    return { result, folders: await abortedStartSettled(jobHost) };
  });
  assert.equal(started.folders[0]?.status.outputDiscarded, true, JSON.stringify(started.folders[0]?.status));
  await assertAbortedStartSettled(started, closeError, jobHost);
});

test("a claimed spare's aborted start is stopped through its supervisor and settles the same way", { skip: !WINDOWS && "Windows Job host", timeout: 90_000 }, async () => {
  const giveUp = giveUpWhen((folder) => folder.status.claimed === true && folder.stdoutBytes >= 24);
  const { value: started, closeError, jobHost } = await withRun("spare", "late_started_line", { spare: true, startWaitSignal: giveUp.signal }, async ({ invoke, jobHost }) => {
    giveUp.arm(jobHost);
    const result = await invoke("process.start", { command: process.execPath, args: ["-e", `process.stdout.write("x".repeat(24)); setTimeout(() => {}, 60000)`] });
    return { result, folders: await abortedStartSettled(jobHost) };
  });
  assert.equal(started.folders[0]?.status.claimed, true, "the start claimed the pre-started spare");
  await assertAbortedStartSettled(started, closeError, jobHost);
});

test("one-shot process.run cancelled during its start stops that exact record like any stopped process", { skip: !WINDOWS && "Windows Job host", timeout: 90_000 }, async () => {
  const { value: ran, closeError, jobHost } = await withRun("run-cancel", "slow_start_late_close", {}, async ({ invoke, jobHost }) => {
    const cancel = abortWhen(jobHost, listening);
    const result = await invoke("process.run", { command: process.execPath, args: ["-e", ""] }, cancel.signal);
    return { result, folders: await abortedStartSettled(jobHost) };
  });
  const content = JSON.stringify(ran.result.content);
  assert.doesNotMatch(content, /not_required/, "a start with an exact record is never 'nothing to clean up'");
  assert.match(content, /"cancelled":true/, content);
  await assertAbortedStartSettled(ran, closeError, jobHost);
});

test("one-shot process.run whose start failed keeps its exact record blocked for cleanup, and the run's close settles it only on proven emptiness", { skip: !WINDOWS && "Windows Job host", timeout: 90_000 }, async () => {
  // The launcher gives up on the start (its ceiling, through the test seam) while the call stays live.
  const giveUp = giveUpWhen(listening);
  const { value: ran, closeError, jobHost } = await withRun("run-failed", "slow_start_late_close", { startWaitSignal: giveUp.signal }, async ({ invoke, jobHost }) => {
    giveUp.arm(jobHost);
    const result = await invoke("process.run", { command: process.execPath, args: ["-e", ""] });
    return { result, folders: await abortedStartSettled(jobHost) };
  });
  const content = JSON.stringify(ran.result.content);
  assert.equal(ran.result.isError, true, content);
  assert.doesNotMatch(content, /not_required/, "a start with an exact record is never 'nothing to clean up'");
  assert.match(content, /cleanup_blocked/, content);
  assert.match(content, /Process launch failed: /, "the launch's own failure comes first in the message");
  // The close re-attests the bound record and releases it only because the stop was recorded with the Job empty.
  await assertAbortedStartSettled(ran, closeError, jobHost);
});

test("a host that dies right after it created the root inside the Job, before resuming it, ends the start wait at its exit and leaves no process", { skip: !WINDOWS && "Windows Job host", timeout: 90_000 }, async () => {
  // Only the root's death is claimed here: the host that owned the Job died, so whether its stop is proven is not.
  // The host's close reaches its supervisor 2 s late (the fault): the supervisor writes a terminal, unproven status at
  // the host's exit, which ends the launcher's start wait; the launch's abort then waits for the stop the close records.
  const { value: observed } = await withRun("created", "host_exit_after_create", {}, async ({ invoke, jobHost }) => {
    const result = await invoke("process.start", { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] });
    const folder = jobFolders(jobHost)[0];
    const created = folder ? /"type":"fault_created","pid":(\d+)/.exec(folder.events)?.[1] : undefined;
    const statuses = folder ? readFileSync(join(jobHost, folder.name, "supervisor.jsonl"), "utf8").split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as { status?: string; updatedAt?: string }) : [];
    return { result, pid: created ? Number(created) : 0, statuses };
  });
  assert.equal(observed.result.isError, true, JSON.stringify(observed.result.content));
  assert.ok(observed.pid > 0, `the host reported the root it created: ${JSON.stringify(observed.result.content)}`);
  const states = observed.statuses.map((entry) => entry.status);
  const unproven = states.indexOf("exited_unknown"), stopped = states.indexOf("stopped");
  assert.ok(unproven >= 0 && (stopped < 0 || unproven < stopped),
    `the terminal, unproven status was written at the host's exit, before the late close recorded the stop: ${JSON.stringify(observed.statuses.map((entry) => [entry.status, entry.updatedAt]))}`);
  assert.ok(await waitUntil(() => !alive(observed.pid), 10_000), `the suspended root ${observed.pid} died with the host's Job`);
});

for (const [fault, window, identity] of [
  ["assign_path_exit_after_create", "right after CreateProcess, before it reported the root's identity", "the host's child created after its written intent"],
  ["assign_path_exit_before_assign", "after it reported the root's identity, before the Assign", "the reported pid and creation time"],
] as const) test(`on the Assign path, a host that dies ${window} leaves no process: the supervisor ends ${identity}`, { skip: !WINDOWS && "Windows Job host", timeout: 60_000 }, async () => {
  const { value: observed } = await withRun(fault, fault, {}, async ({ invoke, jobHost }) => {
    const result = await invoke("process.start", { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] });
    const folder = jobFolders(jobHost)[0];
    const created = folder ? /"type":"fault_created","pid":(\d+)/.exec(folder.events)?.[1] : undefined;
    const sentinel = folder ? /"type":"fault_sentinel","pid":(\d+)/.exec(folder.events)?.[1] : undefined;
    const statuses = folder ? readFileSync(join(jobHost, folder.name, "supervisor.jsonl"), "utf8").split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as { status?: string; rootEnding?: boolean; rootEndedBy?: string; jobEmptyProof?: boolean }) : [];
    return { result, events: folder?.events ?? "", pid: created ? Number(created) : 0, sentinel: sentinel ? Number(sentinel) : 0, statuses };
  });
  if (fault === "assign_path_exit_after_create") {
    // The host's other child, created before its intent, is outside the window: it is left alone. The test then ends
    // it (its own fault's process, a few seconds old).
    assert.ok(observed.sentinel > 0, observed.events);
    const sentinelAlive = alive(observed.sentinel);
    try { process.kill(observed.sentinel); } catch { /* already gone */ }
    assert.equal(sentinelAlive, true, "the host's child created before the intent was not ended");
  }
  assert.equal(observed.result.isError, true, JSON.stringify(observed.result.content));
  assert.ok(observed.pid > 0, `the host reported the root it created: ${observed.events}`);
  assert.match(observed.events, /"type":"assign_intent","hostPid":\d+,"hostCreationTime":"\d+","at":"\d+"/, "the intent was written before the create");
  if (fault === "assign_path_exit_before_assign") assert.match(observed.events, /"type":"assign_pending","pid":\d+,"creationTime":"\d+"/);
  else assert.doesNotMatch(observed.events, /assign_pending/, "the host died before it reported the root's identity");
  // The launch ended on the host's exit (its terminal status), not on the start ceiling, and the stop was proven only
  // once the root was ended.
  const states = observed.statuses.map((entry) => entry.status);
  assert.ok(states.includes("exited_unknown"), JSON.stringify(states));
  assert.ok(observed.statuses.some((entry) => entry.rootEnding === true), "the supervisor ended the root");
  assert.equal(observed.statuses.findLast((entry) => entry.rootEndedBy !== undefined)?.rootEndedBy,
    fault === "assign_path_exit_before_assign" ? "identity" : "intent", "the root was named by the identity the host reported, else by its intent");
  assert.ok(observed.statuses.some((entry) => entry.status === "stopped" && entry.jobEmptyProof === true), JSON.stringify(observed.statuses));
  assert.equal(alive(observed.pid), false, `the suspended root ${observed.pid} outside the Job was ended`);
});

for (const fault of ["assign_path_exit_after_create", "assign_path_exit_before_assign"] as const) test(`on the Assign path (${fault}), a root ender whose query fails proves nothing: the stop stays unproven and the root is not killed unverified`, { skip: !WINDOWS && "Windows Job host", timeout: 60_000 }, async () => {
  // rootEnderFault "query_fails": the ender's identity read (a reported identity) or its child query (only the intent)
  // fails. The supervisor's answer must be "alive", never "gone", and it kills nothing it did not identify. Once that
  // answer is in, the test ends the root itself (its own fault's process, a few seconds old): the root's handles to the
  // host's pipes close, and the stop must still stay unproven, since nothing proved the root gone. This drives the Job
  // host directly: a run's close would wait out its cleanup bound for a proof that never comes.
  const stateDirectory = join(ownRoot, `${fault}-query-fails`, "job-host");
  mkdirSync(stateDirectory, { recursive: true });
  const owner = { runId: "query-fails-run", sessionId: "query-fails-session" };
  const fence = { ownerId: "query-fails-owner", fencingToken: 1 };
  const service = createWindowsJobProcessHost({ stateDirectory, injectedLaunchFault: fault, injectedRootEnderFault: "query_fails" });
  const read = (folder: JobFolder | undefined, name: string) =>
    (folder && existsSync(join(stateDirectory, folder.name, name)) ? readFileSync(join(stateDirectory, folder.name, name), "utf8") : "");
  const answered = waitUntil(() => /Assign-path root end was not proven/.test(read(jobFolders(stateDirectory)[0], "stderr.log")), 50_000).then(() => {
    const folder = jobFolders(stateDirectory)[0];
    const pid = Number(/"type":"fault_created","pid":(\d+)/.exec(folder?.events ?? "")?.[1] ?? 0);
    const rootAlive = pid > 0 && alive(pid);
    if (pid > 0) try { process.kill(pid); } catch { /* already gone */ }
    const sentinel = Number(/"type":"fault_sentinel","pid":(\d+)/.exec(folder?.events ?? "")?.[1] ?? 0);
    if (sentinel > 0) try { process.kill(sentinel); } catch { /* already gone */ }
    return { pid, rootAlive };
  });
  const failure = await service.launchOwned({ ...owner, command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"],
    workingDirectory: ownRoot, environment: { ...process.env } as Record<string, string>, interactive: true, fence })
    .then(() => assert.fail("the host died before it started the workload"), (error: unknown) => error);
  assert.ok(failure instanceof WindowsJobStartFailedError, String(failure));
  const { pid, rootAlive } = await answered;
  const [folder] = jobFolders(stateDirectory);
  assert.ok(pid > 0 && folder, folder?.events);
  // The supervisor acknowledged the abort and exited; its status is final.
  assert.ok(await waitUntil(() => !alive(Number(jobFolders(stateDirectory)[0]?.status.supervisorPid)), 30_000), "the supervisor exited");
  const statuses = read(folder, "supervisor.jsonl").split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as { status?: string; rootEnding?: boolean; rootEndedBy?: string; jobEmptyProof?: boolean });
  assert.equal(statuses.findLast((entry) => entry.rootEndedBy !== undefined)?.rootEndedBy,
    fault === "assign_path_exit_before_assign" ? "identity" : "intent", JSON.stringify(statuses));
  assert.ok(statuses.some((entry) => entry.rootEnding === true), "the supervisor ran its ender");
  assert.match(read(folder, "stderr.log"), /Assign-path root end was not proven \(exit 0\): ready\r?\nalive: /);
  assert.equal(rootAlive, true, "a root the ender could not identify was not killed");
  assert.equal(statuses.some((entry) => entry.jobEmptyProof === true), false, `no empty proof, also once the root's pipes closed: ${JSON.stringify(statuses)}`);
  assert.equal(statuses.some((entry) => entry.status === "stopped"), false, JSON.stringify(statuses));
  // The exact record stays held: it cannot be released without a recorded stop.
  const { processId, startedAt } = failure.startRecord;
  await assert.rejects(service.releaseOwned(processId, owner, startedAt, fence));
});

test("a host that died with output retained, before its launcher aborted the start, still has its stop recorded at the abort", { skip: !WINDOWS && "Windows Job host", timeout: 60_000 }, async () => {
  // late_started_line: the workload writes 24 bytes, then the test ends the Job host itself (the supervisor's own
  // PowerShell child, a few seconds old). The Job empties with the output retained for a reader, and the supervisor
  // records it unsettled. Only then does the launcher, seeing that terminal status, abort the start: the abort itself
  // must drop that output and record the stop.
  const stateDirectory = join(ownRoot, "host-died", "job-host");
  mkdirSync(stateDirectory, { recursive: true });
  const owner = { runId: "host-died-run", sessionId: "host-died-session" };
  const fence = { ownerId: "host-died-owner", fencingToken: 1 };
  const service = createWindowsJobProcessHost({ stateDirectory, injectedLaunchFault: "late_started_line" });
  const killed = waitUntil(() => jobFolders(stateDirectory).some((folder) => folder.stdoutBytes >= 24), 50_000).then(() => {
    const supervisorPid = Number(jobFolders(stateDirectory)[0]?.status.supervisorPid);
    assert.ok(Number.isSafeInteger(supervisorPid) && supervisorPid > 0);
    const found = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${supervisorPid} AND Name = 'powershell.exe'" | Where-Object { $_.CommandLine -like '*managed-process-job-host.ps1*' }).ProcessId`],
      { encoding: "utf8", windowsHide: true });
    const hostPids = found.stdout.split(/\s+/).filter(Boolean).map(Number);
    assert.equal(hostPids.length, 1, `exactly one Job host under supervisor ${supervisorPid}: ${found.stdout} ${found.stderr}`);
    process.kill(hostPids[0]!);
    return hostPids[0]!;
  });
  const failure = await service.launchOwned({ ...owner, command: process.execPath, args: ["-e", `process.stdout.write("x".repeat(24)); setTimeout(() => {}, 60000)`],
    workingDirectory: ownRoot, environment: { ...process.env } as Record<string, string>, interactive: true, fence })
    .then(() => assert.fail("the host died before it reported the workload started"), (error: unknown) => error);
  assert.ok(failure instanceof WindowsJobStartFailedError, String(failure));
  await killed;
  const [folder] = await abortedStartSettled(stateDirectory);
  const statuses = readFileSync(join(stateDirectory, folder!.name, "supervisor.jsonl"), "utf8").split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as { status?: string; error?: string; jobEmptyProof?: boolean; outputDiscarded?: boolean; retainedOutputBytes?: number });
  assert.ok(statuses.some((entry) => entry.error === "Windows Job output remains unsettled after the job became empty." && entry.retainedOutputBytes === 24),
    `the output was retained, unsettled, once the Job was empty: ${JSON.stringify(statuses)}`);
  const last = statuses.at(-1)!;
  assert.equal(last.status, "stopped", JSON.stringify(last));
  assert.equal(last.jobEmptyProof, true, JSON.stringify(last));
  assert.equal(last.outputDiscarded, true, JSON.stringify(last));
  assert.equal(last.retainedOutputBytes, 0, JSON.stringify(last));
  const { processId, startedAt } = failure.startRecord;
  assert.equal((await service.reconcileOwned(processId, owner, fence)).status, "stopped");
  assert.equal((await service.releaseOwned(processId, owner, startedAt, fence)).ownershipReleased, true);
});

test("a stopped start whose output was discarded is settled through the fenced status path, also after a Runner restart", { skip: !WINDOWS && "Windows Job host", timeout: 60_000 }, async () => {
  const stateDirectory = join(ownRoot, "restart", "job-host");
  mkdirSync(stateDirectory, { recursive: true });
  const giveUp = giveUpWhen((folder) => folder.stdoutBytes >= 24);
  const owner = { runId: "restart-run", sessionId: "restart-session" };
  const fence = { ownerId: "restart-owner", fencingToken: 1 };
  const first = createWindowsJobProcessHost({ stateDirectory, injectedLaunchFault: "late_started_line", startWaitSignal: giveUp.signal });
  giveUp.arm(stateDirectory);
  const failure = await first.launchOwned({ ...owner, command: process.execPath, args: ["-e", `process.stdout.write("x".repeat(24)); setTimeout(() => {}, 60000)`],
    workingDirectory: ownRoot, environment: { ...process.env } as Record<string, string>, interactive: true, fence })
    .then(() => assert.fail("the start was abandoned"), (error: unknown) => error);
  assert.ok(failure instanceof WindowsJobStartFailedError, String(failure));
  const { processId, startedAt } = failure.startRecord;
  const [folder] = await abortedStartSettled(stateDirectory);
  assert.equal(folder?.status.outputDiscarded, true, JSON.stringify(folder?.status));
  // The record's own offsets were never moved by the launch: a Runner that restarts now finds them behind the logs.
  const record = JSON.parse(readFileSync(join(stateDirectory, `${processId}.json`), "utf8")) as { outputOffsets?: { stdout: number } };
  assert.equal(record.outputOffsets?.stdout ?? 0, 0, JSON.stringify(record.outputOffsets));
  const restarted = createWindowsJobProcessHost({ stateDirectory });
  const reconciled = await restarted.reconcileOwned(processId, owner, fence);
  assert.equal(reconciled.status, "stopped");
  const released = await restarted.releaseOwned(processId, owner, startedAt, fence);
  assert.equal(released.ownershipReleased, true);
});
