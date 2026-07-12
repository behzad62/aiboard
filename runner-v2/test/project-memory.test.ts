import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMemoryTools } from "../src/memory-tools.js";
import { SqliteProjectMemoryStore } from "../src/sqlite-project-memory.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("worker proposals require Architect promotion and survive restart", async () => {
  const fixture = memoryFixture();
  try {
    let store = new SqliteProjectMemoryStore(fixture.database);
    const worker = registry(store, "project_a", "worker");
    const proposed = await invoke(worker, "worker", "propose_project_memory", {
      content: "Use npm run focused-test before the full suite.",
      concepts: ["testing", "npm"],
      workspaceRevision: "abc123",
      confidence: 0.9,
      evidenceIds: ["evidence_test_output"],
      supersedes: ["memory_old_testing_note"],
    });
    assert.equal(proposed.isError, false);
    const memoryId = (jsonValue(proposed) as { memoryId: string }).memoryId;
    const proposal = store.proposals("project_a")[0];
    assert.equal(proposal.workspaceRevision, "abc123");
    assert.equal(proposal.confidence, 0.9);
    assert.deepEqual(proposal.evidenceIds, ["evidence_test_output"]);
    assert.deepEqual(proposal.supersedes, ["memory_old_testing_note"]);

    const hidden = await invoke(worker, "worker", "recall_project_memory", {
      query: "focused test",
      concepts: ["testing"],
      limit: 5,
    });
    assert.deepEqual(jsonValue(hidden), []);

    const denied = await invoke(worker, "worker", "promote_project_memory", {
      memoryId,
    });
    assert.equal(denied.isError, true);
    assert.match(denied.error?.message ?? "", /only the Architect/i);

    const architect = registry(store, "project_a", "architect");
    const promoted = await invoke(
      architect,
      "architect",
      "promote_project_memory",
      { memoryId }
    );
    assert.equal(promoted.isError, false);
    store.close();

    store = new SqliteProjectMemoryStore(fixture.database);
    const recovered = registry(store, "project_a", "worker");
    const recalled = await invoke(recovered, "worker", "recall_project_memory", {
      query: "focused test",
      concepts: ["testing"],
      limit: 5,
    });
    const results = jsonValue(recalled) as Array<{ id: string; status: string }>;
    assert.equal(results[0].id, memoryId);
    assert.equal(results[0].status, "promoted");
    store.close();
  } finally {
    fixture.cleanup();
  }
});

test("memory proposal tool rejects invalid provenance instead of silently storing it", async () => {
  const fixture = memoryFixture();
  const store = new SqliteProjectMemoryStore(fixture.database);
  try {
    const worker = registry(store, "project_a", "worker");
    const result = await invoke(worker, "worker", "propose_project_memory", {
      content: "Uncertain claim.",
      concepts: ["testing"],
      confidence: 2,
    });
    assert.equal(result.isError, true);
    assert.deepEqual(store.proposals("project_a"), []);
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test("memory never crosses project identity and lexical ranking is deterministic", async () => {
  const fixture = memoryFixture();
  const store = new SqliteProjectMemoryStore(fixture.database);
  try {
    const actor = { role: "architect" as const, id: "architect_1" };
    const first = store.propose({
      projectId: "project_a",
      runId: "run_1",
      actor,
      content: "SQLite migrations use WAL mode.",
      concepts: ["sqlite", "persistence"],
      workspaceRevision: "abc123",
      confidence: 0.8,
      evidenceIds: ["evidence_1"],
      supersedes: ["memory_legacy"],
      occurredAt: "2026-07-12T00:00:00.000Z",
      idempotencyKey: "proposal:first",
    });
    assert.equal(first.workspaceRevision, "abc123");
    assert.equal(first.confidence, 0.8);
    assert.deepEqual(first.evidenceIds, ["evidence_1"]);
    assert.deepEqual(first.supersedes, ["memory_legacy"]);
    store.promote({
      projectId: "project_a",
      memoryId: first.id,
      actor,
      occurredAt: "2026-07-12T00:00:01.000Z",
      idempotencyKey: "promote:first",
    });
    const second = store.propose({
      projectId: "project_a",
      runId: "run_1",
      actor,
      content: "General persistence notes.",
      concepts: ["persistence"],
      occurredAt: "2026-07-12T00:00:02.000Z",
      idempotencyKey: "proposal:second",
    });
    store.promote({
      projectId: "project_a",
      memoryId: second.id,
      actor,
      occurredAt: "2026-07-12T00:00:03.000Z",
      idempotencyKey: "promote:second",
    });
    assert.deepEqual(
      store.search({
        projectId: "project_a",
        query: "sqlite persistence",
        concepts: ["sqlite"],
        limit: 10,
      }).map((entry) => entry.id),
      [first.id, second.id]
    );
    assert.deepEqual(
      store.search({
        projectId: "project_b",
        query: "sqlite persistence",
        concepts: ["sqlite"],
        limit: 10,
      }),
      []
    );
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test("Architect can archive memory without turning memory tools into lifecycle authority", async () => {
  const fixture = memoryFixture();
  const store = new SqliteProjectMemoryStore(fixture.database);
  try {
    const architect = registry(store, "project_a", "architect");
    const proposed = await invoke(architect, "architect", "propose_project_memory", {
      content: "Temporary convention.",
      concepts: ["temporary"],
    });
    const memoryId = (jsonValue(proposed) as { memoryId: string }).memoryId;
    await invoke(architect, "architect", "promote_project_memory", { memoryId });
    const archived = await invoke(architect, "architect", "archive_project_memory", {
      memoryId,
      reason: "Convention was replaced.",
    });
    assert.equal(archived.isError, false);
    assert.equal(archived.lifecycle, undefined);
    assert.deepEqual(
      store.search({ projectId: "project_a", query: "temporary", limit: 5 }),
      []
    );
  } finally {
    store.close();
    fixture.cleanup();
  }
});

function registry(
  store: SqliteProjectMemoryStore,
  projectId: string,
  role: "worker" | "architect"
) {
  const registryValue = new ToolRegistry();
  for (const tool of createMemoryTools({
    store,
    projectId,
    runId: "run_1",
    taskId: role === "worker" ? "task_a" : undefined,
    clock: () => "2026-07-12T00:00:00.000Z",
  })) registryValue.register(tool);
  return registryValue;
}

async function invoke(
  registryValue: ToolRegistry,
  role: "worker" | "architect",
  name: string,
  argumentsValue: unknown
) {
  return await registryValue.invoke(
    {
      type: "tool_call",
      callId: `${name}:${Math.random()}`,
      name,
      arguments: argumentsValue,
    },
    {
      runId: "run_1",
      sessionId: `${role}_session`,
      actor: { role, id: `${role}_1` },
    }
  );
}

function jsonValue(result: Awaited<ReturnType<typeof invoke>>) {
  const block = result.content[0];
  assert.equal(block.type, "json");
  return block.type === "json" ? block.value : undefined;
}

function memoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "aiboard-project-memory-"));
  return {
    database: join(root, "memory.sqlite"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
