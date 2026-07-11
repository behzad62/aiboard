import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NativeTool, ToolCallBlock } from "../src/agent-contracts.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { ToolBroker } from "../src/tool-broker.js";
import {
  toolInvocationFingerprint,
  toolInvocationKey,
} from "../src/tool-ledger.js";

test("completed side effects replay their durable result after broker restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-tool-ledger-replay-"));
  const database = join(root, "ledger.sqlite");
  let executions = 0;
  try {
    const firstLedger = new SqliteToolLedger(database);
    const first = broker(root, firstLedger, () => executions++);
    const result = await first.invoke(call("write_1", "one"), context());
    assert.equal(result.isError, false);
    firstLedger.close();

    const recoveredLedger = new SqliteToolLedger(database);
    const recovered = broker(root, recoveredLedger, () => executions++);
    const replay = await recovered.invoke(call("write_1", "one"), context());
    assert.deepEqual(replay, result);
    assert.equal(executions, 1);
    assert.deepEqual(
      recoveredLedger.events(toolInvocationKey(context(), "write_1")).map((event) => event.type),
      ["tool.started", "tool.completed"]
    );
    recoveredLedger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("in-doubt mutation is not repeated and conflicting reuse is rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-tool-ledger-doubt-"));
  const ledger = new SqliteToolLedger(join(root, "ledger.sqlite"));
  let executions = 0;
  try {
    const original = call("write_1", "one");
    ledger.begin({
      key: toolInvocationKey(context(), original.callId),
      fingerprint: toolInvocationFingerprint(original),
      callId: original.callId,
      toolName: original.name,
      runId: "run_1",
      sessionId: "session_1",
      replaySafe: false,
      occurredAt: "2026-07-11T00:00:00.000Z",
    });
    const recovered = broker(root, ledger, () => executions++);
    const uncertain = await recovered.invoke(original, context());
    assert.equal(uncertain.error?.code, "reconciliation_required");
    const conflict = await recovered.invoke(call("write_1", "different"), context());
    assert.equal(conflict.error?.code, "idempotency_conflict");
    assert.equal(executions, 0);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function broker(
  workspacePath: string,
  ledger: SqliteToolLedger,
  onExecute: () => void
): ToolBroker {
  const valueTool: NativeTool<{ value: string }> = {
    definition: {
      name: "write_value",
      description: "Perform one side effect",
      inputSchema: { type: "object" },
      readOnly: false,
      effect: "workspace",
    },
    validate: (input) =>
      typeof input === "object" &&
      input !== null &&
      typeof (input as { value?: unknown }).value === "string"
        ? { ok: true, value: input as { value: string } }
        : { ok: false, issues: ["value required"] },
    execute: async (input) => {
      onExecute();
      return {
        content: [{ type: "json", value: { written: input.value } }],
        isError: false,
      };
    },
  };
  const result = new ToolBroker({
    permissionProfile: "project",
    workspacePath,
    ledger,
  });
  result.register(valueTool);
  return result;
}

function call(callId: string, value: string): ToolCallBlock {
  return {
    type: "tool_call",
    callId,
    name: "write_value",
    arguments: { value },
  };
}

function context() {
  return {
    runId: "run_1",
    sessionId: "session_1",
    actor: { role: "worker" as const, id: "worker_1" },
  };
}
