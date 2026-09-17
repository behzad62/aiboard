import assert from "node:assert/strict";
import test from "node:test";
import { withMcpAgentLifecycle } from "../src/mcp-agent-lifecycle.js";
const owner = { runId: "run", sessionId: "real-agent-session", actor: { role: "subagent" as const, id: "parent:call" } };

test("MCP agent boundary awaits exact owned cleanup before returning the original result", async () => {
  let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
  let closed = false; let returned = false;
  const result = withMcpAgentLifecycle({ closeAgent: async (actual) => { assert.deepEqual(actual, owner); await pending; closed = true; } }, owner,
    async () => "agent-result").then((value) => { returned = true; return value; });
  try { await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(returned, false); }
  finally { release(); }
  assert.equal(await result, "agent-result"); assert.equal(closed, true);
});
for (const failure of [undefined, null, false, "", new Error("agent failed")])
test(`MCP agent boundary preserves ${String(failure)} and cleanup failure without inventing success`, async () => {
  const cleanup = new Error("exact session remains owned");
  await assert.rejects(withMcpAgentLifecycle({ closeAgent: async () => { throw cleanup; } }, owner, async () => { throw failure; }),
    (error: unknown) => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === failure && error.errors[1] === cleanup);
});

test("MCP absent manager leaves non-MCP agents unchanged", async () => {
  assert.equal(await withMcpAgentLifecycle(undefined, owner, async () => 42), 42);
  await assert.rejects(withMcpAgentLifecycle(undefined, owner, async () => { throw undefined; }), (reason: unknown) => reason === undefined);
});
