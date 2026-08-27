import assert from "node:assert/strict";
import test from "node:test";

import {
  closeRunnerResources,
  startupFailureWithCleanup,
  type RunnerResources,
} from "../src/runner-resource-cleanup.js";

test("Runner resource cleanup unwinds every acquired resource in reverse order after failures", async () => {
  const events: string[] = [];
  const resources: RunnerResources = {
    supervisor: closeable("supervisor", events),
    providerConfigs: closeable("provider-configs", events),
    mcpManager: closeable("mcp", events),
    permissions: closeable("permissions", events),
    buildFactory: closeable("factory", events, true),
    builds: closeable("builds", events),
    server: closeable("server", events, true),
  };

  const outcome = await closeRunnerResources(resources).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  assert.equal(outcome.ok, false);
  assert.deepEqual(events, [
    "server",
    "builds",
    "factory",
    "permissions",
    "mcp",
    "provider-configs",
    "supervisor",
  ]);
  assert.ok(outcome.error instanceof AggregateError);
  assert.equal(outcome.error.errors.length, 2);
});

test("Runner resource cleanup closes partial startup ownership including untransferred provider configuration", async () => {
  const events: string[] = [];
  await closeRunnerResources({
    supervisor: closeable("supervisor", events),
    providerConfigs: closeable("provider-configs", events),
    mcpManager: closeable("mcp", events),
  });
  assert.deepEqual(events, ["mcp", "provider-configs", "supervisor"]);
});

test("Runner startup failure retains both the original failure and cleanup aggregate", () => {
  const startup = new Error("extension startup failed");
  const cleanup = new AggregateError([new Error("MCP close failed")], "Cleanup failed");
  const combined = startupFailureWithCleanup(startup, cleanup);

  assert.ok(combined instanceof AggregateError);
  assert.equal(combined.errors[0], startup);
  assert.equal(combined.errors[1], cleanup);
  assert.match(combined.message, /extension startup failed/i);
  assert.match(combined.message, /cleanup failed/i);
});

function closeable(name: string, events: string[], fail = false): { close(): Promise<void> } {
  return {
    close: async () => {
      events.push(name);
      if (fail) throw new Error(`${name} close failed`);
    },
  };
}
