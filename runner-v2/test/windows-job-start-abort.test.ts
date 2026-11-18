// A Job host's start, and a start the launcher gives up on (PR CI: cli-worker-processes failed when a loaded host had
// not reported startup within the former fixed 5 s, and the aborted start never settled):
// - the start wait ends at once when the supervisor is already gone, instead of waiting out its ceiling (any host);
// - a start aborted by its launcher records the host's exit as its stop, so the run closes with its stop proven and no
//   process left (the real Job host, Windows only, with a stricter-only fault that makes the host start slowly);
// - a host that dies right after it created the root, before it resumed it, leaves no process: the root was created
//   inside the Job (PROC_THREAD_ATTRIBUTE_JOB_LIST), so the Job's kill-on-close ends it (Windows only).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { createWindowsJobProcessHost, waitForSupervisor, type WindowsJobInjectedLaunchFault } from "../src/windows-job-process-host.js";

const WINDOWS = process.platform === "win32";
const ownRoot = mkdtempSync(join(tmpdir(), `aiboard-start-abort-${randomUUID().slice(0, 8)}-`));
// Best effort: the run whose Job host died keeps its stores open by design (its close refuses), so on Windows its
// folder can stay locked until this process exits.
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

/** Each process folder's supervisor statuses (last line) and Job events under one Job host state directory. */
function jobFolders(jobHost: string): { status: Record<string, unknown>; events: string }[] {
  if (!existsSync(jobHost)) return [];
  return readdirSync(jobHost, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("process_")).map((entry) => {
    const folder = join(jobHost, entry.name);
    const lines = existsSync(join(folder, "supervisor.jsonl")) ? readFileSync(join(folder, "supervisor.jsonl"), "utf8").split(/\r?\n/).filter(Boolean) : [];
    return { status: lines.length ? JSON.parse(lines.at(-1)!) as Record<string, unknown> : {}, events: existsSync(join(folder, "job-events.jsonl")) ? readFileSync(join(folder, "job-events.jsonl"), "utf8") : "" };
  });
}

test("the start wait ends at once when the supervisor is already gone, without waiting out its ceiling", async () => {
  const folder = join(ownRoot, "gone");
  mkdirSync(folder, { recursive: true });
  const statusPath = join(folder, "supervisor.jsonl");
  writeFileSync(statusPath, JSON.stringify({ protocol: "aiboard-managed-process/v1", processId: "p", supervisorPid: 4242, port: 1, status: "starting" }) + "\n");
  const started = Date.now();
  await assert.rejects(waitForSupervisor({ protocol: "aiboard-managed-process/v1", token: "t", statusPath, supervisorPid: 4242, port: 0 }, "p", 600_000, () => false),
    /exited before it reported startup/);
  assert.ok(Date.now() - started < 5_000, `it ended in ${Date.now() - started} ms`);
  // A supervisor that wrote its terminal status before it exited is read once more, and that status is the answer.
  writeFileSync(statusPath, JSON.stringify({ protocol: "aiboard-managed-process/v1", processId: "p", supervisorPid: 4242, port: 1, status: "stopped", error: "failed" }) + "\n");
  const status = await waitForSupervisor({ protocol: "aiboard-managed-process/v1", token: "t", statusPath, supervisorPid: 4242, port: 0 }, "p", 600_000, () => false);
  assert.equal(status.status, "stopped");
});

