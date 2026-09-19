import assert from "node:assert/strict";
import test from "node:test";
import { withLanguageAgentLifecycle } from "../src/language-agent-lifecycle.js";
const owner = { runId: "run", sessionId: "agent", actor: { role: "worker" as const, id: "worker" } };
test("LSP agent boundary joins only the original exact language owner before returning", async () => {
  let release!: () => void; const pending = new Promise<void>((r) => { release = r; }); let closed = false; let returned = false;
  const operation = withLanguageAgentLifecycle({ closeAgent: async (actual) => { assert.deepEqual(actual, owner); assert.ok(Object.isFrozen(actual)); await pending; closed = true; } }, owner, async () => 42).then((value) => { returned = true; return value; });
  try { await Promise.resolve(); assert.equal(returned, false); } finally { release(); }
  assert.equal(await operation, 42); assert.equal(closed, true);
});
for (const failure of [undefined, false, new Error("agent failed")]) test(`LSP agent exit retains primary ${String(failure)} and cleanup failures`, async () => {
  const cleanup = new Error("cleanup unverified");
  const result = await withLanguageAgentLifecycle({ closeAgent: async () => { throw cleanup; } }, owner, async () => { throw failure; }).then(() => assert.fail("failure swallowed"), (error: unknown) => error);
  assert.ok(result instanceof AggregateError); assert.deepEqual(result.errors, [failure, cleanup]);
});
test("LSP-free agent lifecycles do not add side effects", async () => { assert.equal(await withLanguageAgentLifecycle(undefined, owner, async () => 3), 3); });
