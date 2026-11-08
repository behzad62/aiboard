import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ToolResult } from "../src/agent-contracts.js";
import { createProcessTools } from "../src/process-tools.js";
import type { OneShotCommandExecutor } from "../src/one-shot-command-executor.js";
import { ToolBroker } from "../src/tool-broker.js";
import { createTestOneShotCommandExecutor } from "./support/one-shot-command-executor.js";
import { createProductionOneShotCommandFixture } from "./support/one-shot-command-executor.js";

test("process.run routes through the injected shared executor and discloses Full enforcement", async () => {
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
    assert.deepEqual(json(result), {
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      cleanup: { state: "verified_empty", verifiedAt: "2026-08-29T00:00:01.000Z" },
      outputLossy: true,
      enforcement: "unconfined_explicit_full",
      disclosure: "unconfined_explicit_full",
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("process family production graph scrubs inherited secrets and continues beyond tail and spill bounds", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-production-matrix-"));
  const secretName = "RUNNER_MATRIX_INHERITED_SECRET";
  const previous = process.env[secretName];
  process.env[secretName] = "must-not-reach-child";
  const graph = createProductionOneShotCommandFixture(t);
  const broker = new ToolBroker({
    permissionProfile: "full", workspacePath: workspace, toolTimeoutMs: 30_000,
    executionGrants: graph.executionGrants,
  });
  for (const tool of createProcessTools({ execution: graph.execution })) broker.register(tool);
  try {
    const result = await invoke(broker, "production-large-output", {
      command: process.execPath,
      args: ["-e", `const marker=String(process.env.${secretName} ?? "absent"); process.stdout.write(marker + "|"); process.stdout.write("x".repeat(65 * 1024 * 1024)); process.stdout.write("|" + marker);`],
      timeoutMs: 25_000,
    });
    assert.equal(result.isError, false, result.error?.message ?? "process command unexpectedly failed");
    assert.equal(text(result).includes("must-not-reach-child"), false);
    assert.equal(text(result).includes("absent"), true);
    assert.equal(text(result).length < 256 * 1024, true, "model-visible output remains a bounded tail");
    assert.equal((json(result) as { outputLossy: boolean }).outputLossy, true);
    assert.equal((json(result) as { disclosure: string }).disclosure, "unconfined_explicit_full");
  } finally {
    if (previous === undefined) delete process.env[secretName]; else process.env[secretName] = previous;
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
    assert.equal((json(result) as { outputLossy: boolean }).outputLossy, true);
    assert.match(text(result), /runner output lossy/);
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
    assert.deepEqual({
      ...(json(result) as Record<string, unknown>),
      cleanup: undefined,
      outputLossy: undefined,
      enforcement: undefined,
      disclosure: undefined,
    }, {
      exitCode: 2,
      signal: null,
      timedOut: false,
      cancelled: false,
      cleanup: undefined,
      outputLossy: undefined,
      enforcement: undefined,
      disclosure: undefined,
    });
    assert.match(text(result), /looks successful/);
    assert.match(text(result), /warning/);
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

test("a client's command runs to its own limit, past the broker's, and Build's still stops at the broker's", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-limit-"));
  const external = { retainOutput: () => "run-1", readArtifact: async () => new Uint8Array() };
  const broker = (client: boolean) => {
    const made = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, toolTimeoutMs: 300 });
    for (const tool of createProcessTools({ execution: createTestOneShotCommandExecutor(t), ...(client ? { external } : {}) })) made.register(tool);
    return made;
  };
  const slow = { command: process.execPath, args: ["-e", "setTimeout(() => console.log('done'), 1500)"], timeoutMs: 10_000 };
  try {
    // Build first, so its stopped command is gone before the workspace is removed.
    const build = await invoke(broker(false), "build-slow", slow);
    assert.equal(build.error?.code, "tool_timeout", JSON.stringify(build));
    const client = await invoke(broker(true), "client-slow", slow);
    assert.equal(client.isError, false, JSON.stringify(client));
    assert.match(text(client), /done/u, "the result gets back, output and all");
    const [tool] = createProcessTools({ external });
    assert.ok(tool!.timeoutMs!({ command: "x", timeoutMs: 99_000_000 }) <= 30 * 60_000 + 120_000, "the Runner's maximum still holds");
    assert.ok(tool!.timeoutMs!({ command: "x" }) > 120_000, "and a command stopped at the default limit still has time to report");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Build's process.run ignores a stray search, as it did before search existed, and a client's is checked", () => {
  const [build] = createProcessTools();
  assert.equal(build!.validate({ command: "node", search: { pattern: "(a+)+$", regex: true } }).ok, true);
  const [client] = createProcessTools({ external: { retainOutput: () => "run-1", readArtifact: async () => new Uint8Array() } });
  assert.equal(client!.validate({ command: "node", search: { pattern: "(a+)+$", regex: true } }).ok, false);
});
