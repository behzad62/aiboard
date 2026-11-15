import assert from "node:assert/strict";
import test from "node:test";

import { withLanguageAgentLifecycle } from "../src/language-agent-lifecycle.js";
import { ManagedBuildToolRuntime } from "../src/managed-build-tools.js";
import { withMcpAgentLifecycle } from "../src/mcp-agent-lifecycle.js";
import {
  AgentCleanupUnverifiedError,
  isProcessStopUnprovenError,
  withManagedProcessAgentLifecycle,
} from "../src/process-stop-proof.js";
import { ToolBroker } from "../src/tool-broker.js";

const owner = Object.freeze({ runId: "run_1", sessionId: "worker-session:subagent:call_1", actor: Object.freeze({ role: "subagent" as const, id: "worker_1:call_1" }) });
const options = { permissionProfile: "full" as const, workspacePath: process.cwd() };

test("an unproven stop is told apart from an ordinary failure", () => {
  const unverified = Object.assign(new Error("Shared managed cleanup did not prove release."), { code: "process_cleanup_unverified" });
  assert.equal(isProcessStopUnprovenError(unverified), true);
  assert.equal(isProcessStopUnprovenError(new AggregateError([unverified], "Managed process cleanup remains unverified.")), true);
  assert.equal(isProcessStopUnprovenError(new Error("wrapped", { cause: unverified })), true);
  assert.equal(isProcessStopUnprovenError(new AgentCleanupUnverifiedError([new Error("closeVerified failed")], "Agent MCP cleanup remains unverified.")), true);
  assert.equal(isProcessStopUnprovenError(new AggregateError([new Error("tests failed")], "plain")), false);
  assert.equal(isProcessStopUnprovenError(new Error("workspace creation failed")), false);
  const cyclic: Error & { cause?: unknown } = new Error("cyclic");
  cyclic.cause = cyclic;
  assert.equal(isProcessStopUnprovenError(cyclic), false, "a cyclic cause ends");
});

test("every agent cleanup wrapper marks its failure as an unproven stop and keeps the message", async () => {
  const failing = { closeAgent: async () => { throw new Error("still running"); } };
  for (const [name, run, message] of [
    ["language", () => withLanguageAgentLifecycle(failing, owner, async () => 1), "Agent language-server cleanup remains unverified."],
    ["mcp", () => withMcpAgentLifecycle(failing, owner, async () => 1), "Agent MCP cleanup remains unverified."],
    ["managed processes", () => withManagedProcessAgentLifecycle(failing, owner, async () => 1), "Agent managed-process cleanup remains unverified."],
  ] as const) {
    await assert.rejects(run(), (error: unknown) =>
      error instanceof AgentCleanupUnverifiedError && error instanceof AggregateError && error.message === message, name);
  }
});

test("a subagent's managed processes are stopped under its exact owner, after its loop, keeping a primary failure", async () => {
  const order: string[] = [];
  const closed: unknown[] = [];
  const processes = { closeAgent: async (actual: unknown) => { order.push("close"); closed.push(actual); } };
  assert.equal(await withManagedProcessAgentLifecycle(processes, owner, async () => { order.push("loop"); return 7; }), 7);
  assert.deepEqual(order, ["loop", "close"]);
  assert.deepEqual(closed, [owner]);
  const primary = new Error("model failed");
  await assert.rejects(withManagedProcessAgentLifecycle(processes, owner, async () => { throw primary; }), (error: unknown) => error === primary);
});

test("a managed Build tool candidate whose disposal failed is retried by close, never dropped", async () => {
  let generation = 1;
  let candidateCloses = 0;
  let candidateFails = true;
  const runtime = new ManagedBuildToolRuntime(new ToolBroker(options), {
    generation: async () => generation,
    tools: async (g) => g === 1
      ? { tools: [], close: async () => { throw new Error("current close failed"); } }
      : {
          tools: [],
          close: async () => {
            candidateCloses += 1;
            if (candidateFails) throw new Error("candidate close failed");
          },
        },
  }, options, () => true);
  await runtime.prepare();
  generation = 2;
  await assert.rejects(runtime.prepare(), (error: unknown) => error instanceof AgentCleanupUnverifiedError);
  assert.equal(candidateCloses, 1);
  await assert.rejects(runtime.close(), (error: unknown) => isProcessStopUnprovenError(error),
    "the current surface and the orphan both failed again");
  assert.equal(candidateCloses, 2, "close retried the orphaned candidate");
  candidateFails = false;
  await assert.rejects(runtime.close(), /current close failed/, "the current surface is still not closed");
  assert.equal(candidateCloses, 3);
  await assert.rejects(runtime.close(), /current close failed/);
  assert.equal(candidateCloses, 3, "a candidate closed once is not closed again");
});
