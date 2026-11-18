// R3 (docs/runner-v2/codex-windows-job-escape-2026-11-18.md §6): a Microsoft Store program the owner installed (pwsh,
// python3 from the Python install manager) is still a program the Runner can start, look up for a final check, and run
// as a check, although no managed child's PATH holds the WindowsApps folders. The launch looks its own program up on the
// PATH that keeps them and pins the alias to its package's own program, started as the Job's root; the child's PATH
// still has none of them. Real host only, guarded per program: each case needs that program's first match on this
// host's PATH to be a Store alias.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test, { after } from "node:test";

import type { ToolExecutionOutput } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createCheckToolLookup } from "../src/check-tool-lookup.js";
import { isWindowsAppsPathEntry } from "../src/child-environment.js";
import { createExecutionHost } from "../src/execution-host.js";
import { CONTAINED_STOP_CONFIRMATION, createManagedProcessTools } from "../src/managed-process-tools.js";
import { packagedRootProgram } from "../src/language-server-executable.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { createProcessTools, processRunSupport } from "../src/process-tools.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { ToolBroker } from "../src/tool-broker.js";
import { createWindowsJobProcessHost } from "../src/windows-job-process-host.js";
import { checkNoWindowsJobProcessesLeft } from "./support/windows-job-leftover-guard.js";

const WINDOWS = process.platform === "win32";
const OWN_MARKER = `aiboard-store-root-${randomUUID().slice(0, 8)}-`;
const ownRoot = WINDOWS ? mkdtempSync(join(tmpdir(), OWN_MARKER)) : "";

