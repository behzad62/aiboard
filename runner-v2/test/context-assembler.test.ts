import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextAssembler,
  ProtectedContextOverflowError,
} from "../src/context-assembler.js";
import {
  buildWorkerContext,
  RUNNER_KERNEL_INVARIANTS,
} from "../src/agent-prompts.js";

test("context assembler protects intent and guidance before optional history", () => {
  const assembler = new ContextAssembler({ maxBytes: 420, maxEstimatedTokens: 200 });
  const pack = assembler.assemble([
    { id: "invariants", kind: "system", required: true, priority: 1000, content: "Never infer completion from prose." },
    { id: "task", kind: "task", required: true, priority: 1000, content: "Implement task A exactly." },
    { id: "guidance", kind: "guidance", required: true, priority: 1000, content: "Architect: use API B." },
    { id: "instructions", kind: "instructions", required: false, priority: 90, content: "Project instruction." },
    { id: "history-old", kind: "history", required: false, priority: 1, content: "old ".repeat(100) },
  ]);
  assert.match(pack.text, /Never infer completion/);
  assert.match(pack.text, /Implement task A/);
  assert.match(pack.text, /use API B/);
  assert.match(pack.text, /Project instruction/);
  assert.doesNotMatch(pack.text, /old old/);
  assert.deepEqual(pack.omissions.map((item) => item.id), ["history-old"]);
  assert.equal(pack.byteLength <= 420, true);
  assert.equal(pack.estimatedTokens <= 200, true);
  assert.equal(/\.\.\.$/.test(pack.text), false, "sections are omitted, never silently truncated");
});

test("protected context overflow fails mechanically instead of dropping task intent", () => {
  const assembler = new ContextAssembler({ maxBytes: 20, maxEstimatedTokens: 100 });
  assert.throws(
    () => assembler.assemble([
      { id: "task", kind: "task", required: true, priority: 1000, content: "This protected task is longer than the budget." },
    ]),
    (error: unknown) =>
      error instanceof ProtectedContextOverflowError &&
      error.requiredSectionIds.includes("task")
  );
});

test("worker context carries provenance for instructions, skills, memory, and evidence", () => {
  const pack = buildWorkerContext({
    limits: { maxBytes: 8_000, maxEstimatedTokens: 4_000 },
    task: {
      id: "task_a",
      objective: "Implement durable retries",
      dependencies: [],
      status: "running",
      requiredCapabilities: ["code"],
      attempt: 1,
    },
    guidance: [
      { requestId: "g1", answer: "Preserve the existing API.", version: 2 },
    ],
    instructions: [
      {
        relativePath: "AGENTS.md",
        scopeDirectory: "",
        digest: "a".repeat(64),
        byteLength: 20,
        content: "Run focused tests first.",
      },
    ],
    skills: [
      {
        id: ".agents/skills/testing",
        name: "testing",
        description: "Test safely",
        relativePath: ".agents/skills/testing/SKILL.md",
        digest: "b".repeat(64),
        byteLength: 18,
        source: "project",
        content: "Inspect before editing.",
      },
    ],
    memories: [
      {
        id: "memory_1",
        projectId: "project_a",
        runId: "old_run",
        content: "Use WAL for SQLite stores.",
        concepts: ["sqlite"],
        status: "promoted",
        proposedBy: { role: "worker", id: "worker_old" },
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    repositorySnapshot: "HEAD abc123; clean",
    evidence: [
      { id: "evidence_1", summary: "npm test exited 0", artifactHashes: ["c".repeat(64)] },
    ],
    recentHistory: ["Earlier worker message"],
  });
  assert.match(pack.text, new RegExp(RUNNER_KERNEL_INVARIANTS.split("\\n")[0]));
  assert.match(pack.text, /AGENTS\.md/);
  assert.match(pack.text, /\.agents\/skills\/testing\/SKILL\.md/);
  assert.match(pack.text, /memory_1/);
  assert.match(pack.text, /evidence_1/);
  assert.match(pack.text, /Preserve the existing API/);
  assert.equal(pack.digest.length, 64);
});

test("same context inputs produce byte-identical packs", () => {
  const assembler = new ContextAssembler({ maxBytes: 1_000, maxEstimatedTokens: 1_000 });
  const sections = [
    { id: "b", kind: "memory", required: false, priority: 1, content: "B" },
    { id: "a", kind: "task", required: true, priority: 100, content: "A" },
  ];
  assert.deepEqual(assembler.assemble(sections), assembler.assemble(sections));
});
