import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { ToolBroker } from "../src/tool-broker.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
import { createProcessTools, processRunSupport } from "../src/process-tools.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import type { ToolExecutionOutput } from "../src/agent-contracts.js";
import { bashExecutable, pwshExecutable } from "../src/shell-inventory.js";
import { bashCall, bashResult } from "../src/anthropic-bash-tool.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

// process.run with shellSession on real PowerShell processes, owned by the run's Job like any managed process.
const windows = process.platform === "win32";

type Invoke = (name: string, input: Record<string, unknown>, actorId?: string) => Promise<ToolExecutionOutput>;
async function withHost(t: TestContext, body: (f: { project: string; invoke: Invoke }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "shell-session-native-"));
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(join(project, "sub"), { recursive: true }); await mkdir(state);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  let run: ExecutionHostRunBinding | undefined, failed = false, primary: unknown;
  try {
    run = await host.bindRun({ runId: "shell-session", permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: run.executionGrants, artifacts, maxInlineOutputBytes: 512 * 1024 });
    for (const tool of createProcessTools({ support: processRunSupport(run.managedProcesses, artifacts) })) broker.register(tool);
    for (const tool of createManagedProcessTools(run.managedProcesses)) broker.register(tool);
    let sequence = 0;
    const invoke: Invoke = (name, input, actorId = "worker") => broker.invoke({ type: "tool_call", callId: `call-${++sequence}`, name, arguments: input },
      { runId: run!.runId, sessionId: "agent", actor: { role: "worker", id: actorId }, workspacePath: project });
    await body({ project, invoke });
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({ fixtureName: "shell session native", root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => { const errors: unknown[] = []; for (const close of [() => run?.close(), () => host.close()]) { try { await close(); } catch (error) { errors.push(error); } } if (errors.length) throw new AggregateError(errors, "shell session cleanup failed"); },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
      removeRoot: async () => { await rm(root, { recursive: true }); } });
  }
  void t;
}

const meta = (result: ToolExecutionOutput) => (result.content[0] as { value: Record<string, unknown> }).value;
const stream = (result: ToolExecutionOutput, name: "STDOUT" | "STDERR") =>
  (result.content.find((block) => block.type === "text" && block.text.startsWith(`${name}\n`)) as { text: string } | undefined)?.text.slice(name.length + 1) ?? "";
const lines = (text: string) => text.split("\n").map((line) => line.trimEnd()).filter(Boolean);

