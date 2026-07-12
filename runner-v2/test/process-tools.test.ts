import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolResult } from "../src/agent-contracts.js";
import { createProcessTools } from "../src/process-tools.js";
import { ToolBroker } from "../src/tool-broker.js";

test("process.run records stdout, stderr, and exit code without semantic verdicts", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-run-"));
  const broker = brokerWithProcesses(workspace);
  try {
    const result = await invoke(broker, "run", {
      command: process.execPath,
      args: [
        "-e",
        "console.log('looks successful'); console.error('warning'); process.exit(2)",
      ],
    });
    assert.equal(result.isError, false);
    assert.deepEqual(json(result), {
      exitCode: 2,
      signal: null,
      timedOut: false,
      cancelled: false,
    });
    assert.match(text(result), /looks successful/);
    assert.match(text(result), /warning/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("exec mode does not interpret shell syntax and cwd cannot escape workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-process-boundary-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const marker = join(root, "injected.txt");
  const broker = brokerWithProcesses(workspace);
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
    for (const tool of createProcessTools()) projectBroker.register(tool);
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

test("process timeout is mechanical and terminates the child", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-timeout-"));
  const broker = brokerWithProcesses(workspace);
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

test("project-autonomous mode cannot run arbitrary executables without approval", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-process-approval-"));
  const broker = new ToolBroker({
    permissionProfile: "project",
    workspacePath: workspace,
  });
  for (const tool of createProcessTools()) broker.register(tool);
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

function brokerWithProcesses(workspace: string): ToolBroker {
  const broker = new ToolBroker({
    permissionProfile: "full",
    workspacePath: workspace,
    toolTimeoutMs: 5_000,
  });
  for (const tool of createProcessTools()) broker.register(tool);
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
