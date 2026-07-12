import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createEvidenceTools } from "../src/evidence-tools.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("evidence command records mechanical facts and artifacts without a verdict", async () => {
  const fixture = evidenceFixture();
  let store = new SqliteEvidenceStore(fixture.database);
  const artifacts = new ArtifactStore(fixture.artifacts);
  try {
    const registry = tools(store, artifacts);
    const result = await registry.invoke(
      {
        type: "tool_call",
        callId: "evidence_1",
        name: "run_evidence_command",
        arguments: {
          label: "focused test",
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write('APPROVED complete'); process.stderr.write('note'); process.exit(3)",
          ],
          cwd: ".",
          timeoutMs: 5_000,
        },
      },
      workerContext(fixture.workspace)
    );
    assert.equal(result.isError, false);
    assert.equal(result.lifecycle, undefined);
    const record = jsonValue(result) as {
      id: string;
      fact: {
        exitCode: number;
        stdoutArtifactHash: string;
        stderrArtifactHash: string;
      };
    };
    assert.equal(record.fact.exitCode, 3);
    assert.equal("verdict" in record, false);
    assert.equal(
      (await artifacts.get(record.fact.stdoutArtifactHash)).toString("utf8"),
      "APPROVED complete"
    );
    assert.equal(
      (await artifacts.get(record.fact.stderrArtifactHash)).toString("utf8"),
      "note"
    );
    store.close();

    store = new SqliteEvidenceStore(fixture.database);
    const recovered = store.list({ runId: "run_1", taskId: "task_a" });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, record.id);
    assert.equal(recovered[0].fact.exitCode, 3);
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test("evidence inspection is factual, read-only, and task scoped", async () => {
  const fixture = evidenceFixture();
  const store = new SqliteEvidenceStore(fixture.database);
  const artifacts = new ArtifactStore(fixture.artifacts);
  try {
    const workerTools = tools(store, artifacts);
    await workerTools.invoke(
      {
        type: "tool_call",
        callId: "evidence_1",
        name: "run_evidence_command",
        arguments: {
          label: "syntax check",
          command: process.execPath,
          args: ["--check", "missing.js"],
          cwd: ".",
        },
      },
      workerContext(fixture.workspace)
    );
    const inspected = await workerTools.invoke(
      {
        type: "tool_call",
        callId: "inspect_1",
        name: "inspect_evidence",
        arguments: { taskId: "task_a" },
      },
      {
        runId: "run_1",
        sessionId: "architect_session",
        actor: { role: "architect", id: "architect_1" },
        workspacePath: fixture.workspace,
      }
    );
    assert.equal(inspected.isError, false);
    assert.equal(inspected.lifecycle, undefined);
    const records = jsonValue(inspected) as Array<{ status: string; fact: unknown }>;
    assert.equal(records[0].status, "observed");
    assert.ok(records[0].fact);
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test("evidence command cannot escape the task workspace", async () => {
  const fixture = evidenceFixture();
  const store = new SqliteEvidenceStore(fixture.database);
  const artifacts = new ArtifactStore(fixture.artifacts);
  try {
    const result = await tools(store, artifacts).invoke(
      {
        type: "tool_call",
        callId: "escape",
        name: "run_evidence_command",
        arguments: { label: "escape", command: process.execPath, args: ["--version"], cwd: ".." },
      },
      workerContext(fixture.workspace)
    );
    assert.equal(result.isError, true);
    assert.match(result.error?.message ?? "", /outside workspace/i);
    assert.deepEqual(store.list({ runId: "run_1", taskId: "task_a" }), []);
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test("evidence commands declare arbitrary process execution as an external effect", () => {
  const fixture = evidenceFixture();
  const store = new SqliteEvidenceStore(fixture.database);
  try {
    const tool = createEvidenceTools({
      store,
      artifacts: new ArtifactStore(fixture.artifacts),
      taskId: "task_1",
    }).find((candidate) => candidate.definition.name === "run_evidence_command");
    assert.equal(tool?.definition.effect, "external");
    assert.equal(tool?.assessAccess?.({
      label: "test",
      command: "node",
      args: ["--version"],
      cwd: ".",
      timeoutMs: 1_000,
    }, workerContext(fixture.workspace)).external, true);
  } finally {
    store.close();
    fixture.cleanup();
  }
});

function tools(store: SqliteEvidenceStore, artifacts: ArtifactStore) {
  const registry = new ToolRegistry();
  for (const tool of createEvidenceTools({
    store,
    artifacts,
    taskId: "task_a",
    maxOutputBytes: 1024 * 1024,
  })) registry.register(tool);
  return registry;
}

function workerContext(workspacePath: string) {
  return {
    runId: "run_1",
    sessionId: "worker_session",
    actor: { role: "worker" as const, id: "worker_1" },
    workspacePath,
  };
}

function jsonValue(result: Awaited<ReturnType<ToolRegistry["invoke"]>>): unknown {
  const block = result.content[0];
  assert.equal(block.type, "json");
  return block.type === "json" ? block.value : undefined;
}

function evidenceFixture() {
  const root = mkdtempSync(join(tmpdir(), "aiboard-evidence-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  return {
    workspace,
    database: join(root, "evidence.sqlite"),
    artifacts: join(root, "artifacts"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