after(async () => {
  if (!WINDOWS) return;
  await checkNoWindowsJobProcessesLeft([OWN_MARKER]);
  rmSync(ownRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
});

/** The first `<name>.exe` on this host's PATH, by lstat (an app execution alias cannot be followed by stat). */
function firstOnPath(name: string): string | undefined {
  const path = Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  for (const folder of path.split(delimiter).map((entry) => entry.trim().replace(/^"|"$/gu, "")).filter(Boolean)) {
    const candidate = join(folder, `${name}.exe`);
    try { lstatSync(candidate); return candidate; } catch {}
  }
  return undefined;
}

/** Every Job record this run's Job host wrote (command, args, pid), from its state directory. */
function jobRecords(directory: string): { command: string; args: string[]; pid: number }[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".json")).flatMap((file) => {
    try {
      const record = JSON.parse(readFileSync(join(directory, file), "utf8")) as { command?: unknown; args?: unknown; pid?: unknown; supervisor?: unknown };
      return typeof record.command === "string" && Array.isArray(record.args) && record.supervisor ? [{ command: record.command, args: record.args as string[], pid: Number(record.pid) }] : [];
    } catch { return []; }
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const LONG_LIVED = { pwsh: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep 60"], python3: ["-c", "import time; time.sleep(60)"] } as const;

for (const [name, version] of [["pwsh", /PowerShell \d/u], ["python3", /Python \d/u]] as const) {
  const first = WINDOWS ? firstOnPath(name) : undefined;
  const skip = (!WINDOWS && "Windows Job host") ||
    (!first && `needs ${name} on this host's PATH`) ||
    (first && !isWindowsAppsPathEntry(dirname(first)) && `needs ${name}'s first match on PATH to be a Microsoft Store alias (it is ${first})`);
  test(`R3: a Store ${name} is looked up, run as a check and started by its bare name; the child's PATH still lacks it`, { skip, timeout: 120_000 }, async () => {
    const root = join(ownRoot, name);
    // The package's own program the alias names: what every launch here must start as the Job's root, never the alias.
    const packaged = readlinkSync(first!);
    assert.notEqual(dirname(packaged).toLowerCase(), dirname(first!).toLowerCase(), `the alias names a program outside its own folder: ${packaged}`);
    const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
    const project = join(root, "project"), state = join(root, "state");
    mkdirSync(project, { recursive: true }); mkdirSync(state, { recursive: true });

    // The final-check lookup finds it where the launch looks for its own program.
    const lookup = await createCheckToolLookup({ environment: () => process.env })(name, { cwd: project });
    assert.equal(lookup.status, "found", JSON.stringify(lookup));

    const artifacts = new ArtifactStore(join(state, "artifacts"));
    const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
      windowsJobHost: createWindowsJobProcessHost({ stateDirectory: join(state, "job-host") }) });
    const run = await host.bindRun({ runId: `store-${name}`, permissionProfile: "full", capabilityContract: { digest: "f".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
    try {
      // As a final check runs it: a one-shot command by its bare name.
      const check = await run.commandExecution.execute({
        executable: name, arguments: ["--version"], workingDirectory: project, timeoutMs: 60_000, captureOutputBytes: 64 * 1024,
        context: { runId: run.runId, sessionId: "agent", actor: { role: "worker", id: "worker" }, callId: "check-1", toolName: "process.run", runnerInternal: true },
      });
      const checked = (check as { process?: { outcome?: unknown; exitCode?: unknown; cleanup?: { state?: unknown } } }).process;
      const stdout = Buffer.from((check as { capturedOutput?: { stdout?: Uint8Array } }).capturedOutput?.stdout ?? new Uint8Array()).toString("utf8");
      assert.equal(checked?.outcome, "exited", JSON.stringify(check).slice(0, 400));
      assert.equal(checked?.exitCode, 0);
      assert.equal(checked?.cleanup?.state, "verified_empty");
      assert.match(stdout, version);
      const jobHost = join(state, "job-host");
      assert.ok(jobRecords(jobHost).some((record) => same(record.command, packaged) && record.args.includes("--version")),
        `the check's Job root is the package's own program: ${JSON.stringify(jobRecords(jobHost))}`);

      const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: run.executionGrants, artifacts, maxInlineOutputBytes: 512 * 1024 });
      for (const tool of createProcessTools({ execution: run.commandExecution, support: processRunSupport(run.managedProcesses, artifacts) })) broker.register(tool);
      for (const tool of createManagedProcessTools(run.managedProcesses)) broker.register(tool);
      let sequence = 0;
      const invoke = (tool: string, input: Record<string, unknown>) => broker.invoke({ type: "tool_call", callId: `call-${++sequence}`, name: tool, arguments: input },
        { runId: run.runId, sessionId: "agent", actor: { role: "worker", id: "worker" }, workspacePath: project });
      const text = (result: ToolExecutionOutput) => JSON.stringify(result.content);

      // process.start by its bare name.
      const started = await invoke("process.start", { command: name, args: ["--version"] });
      assert.equal(started.isError, false, text(started));
      const processId = (started.content[0] as { value: Record<string, unknown> }).value.processId as string;
      let output = "";
      for (let attempt = 0; attempt < 100 && !version.test(output); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        output += text(await invoke("process.read_output", { processId }));
      }
      assert.match(output, version);

      // A long-lived workload started by its bare name runs as the package's own program and dies with the stop.
      const sleeper = await invoke("process.start", { command: name, args: [...LONG_LIVED[name]] });
      assert.equal(sleeper.isError, false, text(sleeper));
      const sleeperId = (sleeper.content[0] as { value: Record<string, unknown> }).value.processId as string;
      const sleeperRecord = () => jobRecords(jobHost).find((record) => record.args.join(" ") === LONG_LIVED[name].join(" "));
      for (let attempt = 0; attempt < 100 && !(sleeperRecord()?.pid ?? 0); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      const running = sleeperRecord();
      assert.ok(running && same(running.command, packaged), `the started Job root is the package's own program: ${JSON.stringify(jobRecords(jobHost))}`);
      assert.ok(running.pid > 0 && alive(running.pid), `the workload runs: ${JSON.stringify(running)}`);
      for (const record of jobRecords(jobHost)) assert.ok(!same(record.command, first!), `the alias is never launched: ${record.command}`);
      const stopped = await invoke("process.signal", { processId: sleeperId, signal: "SIGTERM" });
      assert.equal(stopped.isError, false, text(stopped));
      assert.ok(text(stopped).includes(JSON.stringify(CONTAINED_STOP_CONFIRMATION.slice(0, 40)).slice(1, -1)), `the contained stop: ${text(stopped)}`);
      for (let attempt = 0; attempt < 100 && alive(running.pid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(alive(running.pid), false, "the workload died with the stop");

      // The child's own PATH still holds no WindowsApps folder: a shell's lookup of the same name finds nothing there.
      const where = await invoke("process.run", { shell: "cmd", script: `where ${name}` });
      assert.match(text(where), /"exitCode":1/u, text(where));
    } finally {
      await run.close();
      await host.close();
    }
  });
}

// Nit 1 of the third review: a PATH folder that reaches WindowsApps through a junction is dropped from the child's PATH
// by its real path, so the check's own program found there is pinned the same way (never left as an alias the child
// cannot run).
{
  const first = WINDOWS ? firstOnPath("python3") ?? firstOnPath("pwsh") : undefined;
  const skip = (!WINDOWS && "Windows only") ||
    (!first && "needs python3 or pwsh on this host's PATH") ||
    (first && !isWindowsAppsPathEntry(dirname(first)) && `needs a Microsoft Store alias first on PATH (it is ${first})`);
  test("R3: a check's program found through a junction to WindowsApps is pinned by the folder's real path", { skip }, async () => {
    const link = join(ownRoot, "apps-link");
    symlinkSync(dirname(first!), link, "junction");
    try {
      assert.equal(isWindowsAppsPathEntry(link), false, "the junction's own spelling is not a WindowsApps folder");
      const command = first!.slice(dirname(first!).length + 1).replace(/\.exe$/iu, "");
      const pinned = await packagedRootProgram(command, ownRoot, { PATH: link, PATHEXT: ".COM;.EXE" }, isWindowsAppsPathEntry, "win32");
      assert.ok(pinned, "found through the junction, it is pinned");
      assert.equal(pinned.toLowerCase(), readlinkSync(first!).toLowerCase());
    } finally {
      unlinkSync(link);
      assert.throws(() => lstatSync(link), "the junction itself is gone before the root is removed");
    }
  });
}
