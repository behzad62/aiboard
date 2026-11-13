import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PlaywrightCliSessions } from "../src/playwright-cli.js";

import {
  closeRunnerResources,
  reconcileRunnerStartup,
  RunnerCleanupBlockedError,
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
test("Runner startup reconciliation covers every owned external resource class before accepting work", async () => {
  const events: string[] = [];
  await reconcileRunnerStartup([
    reconciler("processes", events, ["processes"]),
    reconciler("backends", events, ["backends"]),
    reconciler("isolation", events, ["isolation"]),
    reconciler("grants", events, ["grants"]),
    reconciler("spills", events, ["spills"]),
    reconciler("temp-roots", events, ["tempRoots"]),
  ]);
  assert.deepEqual(events, ["processes", "backends", "isolation", "grants", "spills", "temp-roots"]);
});

test("Runner startup reconciliation fails closed with a typed blocker and does not accept later resources", async () => {
  const events: string[] = [];
  await assert.rejects(
    reconcileRunnerStartup([
      reconciler("processes", events, ["processes"]),
      reconciler("backends", events, ["backends"], true),
      reconciler("isolation", events, ["isolation"]),
      reconciler("grants", events, ["grants"]),
      reconciler("spills", events, ["spills"]),
      reconciler("temp-roots", events, ["tempRoots"]),
    ]),
    (error: unknown) => {
      assert.ok(error instanceof RunnerCleanupBlockedError);
      assert.equal(error.code, "runner_startup_reconciliation_blocked");
      assert.deepEqual(error.blockers.map((blocker) => blocker.resource), ["backends"]);
      return true;
    },
  );
  assert.deepEqual(events, ["processes", "backends"]);
});

test("Runner shutdown cleanup is retryable and idempotent after a typed blocker", async () => {
  const events: string[] = [];
  let factoryAttempts = 0;
  const resources: RunnerResources = {
    supervisor: closeable("supervisor", events),
    buildFactory: {
      close: async () => {
        factoryAttempts += 1;
        events.push(`factory:${factoryAttempts}`);
        if (factoryAttempts === 1) throw new Error("factory still owns a process");
      },
    },
    server: closeable("server", events),
  };

  await assert.rejects(
    closeRunnerResources(resources),
    (error: unknown) => {
      assert.ok(error instanceof RunnerCleanupBlockedError);
      assert.equal(error.code, "runner_shutdown_cleanup_blocked");
      assert.deepEqual(error.blockers.map((blocker) => blocker.resource), ["buildFactory"]);
      return true;
    },
  );
  await closeRunnerResources(resources);
  await closeRunnerResources(resources);
  assert.deepEqual(events, ["server", "factory:1", "supervisor", "factory:2"]);
});

function reconciler(name: string, events: string[], covers: readonly ("processes" | "backends" | "isolation" | "grants" | "spills" | "tempRoots")[], fail = false): { resource: string; covers: readonly ("processes" | "backends" | "isolation" | "grants" | "spills" | "tempRoots")[]; reconcile(): Promise<void> } {
  return {
    resource: name,
    covers,
    reconcile: async () => {
      events.push(name);
      if (fail) throw new Error(`${name} reconciliation failed`);
    },
  };
}

test("VF7b startup removes the Playwright CLI state a crashed Runner left, keeps a folder a live process still names, and never throws", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-pw-reconcile-"));
  try {
    const stale = join(root, "r-aaaaaaaaaaaa");
    const live = join(root, "r-bbbbbbbbbbbb");
    const other = join(root, "bin");
    for (const folder of [join(stale, "t-00000001", "tmp"), join(live, "t-00000002", "tmp"), other]) mkdirSync(folder, { recursive: true });
    let rows: Array<{ pid: number; groupId: number; birth: string; uid: number; command: string }> | undefined = [
      { pid: 41, groupId: 41, birth: "b41", uid: 1000, command: `/usr/bin/chrome --user-data-dir=${join(live, "t-00000002", "tmp", "profile")}` },
    ];
    const sessions = (platform: NodeJS.Platform) => new PlaywrightCliSessions({
      stateRoot: root,
      binDirectory: other,
      platform,
      processes: {
        list: () => rows,
        inspect: () => { throw new Error("startup does not signal"); },
        kill: () => { throw new Error("startup does not signal"); },
        uid: () => 1000,
      },
    });
    const result = sessions("linux").reconcileStartup();
    assert.deepEqual(result.removed, [stale]);
    assert.deepEqual(result.kept, [live]);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(live), true, "a live process still names it");
    assert.equal(existsSync(other), true, "only the Runner's own r-<hex> run folders are touched");
    // A process table that cannot be read keeps every folder.
    rows = undefined;
    assert.deepEqual(sessions("linux").reconcileStartup(), { removed: [], kept: [live] });
    // A missing state root is nothing to do.
    assert.deepEqual(new PlaywrightCliSessions({ stateRoot: join(root, "absent"), binDirectory: other }).reconcileStartup(), { removed: [], kept: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