for (const shell of ["powershell", "pwsh"] as const) {
  const skip = !windows ? "Windows PowerShell sessions" : shell === "pwsh" && !pwshExecutable() ? "pwsh is not installed" : false;

  test(`${shell}: variables, functions, $env: and the location carry over between calls`, { skip }, async (t) => {
    await withHost(t, async ({ project, invoke }) => {
      const first = await invoke("process.run", { shell, shellSession: "main", script: "$x = 41; function Get-Twice($n) { $n * 2 }; $env:SESSION_PROBE = 'bar'; Set-Location sub; 'ready'" });
      assert.equal(first.isError, false, JSON.stringify(first.content));
      assert.deepEqual(lines(stream(first, "STDOUT")), ["ready"]);
      const session = meta(first).shellSession as Record<string, unknown>;
      assert.equal(session.name, "main"); assert.equal(session.started, true); assert.equal(session.cwd, join(project, "sub"));
      assert.match(String(session.processId), /\S/u);

      const second = await invoke("process.run", { shell, shellSession: "main", script: "$x + 1; Get-Twice 21; $env:SESSION_PROBE; (Get-Location).Path" });
      assert.equal(second.isError, false, JSON.stringify(second.content));
      assert.deepEqual(lines(stream(second, "STDOUT")), ["42", "42", "bar", join(project, "sub")]);
      assert.equal(meta(second).exitCode, 0);
      assert.equal((meta(second).shellSession as Record<string, unknown>).started, undefined);
      assert.equal((meta(second).shellSession as Record<string, unknown>).processId, session.processId);

      // Another caller's session of the same name is its own.
      const other = await invoke("process.run", { shell, shellSession: "main", script: "\"x=[$x]\"" }, "someone-else");
      assert.deepEqual(lines(stream(other, "STDOUT")), ["x=[]"]);
      assert.equal((meta(other).shellSession as Record<string, unknown>).started, true);
    });
  });

  test(`${shell}: exit codes, errors and a stopped command leave the session usable`, { skip }, async (t) => {
    await withHost(t, async ({ invoke }) => {
      await invoke("process.run", { shell, shellSession: "s", script: "$keep = 'kept'" });
      const native = await invoke("process.run", { shell, shellSession: "s", script: "cmd /c \"echo out & echo err 1>&2 & exit 3\"" });
      assert.equal(meta(native).exitCode, 3);
      assert.deepEqual(lines(stream(native, "STDOUT")), ["out"]);
      assert.match(stream(native, "STDERR"), /err/u);
      assert.equal(meta(await invoke("process.run", { shell, shellSession: "s", script: "if ($true) { exit 5 }; 'not here'" })).exitCode, 5);
      const failed = await invoke("process.run", { shell, shellSession: "s", script: "Get-Item C:\\definitely\\missing; 'after'" });
      assert.equal(meta(failed).exitCode, 1);
      assert.match(stream(failed, "STDERR"), /Cannot find path/u);

      const stopped = await invoke("process.run", { shell, shellSession: "s", script: "while ($true) { Start-Sleep -Milliseconds 100 }", timeoutMs: 1500 });
      assert.equal(stopped.isError, true);
      assert.equal(meta(stopped).timedOut, true);
      assert.equal((meta(stopped).shellSession as Record<string, unknown>).ended, undefined);
      assert.deepEqual(lines(stream(await invoke("process.run", { shell, shellSession: "s", script: "$keep" }), "STDOUT")), ["kept"]);
    });
  });

  test(`${shell}: a session ended by process.signal is replaced, with fresh state`, { skip }, async (t) => {
    await withHost(t, async ({ invoke }) => {
      const first = await invoke("process.run", { shell, shellSession: "s", script: "$keep = 'kept'" });
      const processId = (meta(first).shellSession as Record<string, unknown>).processId as string;
      assert.equal((await invoke("process.signal", { processId, signal: "SIGTERM" })).isError, false);
      const after = await invoke("process.run", { shell, shellSession: "s", script: "\"keep=[$keep]\"" });
      assert.equal(after.isError, false, JSON.stringify(after.content));
      assert.deepEqual(lines(stream(after, "STDOUT")), ["keep=[]"]);
      assert.equal((meta(after).shellSession as Record<string, unknown>).replaced, true);
    });
  });

  test(`${shell}: large session output is summarized and stays searchable by processId`, { skip }, async (t) => {
    await withHost(t, async ({ invoke }) => {
      const big = await invoke("process.run", { shell, shellSession: "s", script: "1..3000 | ForEach-Object { \"line $_\" }; 'needle here'" });
      assert.equal(big.isError, false, JSON.stringify(big.content));
      const processId = meta(big).processId as string;
      assert.match(processId, /^run-/u);
      assert.match(stream(big, "STDOUT"), /needle here/u);
      const found = await invoke("process.read_output", { processId, search: { pattern: "^line 1500$", regex: true } });
      assert.match(JSON.stringify(found.content), /line 1500/u);
    });
  });
}

const bashSkip = !bashExecutable() ? "bash is not installed" : false;

test("bash: variables, functions, exported values, cwd and env carry over; stdin is not the session's", { skip: bashSkip }, async (t) => {
  await withHost(t, async ({ project, invoke }) => {
    const first = await invoke("process.run", { shell: "bash", shellSession: "b", script: "x=41; twice() { echo $(( $1 * 2 )); }; export PROBE=bar; cd sub; echo ready" });
    assert.equal(first.isError, false, JSON.stringify(first.content));
    assert.deepEqual(lines(stream(first, "STDOUT")), ["ready"]);
    const session = meta(first).shellSession as Record<string, unknown>;
    assert.equal(session.started, true);
    assert.equal(session.cwd, join(project, "sub"));

    const second = await invoke("process.run", { shell: "bash", shellSession: "b", env: { EXTRA: "a \"b\" c" }, script: "echo $((x + 1)); twice 21; echo $PROBE; echo \"$EXTRA\"; cat; echo after-cat" });
    assert.equal(second.isError, false, JSON.stringify(second.content));
    assert.deepEqual(lines(stream(second, "STDOUT")), ["42", "42", "bar", "a \"b\" c", "after-cat"]);
    assert.equal((meta(second).shellSession as Record<string, unknown>).processId, session.processId);

    const moved = await invoke("process.run", { shell: "bash", shellSession: "b", cwd: project, script: "pwd -W 2>/dev/null || pwd" });
    assert.equal((meta(moved).shellSession as Record<string, unknown>).cwd, undefined, "back in the workspace");
    const bad = await invoke("process.run", { shell: "bash", shellSession: "b", env: { "NOT-A-NAME": "x" }, script: "true" });
    assert.equal(bad.isError, true);
    assert.match(JSON.stringify(bad.content), /not a bash variable name/u);
  });
});

