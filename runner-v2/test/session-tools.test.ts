import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createSessionTools } from "../src/session-tools.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("agents can search their own durable raw history after working-set compaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-session-history-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  try {
    await sessions.create({
      sessionId: "worker:run_1:T1:1",
      runId: "run_1",
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-07-12T00:00:00.000Z",
    });
    await sessions.checkpoint("worker:run_1:T1:1", {
      turns: 2,
      seenCallIds: ["read_1"],
      messages: [
        { id: "intent", role: "user", content: "Implement the durable scheduler." },
        { id: "old-finding", role: "assistant", content: [{ type: "text", text: "The queue uses WAL mode and monotonic sequences." }] },
        {
          id: "tool-result",
          role: "tool",
          content: {
            callId: "read_1",
            toolName: "fs.read",
            content: [{ type: "text", text: "scheduler.sqlite uses WAL mode" }],
            isError: false,
          },
        },
      ],
    }, "2026-07-12T00:00:01.000Z");
    const registry = new ToolRegistry();
    for (const tool of createSessionTools(sessions)) registry.register(tool);
    const result = await registry.invoke({
      type: "tool_call",
      callId: "history_1",
      name: "search_session_history",
      arguments: { query: "WAL", limit: 10 },
    }, {
      runId: "run_1",
      sessionId: "worker:run_1:T1:1",
      actor: { role: "worker", id: "worker_1" },
    });
    assert.equal(result.isError, false);
    const value = result.content.find((block) => block.type === "json");
    assert.ok(value && value.type === "json");
    const matches = value.value as Array<{ id: string; role: string; content: unknown }>;
    assert.deepEqual(matches.map((match) => match.id), ["old-finding", "tool-result"]);
    assert.equal(JSON.stringify(matches).includes("scheduler.sqlite uses WAL mode"), true);
  } finally {
    sessions.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("session history search cannot read another agent session", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-session-isolation-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  try {
    await sessions.create({
      sessionId: "worker:run_1:T1:1",
      runId: "run_1",
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-07-12T00:00:00.000Z",
    });
    const tool = createSessionTools(sessions)[0];
    assert.equal(JSON.stringify(tool.definition.inputSchema).includes("sessionId"), false);
  } finally {
    sessions.close();
    rmSync(root, { recursive: true, force: true });
  }
});
