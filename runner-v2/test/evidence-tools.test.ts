import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createEvidenceTools } from "../src/evidence-tools.js";
import type { OneShotCommandExecutor } from "../src/one-shot-command-executor.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { ToolBroker } from "../src/tool-broker.js";
import { createTestOneShotCommandExecutor } from "./support/one-shot-command-executor.js";
import { createProductionOneShotCommandFixture } from "./support/one-shot-command-executor.js";

test("evidence command routes through shared execution and keeps complete spill artifacts", async () => {
  const fixture = evidenceFixture();
  const store = new SqliteEvidenceStore(fixture.database);
  const artifacts = new ArtifactStore(fixture.artifacts);
  const complete = Buffer.from("complete spill output");
  try {
    const spill = await artifacts.put(complete, "application/octet-stream", "runtime spill");
    let calls = 0;
    const execution: OneShotCommandExecutor = {
      execute: async () => {
        calls += 1;
        return {
          process: {
            logicalProcessId: "evidence-process",
            outcome: "exited",
            exitCode: 0,
            finishedAt: "2026-08-29T00:00:01.000Z",
            output: [
              { stream: "stdout", tail: "bounded-tail", totalBytes: 70 * 1024 * 1024, truncated: true, spillArtifactId: spill.hash, spillBytes: complete.byteLength, lossyBytes: 6 * 1024 * 1024 },
              { stream: "stderr", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
            ],
            cleanup: { state: "verified_empty", verifiedAt: "2026-08-29T00:00:01.000Z" },
          },
          enforcement: "unconfined_explicit_full",
          disclosure: "unconfined_explicit_full",
        };
      },
    };
    const registry = new ToolRegistry();
    for (const tool of createEvidenceTools({
      store,
      artifacts,
      taskId: "task_a",
      execution,
    })) registry.register(tool);
    const result = await registry.invoke({
      type: "tool_call",
      callId: "spill",
      name: "run_evidence_command",
      arguments: { label: "spill", command: "fixture", args: [] },
    }, { ...workerContext(fixture.workspace), executionGrant: {} as never });
    assert.equal(calls, 1);
    assert.equal(result.isError, false);
    const record = jsonValue(result) as { fact: { stdoutArtifactHash: string; outputLossy: boolean } };
    assert.deepEqual(await artifacts.get(record.fact.stdoutArtifactHash), complete);
    assert.equal(record.fact.outputLossy, true);
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test("evidence family production graph scrubs inherited secrets and survives output beyond spill capacity", async (t) => {
  const fixture = evidenceFixture();
  const store = new SqliteEvidenceStore(fixture.database);
  const artifacts = new ArtifactStore(fixture.artifacts);
  const secretName = "RUNNER_MATRIX_INHERITED_SECRET";
  const previous = process.env[secretName];
  process.env[secretName] = "must-not-reach-evidence-child";
  const graph = createProductionOneShotCommandFixture(t, { artifacts });
  let observedCommandTimeoutMs: number | undefined;
  const guardedExecution = {
    execute: async (request: Parameters<typeof graph.execution.execute>[0]) => {
      observedCommandTimeoutMs = request.timeoutMs;
      return await graph.execution.execute(request);
    },
  };
  const broker = new ToolBroker({
    permissionProfile: "full", workspacePath: fixture.workspace,
    executionGrants: graph.executionGrants, toolTimeoutMs: 60_000,
  });
  for (const tool of createEvidenceTools({ store, artifacts, taskId: "task_a", execution: guardedExecution })) broker.register(tool);
  try {
    const result = await broker.invoke({
      type: "tool_call", callId: "evidence-production-large", name: "run_evidence_command",
      arguments: {
        label: "large", command: process.execPath, timeoutMs: 25_000,
        args: ["-e", `const marker=String(process.env.${secretName} ?? "absent"); process.stdout.write(marker+"|"); process.stdout.write("x".repeat(65*1024*1024)); process.stdout.write("|"+marker);`],
      },
    }, { runId: "run_1", sessionId: "worker_session", actor: { role: "worker", id: "worker_1" } });
    assert.equal(result.isError, false, result.error?.message ?? "evidence command unexpectedly failed");
    assert.equal(observedCommandTimeoutMs, 25_000, "the test-only broker wrapper must not raise the production command deadline");
    const record = jsonValue(result) as { fact: { stdoutArtifactHash: string; outputLossy: boolean; disclosure: string } };
    const output = await artifacts.get(record.fact.stdoutArtifactHash);
    assert.equal(output.includes(Buffer.from("must-not-reach-evidence-child")), false);
    assert.equal(output.includes(Buffer.from("absent")), true);
    assert.equal(record.fact.outputLossy, true);
    assert.equal(record.fact.disclosure, "unconfined_explicit_full");
  } finally {
    if (previous === undefined) delete process.env[secretName]; else process.env[secretName] = previous;
    store.close();
    fixture.cleanup();
  }
});

test("evidence family production graph keeps its mechanical outcome on spill setup failure", async (t) => {
  const fixture = evidenceFixture();
  const store = new SqliteEvidenceStore(fixture.database);
  const artifacts = new ArtifactStore(fixture.artifacts);
  const graph = createProductionOneShotCommandFixture(t, { artifacts, spillFault: true });
  const broker = new ToolBroker({
    permissionProfile: "full", workspacePath: fixture.workspace, executionGrants: graph.executionGrants,
  });
  for (const tool of createEvidenceTools({ store, artifacts, taskId: "task_a", execution: graph.execution })) broker.register(tool);
  try {
    const result = await broker.invoke({
      type: "tool_call", callId: "evidence-production-spill-fault", name: "run_evidence_command",
      arguments: { label: "spill fault", command: process.execPath, args: ["-e", "process.stdout.write('z'.repeat(256*1024))"] },
    }, { runId: "run_1", sessionId: "worker_session", actor: { role: "worker", id: "worker_1" } });
    assert.equal(result.isError, false);
    const record = jsonValue(result) as { fact: { outputLossy: boolean; exitCode: number; stdoutArtifactHash: string } };
    assert.equal(record.fact.exitCode, 0);
    assert.equal(record.fact.outputLossy, true);
    assert.match((await artifacts.get(record.fact.stdoutArtifactHash)).toString(), /runner output lossy/);
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test("evidence command falls back to its bounded tail when a spill is missing or corrupt", async (t) => {
  for (const mode of ["missing", "corrupt"] as const) {
    await t.test(mode, async () => {
      const fixture = evidenceFixture();
      const store = new SqliteEvidenceStore(fixture.database);
      const artifacts = new ArtifactStore(fixture.artifacts);
      try {
        let spill = { hash: "a".repeat(64) };
        if (mode === "corrupt") {
          const created = await artifacts.put(Buffer.from("complete spill"), "text/plain", "spill");
          writeFileSync(created.path, "corrupt bytes");
          spill = { hash: created.hash };
        }
        const execution: OneShotCommandExecutor = {
          execute: async () => ({
            process: {
              logicalProcessId: `evidence-${mode}`,
              outcome: "exited",
              exitCode: 0,
              finishedAt: new Date().toISOString(),
              output: [
                { stream: "stdout", tail: `bounded-${mode}`, totalBytes: 256 * 1024, truncated: true, spillArtifactId: spill.hash, spillBytes: 128 * 1024, lossyBytes: 0 },
                { stream: "stderr", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
              ],
              cleanup: { state: "verified_empty", verifiedAt: new Date().toISOString() },
            },
            enforcement: "unconfined_explicit_full",
            disclosure: "unconfined_explicit_full",
          }),
        };
        const registry = new ToolRegistry();
        for (const tool of createEvidenceTools({ store, artifacts, taskId: "task_a", execution })) registry.register(tool);
        const result = await registry.invoke({
          type: "tool_call", callId: `spill-${mode}`, name: "run_evidence_command",
          arguments: { label: mode, command: "fixture", args: [] },
        }, { ...workerContext(fixture.workspace), executionGrant: {} as never });
        assert.equal(result.isError, false);
        const record = jsonValue(result) as { fact: { stdoutArtifactHash: string; outputLossy: boolean; exitCode: number } };
        assert.equal(record.fact.exitCode, 0);
        assert.equal(record.fact.outputLossy, true);
        assert.equal((await artifacts.get(record.fact.stdoutArtifactHash)).toString(), `bounded-${mode}`);
      } finally {
        store.close();
        fixture.cleanup();
      }
    });
  }
});

test("evidence command preserves stable isolation and runtime failure codes", async (t) => {
  for (const code of ["isolation_capability_unavailable", "isolation_revocation_failed", "outcome_unknown"] as const) {
    await t.test(code, async () => {
      const fixture = evidenceFixture();
      const store = new SqliteEvidenceStore(fixture.database);
      try {
        const registry = new ToolRegistry();
        for (const tool of createEvidenceTools({
          store, artifacts: new ArtifactStore(fixture.artifacts), taskId: "task_a",
          execution: { execute: async () => { throw Object.assign(new Error(code), { code }); } },
        })) registry.register(tool);
        const result = await registry.invoke({
          type: "tool_call", callId: code, name: "run_evidence_command",
          arguments: { label: code, command: "fixture", args: [] },
        }, { ...workerContext(fixture.workspace), executionGrant: {} as never });
        assert.equal(result.isError, true);
        assert.equal(result.error?.code, code);
      } finally {
        store.close();
        fixture.cleanup();
      }
    });
  }
});

test("evidence command records mechanical facts and artifacts without a verdict", async (t) => {
  const fixture = evidenceFixture();
  let store = new SqliteEvidenceStore(fixture.database);
  const artifacts = new ArtifactStore(fixture.artifacts);
  try {
    const registry = tools(store, artifacts, t);
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
    assert.equal((record as { attempt?: number }).attempt, 1);
    assert.equal("verdict" in record, false);
    assert.match(
      (await artifacts.get(record.fact.stdoutArtifactHash)).toString("utf8"),
      /APPROVED complete$/,
    );
    assert.match((await artifacts.get(record.fact.stderrArtifactHash)).toString("utf8"), /note$/);
    store.close();

    store = new SqliteEvidenceStore(fixture.database);
    const recovered = store.list({ runId: "run_1", taskId: "task_a" });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, record.id);
    assert.equal(recovered[0].fact.kind, "command");
    if (recovered[0].fact.kind === "command") {
      assert.equal(recovered[0].fact.exitCode, 3);
    }
    assert.equal(recovered[0].attempt, 1);
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test("evidence inspection is factual, read-only, and task scoped", async () => {
  const fixture = evidenceFixture();
  const store = new SqliteEvidenceStore(fixture.database);
  const artifacts = new ArtifactStore(fixture.artifacts);
  const graph = createProductionOneShotCommandFixture(undefined, { artifacts });
  try {
    const workerTools = new ToolRegistry();
    for (const tool of createEvidenceTools({
      store,
      artifacts,
      taskId: "task_a",
      maxOutputBytes: 1024 * 1024,
      attempt: 1,
      execution: graph.internalExecution,
    })) workerTools.register(tool);
    const commandResult = await workerTools.invoke(
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
    assert.equal(commandResult.isError, false, JSON.stringify(commandResult.error));
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
    await graph.close();
    store.close();
    fixture.cleanup();
  }
});

test("evidence command cannot escape the task workspace", async (t) => {
  const fixture = evidenceFixture();
  const store = new SqliteEvidenceStore(fixture.database);
  const artifacts = new ArtifactStore(fixture.artifacts);
  try {
    const result = await tools(store, artifacts, t).invoke(
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

test("benchmark evidence policy rejects commands outside the exact allowlist", async (t) => {
  const fixture = evidenceFixture();
  const store = new SqliteEvidenceStore(fixture.database);
  const artifacts = new ArtifactStore(fixture.artifacts);
  try {
    const registry = new ToolRegistry();
    for (const tool of createEvidenceTools({
      store,
      artifacts,
      taskId: "task_a",
    allowedCommands: [`${process.execPath} --version`],
      execution: createTestOneShotCommandExecutor(t, { artifacts }),
    })) registry.register(tool);
    const result = await registry.invoke(
      {
        type: "tool_call",
        callId: "denied",
        name: "run_evidence_command",
        arguments: {
          label: "denied",
          command: process.execPath,
          args: ["-e", "console.log('no')"],
          cwd: ".",
        },
      },
      workerContext(fixture.workspace)
    );
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "benchmark_command_denied");
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test("exact evidence lookup resolves records beyond the oldest 1000 and omits missing IDs", () => {
  const store = new SqliteEvidenceStore(":memory:");
  const artifactHash = "a".repeat(64);
  try {
    const records = [];
    for (let index = 0; index < 1_001; index += 1) {
      records.push(store.record({
        runId: "run_exact_lookup",
        taskId: "task_exact_lookup",
        actor: { role: "worker", id: "worker_exact_lookup" },
        fact: {
          kind: "browser_screenshot",
          label: `evidence-${index}`,
          capturedAt: "2026-08-26T00:00:00.000Z",
          screenshotArtifactHash: artifactHash,
          mediaType: "image/png",
          byteLength: 1,
        },
        createdAt: "2026-08-26T00:00:00.000Z",
        idempotencyKey: `evidence-${index}`,
        attempt: 1,
      }));
    }
    const tail = records[1_000];
    assert.deepEqual(
      store.getByIds({
        runId: "run_exact_lookup",
        taskId: "task_exact_lookup",
        ids: [tail.id, "evidence_missing", tail.id],
      }).map((record) => record.id),
      [tail.id, tail.id],
    );
  } finally {
    store.close();
  }
});

function tools(store: SqliteEvidenceStore, artifacts: ArtifactStore, t: TestContext) {
  const registry = new ToolRegistry();
  for (const tool of createEvidenceTools({
    store,
    artifacts,
      taskId: "task_a",
      maxOutputBytes: 1024 * 1024,
      attempt: 1,
      execution: createTestOneShotCommandExecutor(t, { artifacts }),
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