async function withRun<T>(name: string, fault: WindowsJobInjectedLaunchFault, startDeadlineMs: number | undefined,
  body: (input: { invoke: (tool: string, args: Record<string, unknown>) => Promise<{ isError?: boolean; content: unknown[] }>; jobHost: string; project: string }) => Promise<T>): Promise<{ value: T; closeError: unknown; jobHost: string }> {
  const root = join(ownRoot, name);
  const project = join(root, "project"), state = join(root, "state"), jobHost = join(state, "job-host");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment(), ...PROCESS_HOST_FACTS,
    windowsJobHost: createWindowsJobProcessHost({ stateDirectory: jobHost, injectedLaunchFault: fault, ...(startDeadlineMs ? { startDeadlineMs } : {}) }) });
  const run = await host.bindRun({ runId: `start-abort-${name}`, permissionProfile: "full", capabilityContract: { digest: "a".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: run.executionGrants, artifacts, maxInlineOutputBytes: 64 * 1024 });
  for (const tool of createProcessTools({ execution: run.commandExecution, support: processRunSupport(run.managedProcesses, artifacts) })) broker.register(tool);
  for (const tool of createManagedProcessTools(run.managedProcesses)) broker.register(tool);
  let sequence = 0;
  const invoke = (tool: string, args: Record<string, unknown>) => broker.invoke({ type: "tool_call", callId: `call-${++sequence}`, name: tool, arguments: args },
    { runId: run.runId, sessionId: "agent", actor: { role: "worker", id: "worker" }, workspacePath: project });
  let value: T;
  let closeError: unknown = null;
  try { value = await body({ invoke, jobHost, project }); }
  finally {
    // The host closes even when the run's close refuses, so it lets go of its stores and the folder can be removed.
    try { await run.close(); } catch (error) { closeError = error; }
    try { await host.close(); } catch (error) { closeError ??= error; }
  }
  return { value, closeError, jobHost };
}

test("a start its launcher gives up on records the host's exit, so the run closes with its stop proven and no process left", { skip: !WINDOWS && "Windows Job host", timeout: 60_000 }, async () => {
  // The host sleeps before it creates anything; the launcher waits 1.5 s, then aborts the start. The host's close then
  // reaches its supervisor a second late, so the abort must wait for it to record the stop.
  const { value: started, closeError, jobHost: slowJobHost } = await withRun("slow", "slow_start_late_close", 1_500, async ({ invoke, jobHost, project }) => {
    const marker = join(project, "ran.txt");
    const result = await invoke("process.start", { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`] });
    const folders = jobFolders(jobHost);
    return { result, folders, ran: existsSync(marker) };
  });
  assert.equal(started.result.isError, true, JSON.stringify(started.result.content));
  assert.equal(started.ran, false, "the aborted start never ran its workload");
  assert.equal(started.folders.length, 1, JSON.stringify(started.folders));
  const status = started.folders[0]!.status;
  assert.equal(status.status, "stopped", `the aborted start's stop is recorded: ${JSON.stringify(status)}`);
  assert.equal(status.jobEmptyProof, true, JSON.stringify(status));
  assert.equal(status.terminationRequested, true, JSON.stringify(status));
  assert.ok(Number.isSafeInteger(status.supervisorPid) && await waitUntil(() => !alive(status.supervisorPid as number), 10_000), "its supervisor exited");
  assert.equal(closeError, null, `the run closes with the aborted start's cleanup certified: ${inspect(closeError, { depth: 8 })}`);
  assert.deepEqual(jobFolders(slowJobHost), [], "the aborted start's exact Job record was released through its binding");
});

test("a host that dies right after it created the root, before resuming it, leaves no process", { skip: !WINDOWS && "Windows Job host", timeout: 60_000 }, async () => {
  // Only the root's death is claimed here: the host that owned the Job died, so whether its stop is proven is not.
  const { value: observed } = await withRun("created", "host_exit_after_create", undefined, async ({ invoke, jobHost }) => {
    const result = await invoke("process.start", { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] });
    const created = jobFolders(jobHost).map((folder) => /"type":"fault_created","pid":(\d+)/.exec(folder.events)?.[1]).find(Boolean);
    return { result, pid: created ? Number(created) : 0 };
  });
  assert.ok(observed.pid > 0, `the host reported the root it created: ${JSON.stringify(observed.result.content)}`);
  assert.ok(await waitUntil(() => !alive(observed.pid), 10_000), `the suspended root ${observed.pid} died with the host's Job`);
});
