import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentMessage } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";

test("agent checkpoint and suspension rebuild exactly after store restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-agent-session-"));
  const database = join(root, "sessions.sqlite");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const messages: AgentMessage[] = [
    { id: "system", role: "system", content: "Use tools" },
    {
      id: "assistant",
      role: "assistant",
      content: [
        {
          type: "tool_call",
          callId: "pending_1",
          name: "fs.read",
          arguments: { path: "app.ts" },
        },
      ],
    },
  ];
  try {
    const first = new SqliteAgentSessionStore(database, artifacts);
    await first.create({
      sessionId: "session_1",
      runId: "run_1",
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-07-11T00:00:00.000Z",
    });
    await first.checkpoint(
      "session_1",
      { messages, turns: 1, seenCallIds: [] },
      "2026-07-11T00:00:01.000Z"
    );
    await first.checkpoint(
      "session_1",
      { messages, turns: 1, seenCallIds: [] },
      "2026-07-11T00:00:01.000Z"
    );
    first.suspend(
      "session_1",
      "provider_error",
      "usage limit",
      "2026-07-11T00:00:02.000Z"
    );
    first.close();

    const recovered = new SqliteAgentSessionStore(database, artifacts);
    const projection = await recovered.load("session_1");
    assert.equal(projection.status, "suspended");
    assert.equal(projection.suspensionReason, "provider_error");
    assert.equal(projection.error, "usage limit");
    assert.deepEqual(projection.checkpoint, {
      messages,
      turns: 1,
      seenCallIds: [],
    });
    assert.deepEqual(
      recovered.events("session_1").map((event) => event.type),
      ["session.created", "session.checkpointed", "session.suspended"]
    );
    recovered.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session event idempotency never hides conflicting creation data", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-agent-session-conflict-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const store = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  try {
    await store.create({
      sessionId: "session_1",
      runId: "run_1",
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-07-11T00:00:00.000Z",
    });
    await assert.rejects(
      store.create({
        sessionId: "session_1",
        runId: "different_run",
        actor: { role: "worker", id: "worker_1" },
        occurredAt: "2026-07-11T00:00:00.000Z",
      }),
      /idempotency conflict/i
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent session store lists durable projections by run", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-agent-session-list-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const store = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  try {
    await store.create({
      sessionId: "architect:run_1",
      runId: "run_1",
      actor: { role: "architect", id: "architect_1" },
      occurredAt: "2026-07-12T00:00:00.000Z",
    });
    await store.create({
      sessionId: "worker:run_2:task_a:1",
      runId: "run_2",
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-07-12T00:00:00.000Z",
    });
    const sessions = await store.listRun("run_1");
    assert.deepEqual(sessions.map((session) => session.sessionId), ["architect:run_1"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a resumed checkpoint clears stale suspension metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-agent-session-resume-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const store = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  try {
    await store.create({
      sessionId: "architect:run_1",
      runId: "run_1",
      actor: { role: "architect", id: "architect_1" },
      occurredAt: "2026-07-12T00:00:00.000Z",
    });
    store.suspend(
      "architect:run_1",
      "provider_error",
      "temporary outage",
      "2026-07-12T00:00:01.000Z"
    );
    await store.checkpoint(
      "architect:run_1",
      { messages: [], turns: 2, seenCallIds: [] },
      "2026-07-12T00:00:02.000Z"
    );
    const resumed = await store.load("architect:run_1");
    assert.equal(resumed.status, "active");
    assert.equal(resumed.suspensionReason, undefined);
    assert.equal(resumed.error, undefined);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
