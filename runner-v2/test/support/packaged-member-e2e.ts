// R2 end to end (windows-job-packaged-members.test.ts): a Store pwsh root through the tools a worker calls, on a real
// execution host. With the stricter-only membership_ignore_root_package fault the run's records end cleanup_blocked, so
// the run and the host refuse to close and keep the run's internal helper; that case runs in a child process
// (packaged-member-e2e-child.mts), which the test then retires by its own PID.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { ToolExecutionOutput } from "../../src/agent-contracts.js";
import { ArtifactStore } from "../../src/artifact-store.js";
import { createExecutionHost } from "../../src/execution-host.js";
import { createManagedProcessTools } from "../../src/managed-process-tools.js";
import { snapshotNativeBuildAmbientEnvironment } from "../../src/native-build-factory.js";
import { createProcessTools, processRunSupport } from "../../src/process-tools.js";
import { emptyRunnerCapabilitiesConfig } from "../../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../../src/runner-capability-contract.js";
import { ToolBroker } from "../../src/tool-broker.js";
import { createWindowsJobProcessHost, type WindowsJobInjectedLaunchFault } from "../../src/windows-job-process-host.js";

// The host's process facts are injected, not probed (the probe alone takes about 9 s on Windows), as in
// cli-worker-processes.test.ts: the Job is the only backend, so a Job that does not work fails instead of falling back.
const PROCESS_HOST_FACTS = process.platform === "win32"
  ? { processHostFacts: { portableDuplex: "unavailable", windowsBatchArgv: "unavailable", exactTreeBirth: "verified", jobContainment: "verified" } as const }
  : {};

export interface StorePwshEndToEnd {
  readonly startIsError: boolean;
  readonly start: string;
  readonly signalIsError: boolean;
  readonly signal: string;
  readonly runIsError: boolean;
  readonly run: string;
  readonly runCleanupState: string | null;
  readonly closeError: string | null;
}

export async function runStorePwshEndToEnd(root: string, storePwsh: string, fault: WindowsJobInjectedLaunchFault | undefined): Promise<StorePwshEndToEnd> {
  const project = join(root, "project"), state = join(root, "state");
  mkdirSync(project, { recursive: true }); mkdirSync(state, { recursive: true });
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({
    projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment(), ...PROCESS_HOST_FACTS,
    windowsJobHost: createWindowsJobProcessHost({ stateDirectory: join(state, "managed-processes-job-host"), ...(fault ? { injectedLaunchFault: fault } : {}) }),
  });
  const run = await host.bindRun({ runId: `e2e-${fault ?? "none"}`, permissionProfile: "full", capabilityContract: { digest: "e".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  const text = (result: ToolExecutionOutput) => JSON.stringify(result.content);
  let observed: Omit<StorePwshEndToEnd, "closeError">;
  try {
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: run.executionGrants, artifacts, maxInlineOutputBytes: 512 * 1024 });
    for (const tool of createProcessTools({ execution: run.commandExecution, support: processRunSupport(run.managedProcesses, artifacts) })) broker.register(tool);
    for (const tool of createManagedProcessTools(run.managedProcesses)) broker.register(tool);
    let sequence = 0;
    const invoke = (name: string, input: Record<string, unknown>) => broker.invoke({ type: "tool_call", callId: `call-${++sequence}`, name, arguments: input },
      { runId: run.runId, sessionId: "agent", actor: { role: "worker", id: "worker" }, workspacePath: project });
    const started = await invoke("process.start", { command: storePwsh, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep 60"] });
    const processId = (started.content[0] as { value: Record<string, unknown> }).value.processId as string;
    const stopped = await invoke("process.signal", { processId, signal: "SIGTERM" });
    const ran = await invoke("process.run", { shell: "pwsh", script: "'ran'" });
    observed = { startIsError: started.isError === true, start: text(started), signalIsError: stopped.isError === true, signal: text(stopped),
      runIsError: ran.isError === true, run: text(ran), runCleanupState: cleanupState(ran) };
  } catch (error) {
    observed = { startIsError: true, start: String(error), signalIsError: true, signal: "", runIsError: true, run: "", runCleanupState: null };
  }
  let closeError: string | null = null;
  try { await run.close(); await host.close(); }
  catch (error) { closeError = error instanceof AggregateError ? error.errors.map(String).join(" | ") : String(error); }
  return { ...observed, closeError };
}

function cleanupState(result: ToolExecutionOutput): string | null {
  const value = (result.content[0] as { value?: { cleanup?: { state?: unknown } } } | undefined)?.value;
  return typeof value?.cleanup?.state === "string" ? value.cleanup.state : null;
}

/** R4 through process.run: the tool result of a cmd script whose launch the Job host refuses with `fault`. */
export async function processRunRefused(root: string, fault: WindowsJobInjectedLaunchFault): Promise<{ readonly isError: boolean; readonly code: unknown; readonly text: string; readonly closeError: string | null }> {
  const project = join(root, "project"), state = join(root, "state");
  mkdirSync(project, { recursive: true }); mkdirSync(state, { recursive: true });
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({
    projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment(), ...PROCESS_HOST_FACTS,
    windowsJobHost: createWindowsJobProcessHost({ stateDirectory: join(state, "managed-processes-job-host"), injectedLaunchFault: fault }),
  });
  const run = await host.bindRun({ runId: `refused-${fault}`, permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: run.executionGrants, artifacts, maxInlineOutputBytes: 512 * 1024 });
  for (const tool of createProcessTools({ execution: run.commandExecution, support: processRunSupport(run.managedProcesses, artifacts) })) broker.register(tool);
  const ran = await broker.invoke({ type: "tool_call", callId: "call-1", name: "process.run", arguments: { shell: "cmd", script: "echo ran" } },
    { runId: run.runId, sessionId: "agent", actor: { role: "worker", id: "worker" }, workspacePath: project });
  let closeError: string | null = null;
  try { await run.close(); await host.close(); }
  catch (error) { closeError = error instanceof AggregateError ? error.errors.map(String).join(" | ") : String(error); }
  return { isError: ran.isError === true, code: (ran as { error?: { code?: unknown } }).error?.code, text: JSON.stringify(ran.content), closeError };
}
