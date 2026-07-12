import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolResult } from "../src/agent-contracts.js";
import { ManagedProcessService } from "../src/managed-process.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
import { ToolBroker } from "../src/tool-broker.js";

test("background process output and ownership survive service restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace);
  const firstService = new ManagedProcessService({
    stateDirectory: state,
    idFactory: () => "process_1",
  });
  const owner = broker(workspace, firstService, "session_owner");
  try {
    const started = await invoke(owner, "start", "process.start", {
      command: process.execPath,
      args: [
        "-e",
        "console.log('ready'); console.error('diagnostic'); setInterval(() => {}, 1000)",
      ],
    });
    assert.equal(started.isError, false);
    assert.equal((json(started) as { processId: string }).processId, "process_1");
    const observed = firstService.listRun("run_1");
    assert.equal(observed.length, 1);
    assert.equal(observed[0].sessionId, "session_owner");
    assert.equal(observed[0].command, process.execPath);
    let pollAttempt = 0;
    await waitFor(async () => text(await invoke(owner, `poll_initial_${pollAttempt++}`, "process.poll", {
      processId: "process_1",
    })).includes("ready"));

    const recoveredService = new ManagedProcessService({ stateDirectory: state });
    const recoveredOwner = broker(workspace, recoveredService, "session_owner");
    const recovered = await invoke(recoveredOwner, "poll_2", "process.poll", {
      processId: "process_1",
    });
    assert.equal((json(recovered) as { status: string }).status, "running");
    assert.match(text(recovered), /ready/);
    assert.match(text(recovered), /diagnostic/);

    const otherSession = broker(workspace, recoveredService, "session_other");
    const denied = await invoke(otherSession, "signal_denied", "process.signal", {
      processId: "process_1",
      signal: "SIGTERM",
    });
    assert.equal(denied.error?.code, "process_not_owned");

    const stopped = await invoke(recoveredOwner, "signal_owner", "process.signal", {
      processId: "process_1",
      signal: "SIGTERM",
    });
    assert.equal(stopped.isError, false);
    await waitFor(async () => {
      const polled = await invoke(recoveredOwner, `poll_${Date.now()}`, "process.poll", {
        processId: "process_1",
      });
      return (json(polled) as { status: string }).status !== "running";
    });
    recoveredService.close();
  } finally {
    firstService.close();
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
});

test("background spawn failure is a structured tool error", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-error-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const service = new ManagedProcessService({ stateDirectory: join(root, "state") });
  const owner = broker(workspace, service, "session_owner");
  try {
    const result = await invoke(owner, "missing", "process.start", {
      command: join(root, "definitely-missing-executable.exe"),
    });
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "process_start_failed");
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function broker(
  workspace: string,
  service: ManagedProcessService,
  sessionId: string
): ToolBroker & { sessionId: string } {
  const result = new ToolBroker({
    permissionProfile: "full",
    workspacePath: workspace,
  }) as ToolBroker & { sessionId: string };
  result.sessionId = sessionId;
  for (const tool of createManagedProcessTools(service)) result.register(tool);
  return result;
}

async function invoke(
  brokerValue: ToolBroker & { sessionId: string },
  callId: string,
  name: string,
  args: unknown
): Promise<ToolResult> {
  return await brokerValue.invoke(
    { type: "tool_call", callId, name, arguments: args },
    {
      runId: "run_1",
      sessionId: brokerValue.sessionId,
      actor: { role: "worker", id: brokerValue.sessionId },
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

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for managed process state.");
}
