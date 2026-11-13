import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ToolResult } from "../src/agent-contracts.js";
import { createProcessTools } from "../src/process-tools.js";
import type { OneShotCommandExecutor } from "../src/one-shot-command-executor.js";
import { ToolBroker } from "../src/tool-broker.js";
import { createTestOneShotCommandExecutor } from "./support/one-shot-command-executor.js";
import { createProductionOneShotCommandFixture } from "./support/one-shot-command-executor.js";

test("process.run routes through the injected shared executor, and output volume alone does not fail it", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-routed-"));
  const calls: unknown[] = [];
  const execution: OneShotCommandExecutor = {
    execute: async (request) => {
      calls.push(request);
      return {
        process: {
          logicalProcessId: "process-route-1",
          outcome: "exited",
          exitCode: 0,
          finishedAt: "2026-08-29T00:00:01.000Z",
          output: [
            { stream: "stdout", tail: "routed", totalBytes: 70 * 1024 * 1024, truncated: true, spillBytes: 64 * 1024 * 1024, lossyBytes: 6 * 1024 * 1024 },
            { stream: "stderr", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
          ],
          cleanup: { state: "verified_empty", verifiedAt: "2026-08-29T00:00:01.000Z" },
        },
        enforcement: "unconfined_explicit_full",
        disclosure: "unconfined_explicit_full",
      };
    },
  };
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace });
  for (const tool of createProcessTools({ execution })) broker.register(tool);
  try {
    const result = await invoke(broker, "routed", { command: "runner-fixture", args: [] });
    assert.equal(calls.length, 1);
    assert.equal(result.isError, false, "output volume alone must not fail the command");
    assert.match(text(result), /routed/);
    // What holds for nearly every command (a verified cleanup, Full enforcement, no signal) is left out; a loss is not.
    assert.deepEqual(json(result), { exitCode: 0, outputLossy: true });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("process family production graph scrubs inherited secrets and continues beyond tail and spill bounds", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-production-matrix-"));
  const secretName = "RUNNER_MATRIX_INHERITED_SECRET";
  const previous = process.env[secretName];
  process.env[secretName] = "must-not-reach-child";
  // Beyond the spill cap is what matters, not the production cap's 64 MiB: the POSIX portable channel moves
  // output at about 1 MiB/s (16 KiB chunks, one fenced ack each), so 65 MiB could not finish inside the deadline there.
  const graph = createProductionOneShotCommandFixture(t, { spillBytes: 64 * 1024 });
  const broker = new ToolBroker({
    permissionProfile: "full", workspacePath: workspace, toolTimeoutMs: 30_000,
    executionGrants: graph.executionGrants,
  });
  for (const tool of createProcessTools({ execution: graph.execution })) broker.register(tool);
  try {
    const result = await invoke(broker, "production-large-output", {
      command: process.execPath,
      args: ["-e", `const marker=String(process.env.${secretName} ?? "absent"); process.stdout.write(marker + "|"); process.stdout.write("x".repeat(512 * 1024)); process.stdout.write("|" + marker);`],
      timeoutMs: 25_000,
      // The raw tail, which is what is bounded; a summary would clip this one long line to its start.
      render: "raw",
    });
    assert.equal(result.isError, false, result.error?.message ?? "process command unexpectedly failed");
    assert.equal(text(result).includes("must-not-reach-child"), false);
    assert.equal(text(result).includes("absent"), true, text(result).slice(-300));
    assert.equal(text(result).length < 256 * 1024, true, "model-visible output remains a bounded tail");
    assert.equal((json(result) as { outputLossy: boolean }).outputLossy, true);
    // Full enforcement is what nearly every command has, so the result names only a narrower one.
    assert.equal((json(result) as { disclosure?: string }).disclosure, undefined);
  } finally {
    if (previous === undefined) delete process.env[secretName]; else process.env[secretName] = previous;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a command line runs on the production graph with its operators and its own quotes intact", async (t) => {
  // cmd.exe reads no \" escapes, so the Windows Job host passes `/d /s /c "<line>"` as typed (managed-process-job-host.ps1).
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-command-line-production-"));
  const graph = createProductionOneShotCommandFixture(t);
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, toolTimeoutMs: 30_000, executionGrants: graph.executionGrants });
  for (const tool of createProcessTools({ execution: graph.execution })) broker.register(tool);
  try {
    const node = JSON.stringify(process.execPath);
    const result = await invoke(broker, "production-command-line", {
      command: `echo first&& ${node} -e "console.log(JSON.stringify(process.argv.slice(1)))" "fix: tests & more" plain`,
      timeoutMs: 25_000,
    });
    assert.equal(result.isError, false, result.error?.message ?? text(result));
    assert.match(text(result), /first/u);
    assert.match(text(result), /\["fix: tests & more","plain"\]/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("process family production graph continues truthfully when private spill setup fails", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-production-spill-fault-"));
  const graph = createProductionOneShotCommandFixture(t, { spillFault: true });
  const broker = new ToolBroker({
    permissionProfile: "full", workspacePath: workspace, executionGrants: graph.executionGrants,
  });
  for (const tool of createProcessTools({ execution: graph.execution })) broker.register(tool);
  try {
    const result = await invoke(broker, "production-spill-fault", {
      command: process.execPath, args: ["-e", "process.stdout.write('z'.repeat(256*1024))"],
    });
    assert.equal(result.isError, false);
    assert.equal((json(result) as { outputLossy: boolean }).outputLossy, true, "the injected spill-root fault must leave the output lossy");
    // Name the injected fault, so a fixture that stops injecting it fails here instead of passing on another loss.
    assert.deepEqual((json(result) as { lossReasons: string[] }).lossReasons, ["spill_root_invalid"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("VF7b process.run gets the Runner's per-owner values: the owner's browser session and the shim folder first on PATH", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-runner-env-"));
  const shims = join(workspace, "..", "aiboard-process-runner-env-bin");
  const owners: Array<{ runId: string; sessionId: string }> = [];
  const graph = createProductionOneShotCommandFixture(t, {
    processEnvironment: (owner) => {
      owners.push(owner);
      return owner.runId === "run_1"
        ? { values: { PLAYWRIGHT_CLI_SESSION: `t-${owner.sessionId.length.toString(16).padStart(8, "0")}` }, pathPrepend: [shims] }
        : undefined;
    },
  });
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, toolTimeoutMs: 30_000, executionGrants: graph.executionGrants });
  for (const tool of createProcessTools({ execution: graph.execution })) broker.register(tool);
  try {
    const result = await invoke(broker, "runner-env", {
      command: process.execPath,
      args: ["-e", "const path = process.env.PATH ?? process.env.Path ?? ''; console.log(JSON.stringify({ session: process.env.PLAYWRIGHT_CLI_SESSION ?? null, first: path.split(require('node:path').delimiter)[0] }))"],
      timeoutMs: 25_000,
      // A caller cannot name the session itself: the Runner's value wins.
      env: { PLAYWRIGHT_CLI_SESSION: "forged" },
    });
    assert.equal(result.isError, false, result.error?.message ?? text(result));
    assert.deepEqual(owners.at(-1), { runId: "run_1", sessionId: "session_1" });
    const line = text(result).split(/\r?\n/u).find((entry) => entry.startsWith('{"session"'));
    assert.ok(line, text(result));
    assert.deepEqual(JSON.parse(line), { session: "t-00000009", first: shims });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("process.run records stdout, stderr, and exit code without semantic verdicts", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-run-"));
  const broker = brokerWithProcesses(workspace, t);
  try {
    const result = await invoke(broker, "run", {
      command: process.execPath,
      args: [
        "-e",
        "console.log('looks successful'); console.error('warning'); process.exit(2)",
      ],
    });
    assert.equal(result.isError, false);
    const { enforcement: _enforcement, disclosure: _disclosure, ...facts } = json(result) as Record<string, unknown>;
    assert.deepEqual(facts, { exitCode: 2 });
    assert.match(text(result), /looks successful/);
    assert.match(text(result), /warning/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a command line in command runs in the platform shell, exactly as that shell's script would", async () => {
  // Live 2026-11-10: `cd /d D:\proj && git add ... && git commit ...` sent as command failed with "Process launch was
  // not proven", and the model split every later commit into separate calls. Models write commands as one line.
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-command-line-"));
  const spaced = join(workspace, "my tools", "run.exe");
  mkdirSync(join(workspace, "my tools"));
  writeFileSync(spaced, "");
  const calls: Array<{ executable: string; arguments: readonly string[] }> = [];
  const execution: OneShotCommandExecutor = { execute: async (request) => { calls.push(request); throw new Error("not launched in this test"); } };
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace });
  const tools = createProcessTools({ execution });
  for (const tool of tools) broker.register(tool);
  const shell = process.platform === "win32"
    ? (line: string) => ({ executable: "cmd.exe", arguments: ["/d", "/s", "/c", line] })
    : (line: string) => ({ executable: "bash", arguments: ["-lc", line] });
  try {
    const lines = ["npm test", "git add a.txt && git commit -m \"fix: tests\"", "  node --version  "];
    for (const line of lines) await invoke(broker, "line-" + calls.length, { command: line, args: [] });
    assert.deepEqual(calls.map(({ executable, arguments: args }) => ({ executable, arguments: [...args] })), lines.map((line) => shell(line.trim())));
    // The same capability as an explicit shell script, so a command line gets no access a script would not.
    assert.equal(tools[0]!.assessAccess!({ command: "npm test" } as never, {} as never)?.capability, "process.shell");
    assert.equal(tools[0]!.assessAccess!({ command: "npm", args: ["test"] } as never, {} as never)?.capability, "process.execute");
    // One program stays one program: a bare name, a program with args, and an existing path with a space in it.
    calls.length = 0;
    for (const input of [{ command: "node" }, { command: "npm", args: ["test"] }, { command: spaced }]) await invoke(broker, "program-" + calls.length, input);
    assert.deepEqual(calls.map(({ executable }) => executable), ["node", "npm", spaced]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("exec mode does not interpret shell syntax and cwd cannot escape workspace", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-process-boundary-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const marker = join(root, "injected.txt");
  const broker = brokerWithProcesses(workspace, t);
  try {
    const literal = await invoke(broker, "literal", {
      command: process.execPath,
      args: ["-e", "console.log(process.argv[1])", `;echo injected > ${marker}`],
    });
    assert.equal(literal.isError, false);
    assert.match(text(literal), /;echo injected/);
    assert.equal(existsSync(marker), false);

    const projectBroker = new ToolBroker({
      permissionProfile: "project",
      workspacePath: workspace,
    });
    for (const tool of createProcessTools({ execution: createTestOneShotCommandExecutor(t) })) projectBroker.register(tool);
    const escaped = await invoke(projectBroker, "escape", {
      command: process.execPath,
      args: ["--version"],
      cwd: "..",
    });
    assert.equal(escaped.error?.code, "approval_required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("process timeout is mechanical and terminates the child", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-timeout-"));
  const broker = brokerWithProcesses(workspace, t);
  try {
    const result = await invoke(broker, "timeout", {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 40,
    });
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "process_timeout");
    assert.equal((json(result) as { timedOut: boolean }).timedOut, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("project-autonomous mode cannot run arbitrary executables without approval", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-approval-"));
  const broker = new ToolBroker({
    permissionProfile: "project",
    workspacePath: workspace,
  });
  for (const tool of createProcessTools({ execution: createTestOneShotCommandExecutor(t) })) broker.register(tool);
  try {
    const result = await invoke(broker, "approval", {
      command: process.execPath,
      args: ["--version"],
    });
    assert.equal(result.error?.code, "approval_required");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("benchmark process policy permits only exact allowlisted invocations", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-benchmark-"));
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace });
  for (const tool of createProcessTools({
    execution: createTestOneShotCommandExecutor(t),
    allowedCommands: [`${process.execPath} --version`, "echo approved"],
  })) broker.register(tool);
  try {
    const allowed = await invoke(broker, "allowed", {
      command: process.execPath,
      args: ["--version"],
    });
    assert.equal(allowed.isError, false);

    const denied = await invoke(broker, "denied", {
      command: process.execPath,
      args: ["-e", "console.log('not allowlisted')"],
    });
    assert.equal(denied.isError, true);
    assert.equal(denied.error?.code, "benchmark_command_denied");

    const shellAllowed = await invoke(broker, "shell-allowed", {
      shell: process.platform === "win32" ? "cmd" : "bash",
      script: "echo approved",
    });
    assert.equal(shellAllowed.isError, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function brokerWithProcesses(workspace: string, t: TestContext): ToolBroker {
  const broker = new ToolBroker({
    permissionProfile: "full",
    workspacePath: workspace,
    toolTimeoutMs: 5_000,
  });
  for (const tool of createProcessTools({ execution: createTestOneShotCommandExecutor(t) })) broker.register(tool);
  return broker;
}

async function invoke(
  broker: ToolBroker,
  callId: string,
  args: unknown
): Promise<ToolResult> {
  return await broker.invoke(
    { type: "tool_call", callId, name: "process.run", arguments: args },
    {
      runId: "run_1",
      sessionId: "session_1",
      actor: { role: "worker", id: "worker_1" },
    }
  );
}

function json(result: ToolResult): unknown {
  return result.content.find((block) => block.type === "json")?.value;
}

function text(result: ToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

test("a command runs to its own limit, past the broker's, in Build and for a client alike", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-limit-"));
  const retention = { retainOutput: () => "run-1", readArtifact: async () => new Uint8Array() };
  const broker = (names: "build" | "mcp") => {
    const made = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, toolTimeoutMs: 300 });
    for (const tool of createProcessTools({ execution: createTestOneShotCommandExecutor(t), support: retention, names })) made.register(tool);
    return made;
  };
  const slow = { command: process.execPath, args: ["-e", "setTimeout(() => console.log('done'), 1500)"], timeoutMs: 10_000 };
  try {
    // Build's broker used to end it at its own default, with nothing to show for the run.
    for (const names of ["build", "mcp"] as const) {
      const result = await invoke(broker(names), `${names}-slow`, slow);
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.match(text(result), /done/u, "the result gets back, output and all");
    }
    const [tool] = createProcessTools();
    assert.ok(tool!.timeoutMs!({ command: "x", timeoutMs: 99_000_000 }) <= 30 * 60_000 + 120_000, "the Runner's maximum still holds");
    assert.ok(tool!.timeoutMs!({ command: "x" }) > 120_000, "and a command stopped at the default limit still has time to report");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a search is checked the same way in Build and for a client", () => {
  for (const names of ["build", "mcp"] as const) {
    const [tool] = createProcessTools({ names });
    assert.equal(tool!.validate({ command: "node", search: { pattern: "(a+)+$", regex: true } }).ok, false, names);
    assert.equal(tool!.validate({ command: "node", search: { pattern: "error" } }).ok, true, names);
  }
});

test("Build and a client get the same process.run, each in the names it sees", () => {
  // Some clients give sub-agents tool descriptions but no server instructions; a live run lost ~170 s running a 150 s job with process_run.
  const [client] = createProcessTools({ names: "mcp" });
  const [build] = createProcessTools();
  for (const tool of [client!, build!]) {
    const description = tool.definition.description;
    assert.match(description, /stopped at timeoutMs \(default 120 s\), which leaves its effect unknown, so start servers, long jobs and interactive programs with process[._]start\./u);
    assert.match(description, /command is a whole command line, run by cmd\.exe on Windows and bash elsewhere, or one program with its arguments in args; for another shell, such as PowerShell or Git Bash, send shell and script instead\./u);
    assert.match(description, /Commands that run one after another.*go in one call\./u);
  }
  assert.doesNotMatch(client!.definition.description, /process\.[a-z_]+/u, "clients see process_start and process_read_output, not the internal names");
  assert.doesNotMatch(build!.definition.description, /process_[a-z]+/u, "Build's models see process.start and process.read_output");
  assert.doesNotMatch(build!.definition.description, /git commit/u, "Build's changes reach the project through change sets, not commits");
  assert.deepEqual(build!.definition.inputSchema, client!.definition.inputSchema, "the same arguments");
  const [short] = createProcessTools({ defaultTimeoutMs: 30_000, names: "mcp" });
  assert.match(short!.definition.description, /default 30 s/u, "it quotes the limit the tool really uses");
});