test("bash: exit codes and stderr; a command past its limit, or exit, ends the session and the next call replaces it", { skip: bashSkip }, async (t) => {
  await withHost(t, async ({ invoke }) => {
    await invoke("process.run", { shell: "bash", shellSession: "b", script: "keep=kept" });
    const failed = await invoke("process.run", { shell: "bash", shellSession: "b", script: "echo out; echo err >&2; (exit 3)" });
    assert.equal(meta(failed).exitCode, 3);
    assert.deepEqual(lines(stream(failed, "STDOUT")), ["out"]);
    assert.deepEqual(lines(stream(failed, "STDERR")), ["err"]);
    assert.deepEqual(lines(stream(await invoke("process.run", { shell: "bash", shellSession: "b", script: "echo $keep" }), "STDOUT")), ["kept"]);

    const stopped = await invoke("process.run", { shell: "bash", shellSession: "b", script: "echo started; sleep 30", timeoutMs: 1500 });
    assert.equal(stopped.isError, true);
    assert.equal(meta(stopped).timedOut, true);
    assert.match(String((meta(stopped).shellSession as Record<string, unknown>).ended), /Bash cannot stop one command/u);
    assert.deepEqual(lines(stream(stopped, "STDOUT")), ["started"]);
    const fresh = await invoke("process.run", { shell: "bash", shellSession: "b", script: "echo \"keep=[$keep]\"" });
    assert.deepEqual(lines(stream(fresh, "STDOUT")), ["keep=[]"]);
    assert.equal((meta(fresh).shellSession as Record<string, unknown>).replaced, true);

    const exited = await invoke("process.run", { shell: "bash", shellSession: "b", script: "exit 0" });
    assert.match(String((meta(exited).shellSession as Record<string, unknown>).ended), /exited/u);
    assert.equal((meta(await invoke("process.run", { shell: "bash", shellSession: "b", script: "true" })).shellSession as Record<string, unknown>).replaced, true);
  });
});

test("Anthropic's bash tool runs in one kept bash through process.run: state, exit codes, restart", { skip: bashSkip }, async (t) => {
  await withHost(t, async ({ invoke }) => {
    let n = 0;
    const bash = async (input: Record<string, unknown>) => {
      const call = bashCall(`toolu_${++n}`, input);
      const result = await invoke(call.name, call.arguments as Record<string, unknown>);
      return bashResult(call.nativeCall!.input, { ...result, callId: call.callId, toolName: call.name });
    };
    assert.deepEqual(await bash({ command: "x=5; cd sub; echo set" }), { text: "set", isError: false });
    assert.deepEqual(await bash({ command: "echo $x $(basename \"$PWD\")" }), { text: "5 sub", isError: false });
    assert.deepEqual(await bash({ command: "echo bad >&2; false" }), { text: "bad\n[exit code 1]", isError: false });
    assert.deepEqual(await bash({ restart: true }), { text: "The bash shell has been restarted.", isError: false });
    const fresh = await bash({ command: "echo \"[$x]\"" });
    assert.equal(fresh.isError, false);
    assert.match(fresh.text, /^\[\]\n\[A new shell started/u);
  });
});

test("a session takes PowerShell or bash and a name; a longer timeout is capped, not refused", async () => {
  const [tool] = createProcessTools();
  const issues = (input: Record<string, unknown>) => { const result = tool!.validate!(input); return result.ok ? [] : result.issues; };
  assert.deepEqual(issues({ shell: "powershell", script: "1", shellSession: "a.b-c_1" }), []);
  assert.match(issues({ command: "npm test", shellSession: "s" })[0]!, /runs PowerShell/u);
  assert.match(issues({ shell: "cmd", script: "dir", shellSession: "s" })[0]!, /runs PowerShell/u);
  assert.match(issues({ shell: "pwsh", script: "1", shellSession: "has space" })[0]!, /shellSession is a name/u);
  assert.deepEqual(issues({ shell: "pwsh", script: "1", shellSession: "s", timeoutMs: 120_000 }), []);
});
