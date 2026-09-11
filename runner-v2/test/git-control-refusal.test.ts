import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlServer } from "../src/control-server.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { ExecutionIsolationError } from "../src/execution-isolation-provider.js";

for (const actual of [true, false]) test(`Git bootstrap API preserves ${actual ? "typed strict refusal" : "untrusted-error redaction"}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p6-git-control-"));
  t.diagnostic(`exact control fixture acquired: ${root}`);
  const supervisor = new RunSupervisor(new SqliteEventStore(join(root, "events.sqlite")));
  const error = actual
    ? new ExecutionIsolationError("isolation_capability_unavailable", "private error detail must not be projected")
    : Object.assign(new Error("private error detail must not be projected"), { code: "isolation_capability_unavailable" });
  let bootstraps = 0;
  const server = new ControlServer({ supervisor, token: "test-private-control-token",
    checkGit: async () => ({ available: true, version: "2.45.1", code: "git_ready", reason: null }),
    bootstrapRun: async () => { bootstraps++; throw error; },
  });
  let passed = false;
  try {
    const address = await server.start(0);
    const response = await fetch(`${address.url}/v2/runs`, { method: "POST",
      headers: { Authorization: "Bearer test-private-control-token", "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "strict-refusal", projectPath: root, permissionProfile: "project", idempotencyKey: "strict-refusal" }),
    });
    const result = await response.json() as { code: string; error: string };
    assert.equal(response.status, actual ? 412 : 500);
    assert.equal(result.code, actual ? "isolation_capability_unavailable" : "internal_error");
    assert.equal(JSON.stringify(result).includes("private error detail"), false);
    assert.equal(bootstraps, 1, "no retry with a weaker profile is allowed");
    assert.equal(supervisor.getRun("strict-refusal").state, "failed");
    passed = true;
  } finally {
    await server.close(); supervisor.close();
    if (passed) { await rm(root, { recursive: true }); t.diagnostic(`control fixture closed and removed: ${root}`); }
  }
});
