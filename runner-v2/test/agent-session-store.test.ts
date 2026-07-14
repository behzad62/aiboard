import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { AgentMessage } from "../src/agent-contracts.js";
import {
  ArtifactNotFoundError,
  ArtifactStore,
} from "../src/artifact-store.js";
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

test("transcript projects only stable assistant text turns across agent roles", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-agent-transcript-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const store = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  const architectMessages: AgentMessage[] = [
    { id: "system", role: "system", content: "System prompt" },
    { id: "context", role: "user", content: "Build context" },
    {
      id: "architect-turn-1",
      role: "assistant",
      content: [
        { type: "text", text: "Inspecting the project." },
        {
          type: "tool_call",
          callId: "architect-read",
          name: "fs.read",
          arguments: { path: "app.ts" },
        },
        { type: "text", text: "The plan is ready." },
      ],
    },
    {
      id: "architect-tool-only",
      role: "assistant",
      content: [
        {
          type: "tool_call",
          callId: "architect-status",
          name: "git.status",
          arguments: {},
        },
      ],
    },
    { id: "tool-result", role: "tool", content: "tool output" },
    {
      id: "000-architect-turn-same-checkpoint",
      role: "assistant",
      content: "Second response in the same checkpoint.",
    },
  ];

  try {
    await store.create({
      sessionId: "architect:run_1",
      runId: "run_1",
      actor: { role: "architect", id: "architect_1" },
      occurredAt: "2026-07-14T00:00:00.000Z",
    });
    await store.checkpoint(
      "architect:run_1",
      { messages: architectMessages, turns: 1, seenCallIds: [] },
      "2026-07-14T00:00:01.000Z"
    );
    await store.create({
      sessionId: "worker:run_1:task_1:1",
      runId: "run_1",
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-07-14T00:00:02.000Z",
    });
    await store.checkpoint(
      "worker:run_1:task_1:1",
      {
        messages: [
          {
            id: "worker-turn-1",
            role: "assistant",
            content: [
              { type: "text", text: "Implemented the change." },
              {
                type: "tool_call",
                callId: "worker-test",
                name: "process.exec",
                arguments: { command: "npm test" },
              },
            ],
          },
        ],
        turns: 1,
        seenCallIds: [],
      },
      "2026-07-14T00:00:03.000Z"
    );
    await store.create({
      sessionId: "subagent:run_1:task_1:research",
      runId: "run_1",
      actor: { role: "subagent", id: "researcher_1" },
      occurredAt: "2026-07-14T00:00:04.000Z",
    });
    await store.checkpoint(
      "subagent:run_1:task_1:research",
      {
        messages: [
          {
            id: "subagent-turn-1",
            role: "assistant",
            content: [
              { type: "text", text: "Found the relevant module." },
              {
                type: "tool_call",
                callId: "subagent-search",
                name: "fs.search",
                arguments: { query: "checkpoint" },
              },
            ],
          },
        ],
        turns: 1,
        seenCallIds: [],
      },
      "2026-07-14T00:00:05.000Z"
    );

    const initial = await store.transcript("run_1", 0);
    assert.deepEqual(initial, {
      turns: [
        {
          id: "architect:run_1:architect-turn-1",
          sessionId: "architect:run_1",
          actor: { role: "architect", id: "architect_1" },
          sequence: 2,
          ordinal: 2,
          occurredAt: "2026-07-14T00:00:01.000Z",
          text: "Inspecting the project.\nThe plan is ready.",
        },
        {
          id: "architect:run_1:000-architect-turn-same-checkpoint",
          sessionId: "architect:run_1",
          actor: { role: "architect", id: "architect_1" },
          sequence: 2,
          ordinal: 5,
          occurredAt: "2026-07-14T00:00:01.000Z",
          text: "Second response in the same checkpoint.",
        },
        {
          id: "worker:run_1:task_1:1:worker-turn-1",
          sessionId: "worker:run_1:task_1:1",
          actor: { role: "worker", id: "worker_1" },
          sequence: 4,
          ordinal: 0,
          occurredAt: "2026-07-14T00:00:03.000Z",
          text: "Implemented the change.",
        },
        {
          id: "subagent:run_1:task_1:research:subagent-turn-1",
          sessionId: "subagent:run_1:task_1:research",
          actor: { role: "subagent", id: "researcher_1" },
          sequence: 6,
          ordinal: 0,
          occurredAt: "2026-07-14T00:00:05.000Z",
          text: "Found the relevant module.",
        },
      ],
      cursor: 6,
    });

    await store.checkpoint(
      "architect:run_1",
      {
        messages: [
          ...architectMessages,
          {
            id: "architect-turn-2",
            role: "assistant",
            content: "Review passed.",
          },
        ],
        turns: 2,
        seenCallIds: [],
      },
      "2026-07-14T00:00:06.000Z"
    );

    assert.deepEqual(await store.transcript("run_1", initial.cursor), {
      turns: [
        {
          id: "architect:run_1:architect-turn-2",
          sessionId: "architect:run_1",
          actor: { role: "architect", id: "architect_1" },
          sequence: 7,
          ordinal: 6,
          occurredAt: "2026-07-14T00:00:06.000Z",
          text: "Review passed.",
        },
      ],
      cursor: 7,
    });
    const completeBeforeCompaction = await store.transcript("run_1", 0);
    assert.deepEqual(
      completeBeforeCompaction.turns.map((turn) => turn.id),
      [
        "architect:run_1:architect-turn-1",
        "architect:run_1:000-architect-turn-same-checkpoint",
        "worker:run_1:task_1:1:worker-turn-1",
        "subagent:run_1:task_1:research:subagent-turn-1",
        "architect:run_1:architect-turn-2",
      ]
    );
    await store.compactRun("run_1");
    assert.deepEqual(await store.transcript("run_1", 0), completeBeforeCompaction);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compacting a run retains its latest full checkpoint and removes superseded artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-agent-compaction-"));
  const database = join(root, "sessions.sqlite");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const sessionId = "worker:run_1:task_1:1";
  const messages: AgentMessage[] = [];
  const cleanup = {
    deleteArtifactIfGloballyUnreachable: async (hash: string) => {
      await artifacts.remove(hash);
      return true;
    },
  };
  let store = new SqliteAgentSessionStore(database, artifacts, cleanup);

  try {
    await store.create({
      sessionId,
      runId: "run_1",
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-07-14T01:00:00.000Z",
    });
    for (let turn = 1; turn <= 3; turn += 1) {
      messages.push({
        id: `worker-turn-${turn}`,
        role: "assistant",
        content: `Durable response ${turn}`,
      });
      await store.checkpoint(
        sessionId,
        { messages: [...messages], turns: turn, seenCallIds: [] },
        `2026-07-14T01:00:0${turn}.000Z`
      );
    }
    const checkpointHashes = store
      .events(sessionId)
      .filter((event) => event.type === "session.checkpointed")
      .map((event) => event.artifactHash!);
    assert.equal(checkpointHashes.length, 3);
    const incrementalBeforeCompaction = await store.transcript("run_1", 2);

    await store.compactRun("run_1");
    store.close();

    store = new SqliteAgentSessionStore(database, artifacts, cleanup);
    assert.deepEqual(
      (await store.transcript("run_1", 0)).turns.map((turn) => turn.text),
      ["Durable response 1", "Durable response 2", "Durable response 3"]
    );
    assert.deepEqual(
      await store.transcript("run_1", 2),
      incrementalBeforeCompaction
    );
    assert.deepEqual(
      store.events(sessionId).map((event) => event.type),
      ["session.created", "session.checkpointed"]
    );
    for (const hash of checkpointHashes.slice(0, 2)) {
      await assert.rejects(
        artifacts.get(hash),
        (error: unknown) => error instanceof ArtifactNotFoundError
      );
      await assert.rejects(
        artifacts.stat(hash),
        (error: unknown) => error instanceof ArtifactNotFoundError
      );
    }
    await artifacts.verify(checkpointHashes[2]!);

    await store.compactRun("run_1");
    await artifacts.verify(checkpointHashes[2]!);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction retains candidates without global proof and retries false decisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-agent-global-proof-"));
  const database = join(root, "sessions.sqlite");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const sessionId = "worker:run_1:task_1:1";
  let store = new SqliteAgentSessionStore(database, artifacts);
  try {
    await store.create({
      sessionId,
      runId: "run_1",
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-07-14T02:00:00.000Z",
    });
    await store.checkpoint(
      sessionId,
      {
        messages: [{ id: "turn-1", role: "assistant", content: "one" }],
        turns: 1,
        seenCallIds: [],
      },
      "2026-07-14T02:00:01.000Z"
    );
    await store.checkpoint(
      sessionId,
      {
        messages: [{ id: "turn-2", role: "assistant", content: "two" }],
        turns: 2,
        seenCallIds: [],
      },
      "2026-07-14T02:00:02.000Z"
    );
    const candidateHash = store.events(sessionId)[1]!.artifactHash!;

    await store.compactRun("run_1");
    await artifacts.verify(candidateHash);
    store.close();

    store = new SqliteAgentSessionStore(database, artifacts, {
      deleteArtifactIfGloballyUnreachable: async () => false,
    });
    await store.compactRun("run_1");
    await artifacts.verify(candidateHash);
    store.close();

    store = new SqliteAgentSessionStore(database, artifacts, {
      deleteArtifactIfGloballyUnreachable: async (hash) => {
        await artifacts.remove(hash);
        return true;
      },
    });
    await store.compactRun("run_1");
    await assert.rejects(
      artifacts.get(candidateHash),
      (error: unknown) => error instanceof ArtifactNotFoundError
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction retries durable global deletion after a callback failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-agent-cleanup-retry-"));
  const database = join(root, "sessions.sqlite");
  const artifactRoot = join(root, "artifacts");
  const artifacts = new ArtifactStore(artifactRoot);
  let fail = true;
  let store = new SqliteAgentSessionStore(database, artifacts, {
    deleteArtifactIfGloballyUnreachable: async (hash) => {
      if (fail) {
        fail = false;
        throw new Error("injected global deletion failure");
      }
      await artifacts.remove(hash);
      return true;
    },
  });
  const sessionId = "worker:run_1:task_1:1";
  try {
    await store.create({
      sessionId,
      runId: "run_1",
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-07-14T02:00:00.000Z",
    });
    await store.checkpoint(
      sessionId,
      {
        messages: [{ id: "turn-1", role: "assistant", content: "one" }],
        turns: 1,
        seenCallIds: [],
      },
      "2026-07-14T02:00:01.000Z"
    );
    await store.checkpoint(
      sessionId,
      {
        messages: [
          { id: "turn-1", role: "assistant", content: "one" },
          { id: "turn-2", role: "assistant", content: "two" },
        ],
        turns: 2,
        seenCallIds: [],
      },
      "2026-07-14T02:00:02.000Z"
    );
    const supersededHash = store.events(sessionId)[1]!.artifactHash!;
    await assert.rejects(
      store.compactRun("run_1"),
      /injected global deletion failure/
    );
    assert.equal((await artifacts.get(supersededHash)).byteLength > 0, true);
    store.close();

    store = new SqliteAgentSessionStore(database, artifacts, {
      deleteArtifactIfGloballyUnreachable: async (hash) => {
        await artifacts.remove(hash);
        return true;
      },
    });
    await store.compactRun("run_1");
    await assert.rejects(
      artifacts.get(supersededHash),
      (error: unknown) => error instanceof ArtifactNotFoundError
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction preserves fallback checkpoints when the latest artifact is corrupt", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-agent-invalid-latest-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const store = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  const sessionId = "worker:run_1:task_1:1";
  try {
    await store.create({
      sessionId,
      runId: "run_1",
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-07-14T03:00:00.000Z",
    });
    for (let turn = 1; turn <= 3; turn += 1) {
      await store.checkpoint(
        sessionId,
        {
          messages: [
            { id: `turn-${turn}`, role: "assistant", content: `turn ${turn}` },
          ],
          turns: turn,
          seenCallIds: [],
        },
        `2026-07-14T03:00:0${turn}.000Z`
      );
    }
    const checkpoints = store
      .events(sessionId)
      .filter((event) => event.type === "session.checkpointed");
    const latest = await artifacts.stat(checkpoints[2]!.artifactHash!);
    writeFileSync(latest.path, "corrupt latest checkpoint");

    await assert.rejects(store.compactRun("run_1"), /hash mismatch/i);
    assert.equal(
      store.events(sessionId).filter((event) => event.type === "session.checkpointed")
        .length,
      3
    );
    await artifacts.verify(checkpoints[0]!.artifactHash!);
    await artifacts.verify(checkpoints[1]!.artifactHash!);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction aborts if the validated latest checkpoint changes before deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-agent-compaction-race-"));
  const database = join(root, "sessions.sqlite");
  const sessionId = "worker:run_1:task_1:1";

  class CheckpointOnVerifyArtifactStore extends ArtifactStore {
    triggerHash?: string;
    onTrigger?: () => Promise<void>;
    triggered = false;

    override async verify(hash: string) {
      const record = await super.verify(hash);
      if (hash === this.triggerHash && !this.triggered) {
        this.triggered = true;
        await this.onTrigger?.();
      }
      return record;
    }
  }

  const artifacts = new CheckpointOnVerifyArtifactStore(join(root, "artifacts"));
  const compactor = new SqliteAgentSessionStore(database, artifacts);
  const writer = new SqliteAgentSessionStore(database, artifacts);
  try {
    await compactor.create({
      sessionId,
      runId: "run_1",
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-07-14T04:00:00.000Z",
    });
    await compactor.checkpoint(
      sessionId,
      {
        messages: [{ id: "turn-1", role: "assistant", content: "one" }],
        turns: 1,
        seenCallIds: [],
      },
      "2026-07-14T04:00:01.000Z"
    );
    await compactor.checkpoint(
      sessionId,
      {
        messages: [{ id: "turn-2", role: "assistant", content: "two" }],
        turns: 2,
        seenCallIds: [],
      },
      "2026-07-14T04:00:02.000Z"
    );
    artifacts.triggerHash = compactor.events(sessionId)[2]!.artifactHash!;
    artifacts.onTrigger = async () => {
      await writer.checkpoint(
        sessionId,
        {
          messages: [{ id: "turn-3", role: "assistant", content: "three" }],
          turns: 3,
          seenCallIds: [],
        },
        "2026-07-14T04:00:03.000Z"
      );
    };

    await assert.rejects(
      compactor.compactRun("run_1"),
      /changed during compaction/i
    );
    assert.equal(
      compactor
        .events(sessionId)
        .filter((event) => event.type === "session.checkpointed").length,
      3
    );
  } finally {
    writer.close();
    compactor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("idempotent checkpoint replay preserves the durable event timestamp", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-agent-replay-time-"));
  const database = join(root, "sessions.sqlite");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const sessionId = "worker:run_1:task_1:1";
  const checkpoint = {
    messages: [{ id: "turn-1", role: "assistant" as const, content: "one" }],
    turns: 1,
    seenCallIds: [],
  };
  let store = new SqliteAgentSessionStore(database, artifacts);
  try {
    await store.create({
      sessionId,
      runId: "run_1",
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-07-14T05:00:00.000Z",
    });
    await store.checkpoint(
      sessionId,
      checkpoint,
      "2026-07-14T05:00:01.000Z"
    );
    store.close();

    const databaseHandle = new DatabaseSync(database);
    databaseHandle.exec(`
      DELETE FROM agent_transcript_turns;
      DELETE FROM agent_transcript_checkpoints;
    `);
    databaseHandle.close();

    store = new SqliteAgentSessionStore(database, artifacts);
    await store.checkpoint(
      sessionId,
      checkpoint,
      "2026-07-14T05:59:59.000Z"
    );
    assert.equal(
      (await store.transcript("run_1", 0)).turns[0]!.occurredAt,
      "2026-07-14T05:00:01.000Z"
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint rejects an unknown session before writing an artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-agent-missing-session-"));
  const artifactRoot = join(root, "artifacts");
  const store = new SqliteAgentSessionStore(
    join(root, "sessions.sqlite"),
    new ArtifactStore(artifactRoot)
  );
  try {
    await assert.rejects(
      store.checkpoint(
        "missing-session",
        { messages: [], turns: 0, seenCallIds: [] },
        "2026-07-14T06:00:00.000Z"
      ),
      /unknown agent session/i
    );
    assert.equal(existsSync(artifactRoot), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("replaying a compacted checkpoint cannot roll back the retained session", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-agent-compacted-replay-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const store = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  const sessionId = "worker:run_1:task_1:1";
  const checkpointA = {
    messages: [{ id: "turn-a", role: "assistant" as const, content: "A" }],
    turns: 1,
    seenCallIds: [],
  };
  const checkpointB = {
    messages: [
      ...checkpointA.messages,
      { id: "turn-b", role: "assistant" as const, content: "B" },
    ],
    turns: 2,
    seenCallIds: [],
  };
  try {
    await store.create({
      sessionId,
      runId: "run_1",
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-07-14T07:00:00.000Z",
    });
    await store.checkpoint(
      sessionId,
      checkpointA,
      "2026-07-14T07:00:01.000Z"
    );
    await store.checkpoint(
      sessionId,
      checkpointB,
      "2026-07-14T07:00:02.000Z"
    );
    await store.compactRun("run_1");
    const eventsBeforeReplay = store.events(sessionId);
    const transcriptBeforeReplay = await store.transcript("run_1", 0);
    assert.deepEqual((await store.load(sessionId)).checkpoint, checkpointB);

    await store.checkpoint(
      sessionId,
      checkpointA,
      "2026-07-14T07:59:59.000Z"
    );

    assert.deepEqual((await store.load(sessionId)).checkpoint, checkpointB);
    assert.deepEqual(store.events(sessionId), eventsBeforeReplay);
    assert.deepEqual(await store.transcript("run_1", 0), transcriptBeforeReplay);

    await store.compactRun("run_1");
    assert.deepEqual((await store.load(sessionId)).checkpoint, checkpointB);
    assert.deepEqual(store.events(sessionId), eventsBeforeReplay);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
