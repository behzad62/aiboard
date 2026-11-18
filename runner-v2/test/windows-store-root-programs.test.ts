// R3 (docs/runner-v2/codex-windows-job-escape-2026-11-18.md §6): a Microsoft Store program the owner installed (pwsh,
// python3 from the Python install manager) is still a program the Runner can start, look up for a final check, and run
// as a check, although no managed child's PATH holds the WindowsApps folders. The launch looks its own program up on the
// PATH that keeps them and pins the alias to its package's own program, started as the Job's root; the child's PATH
// still has none of them. Real host only, guarded per program: each case needs that program's first match on this
// host's PATH to be a Store alias.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test, { after } from "node:test";

import type { ToolExecutionOutput } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createCheckToolLookup } from "../src/check-tool-lookup.js";
import { isWindowsAppsPathEntry } from "../src/child-environment.js";
import { createExecutionHost } from "../src/execution-host.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
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

for (const [name, version] of [["pwsh", /PowerShell \d/u], ["python3", /Python \d/u]] as const) {
  const first = WINDOWS ? firstOnPath(name) : undefined;
  const skip = (!WINDOWS && "Windows Job host") ||
    (!first && `needs ${name} on this host's PATH`) ||
    (first && !isWindowsAppsPathEntry(dirname(first)) && `needs ${name}'s first match on PATH to be a Microsoft Store alias (it is ${first})`);
  test(`R3: a Store ${name} is looked up, run as a check and started by its bare name; the child's PATH still lacks it`, { skip, timeout: 120_000 }, async () => {
    const root = join(ownRoot, name);
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

      // The child's own PATH still holds no WindowsApps folder: a shell's lookup of the same name finds nothing there.
      const where = await invoke("process.run", { shell: "cmd", script: `where ${name}` });
      assert.match(text(where), /"exitCode":1/u, text(where));
    } finally {
      await run.close();
      await host.close();
    }
  });
}
