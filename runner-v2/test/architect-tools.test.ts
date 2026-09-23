import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock, ToolExecutionContext } from "../src/agent-contracts.js";
import { createArchitectTools } from "../src/architect-tools.js";
import { parseArchitectActionReason } from "../src/user-steering-contracts.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { ToolRegistry } from "../src/tool-registry.js";

const RUN_ID = "run_architect_tools";
const CLOCK = () => "2026-09-23T00:00:00.000Z";

test("resolve_context_recording is only offered for a recording decision and appends one resolution", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-architect-recording-tool-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const absent = new ToolRegistry();
    for (const tool of createArchitectTools({
      store,
      clock: CLOCK,
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
    })) absent.register(tool);
    assert.equal(absent.definitions().some((tool) => tool.name === "resolve_context_recording"), false);

    store.append({
      runId: RUN_ID,
      type: "run.initialized",
      occurredAt: CLOCK(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "initialized",
      payload: {},
    });
    const noted = store.append({
      runId: RUN_ID,
      type: "context_manifest.recording_failed",
      occurredAt: CLOCK(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "note",
      payload: { purpose: "architect:plan_required", attempts: 3, reason: "disk full" },
    });
    store.append({
      runId: RUN_ID,
      type: "run.paused",
      occurredAt: CLOCK(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "pause",
      payload: { reason: "context_recording_failed" },
    });
    const reason = parseArchitectActionReason({
      type: "context_recording_decision_required",
      purpose: "architect:plan_required",
      attempts: 3,
      reason: "disk full",
      noteSequence: noted.sequence,
    });
    assert.equal(reason.type, "context_recording_decision_required");
    const registry = new ToolRegistry();
    for (const tool of createArchitectTools({
      store,
      clock: CLOCK,
      architectAction: { reason, sequence: noted.sequence },
    })) registry.register(tool);
    assert.equal(registry.definitions().some((tool) => tool.name === "resolve_context_recording"), true);
    assert.deepEqual(
      registry.definitions().map((tool) => tool.name).sort(),
      ["ask_user", "resolve_context_recording"],
    );
    const rationaleSchema = registry.definitions().find((tool) => tool.name === "resolve_context_recording")
      ?.inputSchema as { properties?: { rationale?: { minLength?: number } } };
    assert.equal(rationaleSchema.properties?.rationale?.minLength, 1);

    const emptyWaiver = await invoke(registry, "resolve_context_recording", {
      resolution: "proceed_without_manifest",
      rationale: "",
    });
    assert.equal(emptyWaiver.isError, true);
    assert.equal(emptyWaiver.error?.code, "invalid_arguments");
    const blankWaiver = await invoke(registry, "resolve_context_recording", {
      resolution: "proceed_without_manifest",
      rationale: "   ",
    });
    assert.equal(blankWaiver.isError, true);
    assert.equal(blankWaiver.error?.code, "invalid_arguments");
    assert.equal(
      store.readRun(RUN_ID).some((event) => event.type === "context_manifest.recording_resolved"),
      false,
    );

    const denied = await invoke(registry, "resolve_context_recording", {
      resolution: "retry",
      rationale: "Try again.",
    }, { role: "worker", id: "worker_1" });
    assert.equal(denied.isError, true);

    const resolved = await invoke(registry, "resolve_context_recording", {
      resolution: "retry",
      rationale: "Try again.",
    });
    assert.equal(resolved.isError, false, resolved.error?.message ?? "resolution failed");
    const events = store.readRun(RUN_ID).filter((event) => event.type === "context_manifest.recording_resolved");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.actor.role, "architect");
    assert.deepEqual(events[0]?.payload, {
      noteSequence: noted.sequence,
      resolution: "retry",
      rationale: "Try again.",
    });
    assert.equal(
      rebuildSchedulerProjection(store.readRun(RUN_ID)).contextRecording?.notes[0]?.resolution?.resolution,
      "retry",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function invoke(
  registry: ToolRegistry,
  name: string,
  argumentsValue: unknown,
  actor: ToolExecutionContext["actor"] = { role: "architect", id: "architect_1" },
) {
  const call: ToolCallBlock = {
    type: "tool_call",
    callId: `${name}:call`,
    name,
    arguments: argumentsValue,
  };
  return await registry.invoke(call, {
    runId: RUN_ID,
    sessionId: "architect:test",
    actor,
  });
}
