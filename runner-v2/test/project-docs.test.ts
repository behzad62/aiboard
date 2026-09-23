import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock, ToolExecutionContext } from "../src/agent-contracts.js";
import { ARCHITECT_PROJECT_DOCS_INSTRUCTIONS, buildArchitectContext } from "../src/agent-prompts.js";
import { createArchitectTools } from "../src/architect-tools.js";
import { ArtifactStore } from "../src/artifact-store.js";
import {
  ARCHITECT_LIFECYCLE_SURFACE,
  architectLifecycleUniverseNames,
} from "../src/build-runtime.js";
import {
  AGENTS_SECTION_END,
  AGENTS_SECTION_START,
  CLAUDE_POINTER_LINE,
  DEFAULT_AGENTS_SECTION_BODY,
  DEFAULT_README_TEMPLATE,
  DEFAULT_STATE_TEMPLATE,
  DOCS_LAYOUT_LINES,
  DOCS_MARKER_HOLDS,
  DOCS_MARKER_READ_FIRST,
  DOCS_MARKER_UPDATE,
  DOCS_READ_FIRST_SENTENCE,
  DOCS_UPDATE_SENTENCE,
  PROJECT_DOC_MAX_BYTES,
  PROJECT_DOCS_ROOT,
  agentsMarkedSectionSatisfies,
  claudePointerSatisfies,
  projectDocRequestId,
  spliceMarkedArchitectSection,
  validateProjectDocPath,
  type ProjectDocPathRefusal,
} from "../src/project-docs.js";
import {
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerStore,
} from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { ToolRegistry } from "../src/tool-registry.js";

const CLOCK = () => "2026-09-23T00:00:00.000Z";
const HASH = "ab".repeat(32);

const ADMITTED = [
  "AGENTS.md",
  "CLAUDE.md",
  "docs/project/README.md",
  "docs/project/STATE.md",
  "docs/project/specs/amendment.md",
  "docs/project/plans/tasks.md",
  "docs/project/decisions.md",
  "docs/project/evidence/a4.md",
  "docs/project/nested/dir/file.md",
];

const REFUSED: ReadonlyArray<readonly [string, ProjectDocPathRefusal]> = [
  ["", "empty"],
  ["a\0b", "nul"],
  ["/etc/x", "absolute"],
  ["\\x", "absolute"],
  ["C:\\x", "absolute"],
  ["C:/x", "absolute"],
  ["docs\\project\\x.md", "backslash"],
  ["docs/project/", "trailing_slash"],
  ["docs/project/../src/x", "parent"],
  ["docs/project/./x.md", "dot_segment"],
  ["docs/project//x.md", "empty_segment"],
  ["agents.md", "case_variant"],
  ["Agents.md", "case_variant"],
  ["claude.md", "case_variant"],
  ["Docs/Project/x.md", "case_variant"],
  ["docs/Project/x.md", "case_variant"],
  ["lib/x.ts", "not_admitted"],
  ["docs/project", "not_admitted"],
  ["../AGENTS.md", "parent"],
];

test("project doc templates restate the layout, read-first rule, and update rule", () => {
  assert.equal(PROJECT_DOCS_ROOT, "docs/project/");
  assert.equal(AGENTS_SECTION_START, "<!-- aiboard:architect:start -->");
  assert.equal(AGENTS_SECTION_END, "<!-- aiboard:architect:end -->");
  assert.equal(PROJECT_DOC_MAX_BYTES, 262144);
  assert.equal(DOCS_LAYOUT_LINES.length, 6);
  const body = DEFAULT_AGENTS_SECTION_BODY.split("\n");
  assert.deepEqual(body, [
    DOCS_MARKER_HOLDS,
    ...DOCS_LAYOUT_LINES,
    DOCS_MARKER_READ_FIRST,
    DOCS_READ_FIRST_SENTENCE,
    DOCS_MARKER_UPDATE,
    DOCS_UPDATE_SENTENCE,
  ]);
  assert.match(DEFAULT_README_TEMPLATE, new RegExp(escapeRegExp(DOCS_READ_FIRST_SENTENCE)));
  assert.match(DEFAULT_README_TEMPLATE, new RegExp(escapeRegExp(DOCS_UPDATE_SENTENCE)));
  for (const line of DOCS_LAYOUT_LINES) {
    assert.ok(DEFAULT_README_TEMPLATE.includes(line), line);
  }
  assert.match(DEFAULT_STATE_TEMPLATE, /## Where things stand/);
  assert.match(DEFAULT_STATE_TEMPLATE, /## Next action/);
  assert.equal(CLAUDE_POINTER_LINE, "See AGENTS.md for this project's documentation rules.");
  assert.equal(
    agentsMarkedSectionSatisfies(spliceMarkedArchitectSection("", DEFAULT_AGENTS_SECTION_BODY)),
    true,
  );
  assert.equal(claudePointerSatisfies(spliceMarkedArchitectSection("", CLAUDE_POINTER_LINE)), true);
});

test("AGENTS.md entry-point fact accepts extra prose and rejects each unsound variant", () => {
  const surrounding = `alpha\n${AGENTS_SECTION_START}\nold body\n${AGENTS_SECTION_END}\nomega`;
  const spliced = spliceMarkedArchitectSection(surrounding, DEFAULT_AGENTS_SECTION_BODY);
  assert.equal(
    spliced,
    `alpha\n${AGENTS_SECTION_START}\n${DEFAULT_AGENTS_SECTION_BODY}\n${AGENTS_SECTION_END}\nomega`,
  );
  assert.equal(agentsMarkedSectionSatisfies(spliced), true);
  const withProse = spliceMarkedArchitectSection("", [
    DOCS_MARKER_HOLDS,
    "Intro.",
    ...DOCS_LAYOUT_LINES,
    "More.",
    DOCS_MARKER_READ_FIRST,
    `Note. ${DOCS_READ_FIRST_SENTENCE}`,
    DOCS_MARKER_UPDATE,
    `Also ${DOCS_UPDATE_SENTENCE} thanks.`,
  ].join("\n"));
  assert.equal(agentsMarkedSectionSatisfies(withProse), true);
  const missingMarker = spliceMarkedArchitectSection("", [
    DOCS_MARKER_HOLDS,
    ...DOCS_LAYOUT_LINES,
    DOCS_MARKER_READ_FIRST,
    DOCS_READ_FIRST_SENTENCE,
    DOCS_UPDATE_SENTENCE,
  ].join("\n"));
  assert.equal(agentsMarkedSectionSatisfies(missingMarker), false);
  const placeholders = spliceMarkedArchitectSection("", [
    DOCS_MARKER_HOLDS,
    "x",
    DOCS_MARKER_READ_FIRST,
    "y",
    DOCS_MARKER_UPDATE,
    "z",
  ].join("\n"));
  assert.equal(agentsMarkedSectionSatisfies(placeholders), false);
  const tokensOnly = spliceMarkedArchitectSection("", [
    DOCS_MARKER_HOLDS,
    "README.md STATE.md specs/ plans/ decisions.md evidence/",
    DOCS_MARKER_READ_FIRST,
    "docs/project/README.md docs/project/STATE.md",
    DOCS_MARKER_UPDATE,
    "STATE.md last",
  ].join("\n"));
  assert.equal(agentsMarkedSectionSatisfies(tokensOnly), false);
  const moved = spliceMarkedArchitectSection("", [
    DOCS_MARKER_HOLDS,
    ...DOCS_LAYOUT_LINES,
    DOCS_MARKER_READ_FIRST,
    DOCS_UPDATE_SENTENCE,
    DOCS_MARKER_UPDATE,
    DOCS_READ_FIRST_SENTENCE,
  ].join("\n"));
  assert.equal(agentsMarkedSectionSatisfies(moved), false);
  const missingLine = spliceMarkedArchitectSection("", [
    DOCS_MARKER_HOLDS,
    ...DOCS_LAYOUT_LINES.slice(1),
    DOCS_MARKER_READ_FIRST,
    DOCS_READ_FIRST_SENTENCE,
    DOCS_MARKER_UPDATE,
    DOCS_UPDATE_SENTENCE,
  ].join("\n"));
  assert.equal(agentsMarkedSectionSatisfies(missingLine), false);
  const outside = `pointer outside\n${AGENTS_SECTION_START}\ninterior\n${AGENTS_SECTION_END}\n`;
  assert.equal(claudePointerSatisfies(outside), false);
  assert.equal(
    claudePointerSatisfies(spliceMarkedArchitectSection("preface\n", CLAUDE_POINTER_LINE)),
    true,
  );
});

test("validateProjectDocPath admits only exact documentation targets", () => {
  for (const path of ADMITTED) {
    const result = validateProjectDocPath(path);
    assert.deepEqual(result, { ok: true, path }, path);
  }
});

test("validateProjectDocPath refuses agents.md", () => {
  const result = validateProjectDocPath("agents.md");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "case_variant");
});

test("validateProjectDocPath refuses every lexical escape and case variant", () => {
  for (const [path, reason] of REFUSED) {
    const result = validateProjectDocPath(path);
    assert.equal(result.ok, false, JSON.stringify(path));
    if (!result.ok) assert.equal(result.reason, reason, JSON.stringify(path));
  }
});

test("write_project_doc refuses each bad path before appending", async () => {
  const fixture = openFixture();
  try {
    for (const [path] of REFUSED) {
      if (path.length === 0) continue;
      const result = await invoke(fixture.registry, {
        path,
        content: "body",
        summary: "note",
      });
      assert.equal(result.isError, true, JSON.stringify(path));
      assert.equal(result.error?.code, "invalid_arguments", JSON.stringify(path));
    }
    assert.equal(
      fixture.store.readRun(fixture.runId).some((event) => event.type === "project_doc.requested"),
      false,
    );
  } finally {
    fixture.close();
  }
});

test("write_project_doc refuses lib/x.ts in the tool", async () => {
  const fixture = openFixture();
  try {
    const result = await invoke(fixture.registry, {
      path: "lib/x.ts",
      content: "body",
      summary: "note",
    });
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "invalid_arguments");
    assert.equal(
      fixture.store.readRun(fixture.runId).some((event) => event.type === "project_doc.requested"),
      false,
    );
  } finally {
    fixture.close();
  }
});

test("write_project_doc refuses oversize content", async () => {
  const fixture = openFixture();
  try {
    const result = await invoke(fixture.registry, {
      path: "docs/project/STATE.md",
      content: "x".repeat(PROJECT_DOC_MAX_BYTES + 1),
      summary: "too big",
    });
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "invalid_arguments");
    assert.equal(existsSync(fixture.artifactRoot) ? readdirSync(fixture.artifactRoot).length : 0, 0);
    assert.equal(
      fixture.store.readRun(fixture.runId).some((event) => event.type === "project_doc.requested"),
      false,
    );
  } finally {
    fixture.close();
  }
});

test("write_project_doc stores the content and records a pending request", async () => {
  const fixture = openFixture();
  try {
    mkdirSync(fixture.project, { recursive: true });
    writeFileSync(join(fixture.project, "keep.txt"), "same");
    const content = "Where things stand: planning.\n";
    const path = "docs/project/STATE.md";
    const architectActionSequence = 4;
    const registry = registryFor(fixture, architectActionSequence);
    const result = await invoke(registry, {
      path,
      content,
      summary: "  Record the current state  ",
    }, fixture.runId, { role: "architect", id: "architect_1" }, fixture.project);
    const requestId = projectDocRequestId(2, path);
    assert.notEqual(requestId, projectDocRequestId(architectActionSequence, path));
    assert.equal(result.isError, false, result.error?.message ?? "write failed");
    assert.equal(result.content[0]?.type, "text");
    if (result.content[0]?.type === "text") {
      assert.equal(result.content[0].text, `Project document requested: ${requestId}`);
    }
    const events = fixture.store.readRun(fixture.runId).filter((event) => event.type === "project_doc.requested");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.actor.role, "architect");
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    assert.deepEqual(events[0]?.payload, {
      requestId,
      path,
      contentArtifactHash: hash,
      contentBytes: Buffer.byteLength(content, "utf8"),
      summary: "Record the current state",
    });
    assert.equal((await fixture.artifacts.get(hash)).toString("utf8"), content);
    const pending = rebuildSchedulerProjection(fixture.store.readRun(fixture.runId)).projectDocs?.pending;
    assert.equal(pending?.length, 1);
    assert.equal(pending?.[0]?.requestId, requestId);
    assert.equal(pending?.[0]?.path, path);
    assert.equal(existsSync(join(fixture.project, "docs", "project", "STATE.md")), false);
    assert.equal(existsSync(join(fixture.project, "keep.txt")), true);
  } finally {
    fixture.close();
  }
});

test("two write_project_doc calls for STATE.md in one turn both succeed", async () => {
  const fixture = openFixture();
  try {
    const path = "docs/project/STATE.md";
    const architectActionSequence = 9;
    const registry = registryFor(fixture, architectActionSequence);
    const early = "Where things stand: planning.\n";
    const late = "Where things stand: integration landed.\n";
    const first = await invoke(registry, {
      path,
      content: early,
      summary: "early state",
    });
    const second = await invoke(registry, {
      path,
      content: late,
      summary: "state after integration",
    });
    const firstId = projectDocRequestId(2, path);
    const secondId = projectDocRequestId(3, path);
    assert.equal(first.isError, false, first.error?.message ?? "first write failed");
    assert.equal(second.isError, false, second.error?.message ?? "second write failed");
    assert.notEqual(firstId, secondId);
    assert.notEqual(firstId, projectDocRequestId(architectActionSequence, path));
    assert.equal(textOf(first), `Project document requested: ${firstId}`);
    assert.equal(textOf(second), `Project document requested: ${secondId}`);
    const pending = rebuildSchedulerProjection(fixture.store.readRun(fixture.runId))
      .projectDocs?.pending ?? [];
    const forPath = pending.filter((request) => request.path === path);
    assert.deepEqual(forPath.map((request) => request.requestId), [firstId, secondId]);
    assert.equal(forPath.at(-1)?.requestId, secondId);
    assert.equal(forPath.at(-1)?.summary, "state after integration");
    assert.equal(
      (await fixture.artifacts.get(forPath[0]?.contentArtifactHash ?? "")).toString("utf8"),
      early,
    );
    assert.equal(
      (await fixture.artifacts.get(forPath[1]?.contentArtifactHash ?? "")).toString("utf8"),
      late,
    );
    const beforeReplay = fixture.store.readRun(fixture.runId).length;
    assert.throws(
      () => fixture.store.append(requested(fixture.runId, path, { summary: "replayed" }, firstId)),
      new RegExp(`Project document request ${escapeRegExp(firstId)} is already recorded\\.`),
    );
    assert.equal(fixture.store.readRun(fixture.runId).length, beforeReplay);
  } finally {
    fixture.close();
  }
});

test("write_project_doc is on plan_only turns when artifacts exist and on the lifecycle surface", () => {
  assert.equal(ARCHITECT_LIFECYCLE_SURFACE.includes("write_project_doc"), true);
  const derived = architectLifecycleUniverseNames({} as SchedulerStore, CLOCK);
  assert.equal(derived.includes("write_project_doc"), true);
  assert.deepEqual([...ARCHITECT_LIFECYCLE_SURFACE], [...derived]);
  const planOnly = createArchitectTools({
    store: {} as SchedulerStore,
    clock: CLOCK,
    runPolicy: "plan_only",
    artifacts: {} as ArtifactStore,
    architectAction: { reason: { type: "plan_required" }, sequence: 1 },
  }).map((tool) => tool.definition.name);
  assert.equal(planOnly.includes("write_project_doc"), true);
  const withoutArtifacts = createArchitectTools({
    store: {} as SchedulerStore,
    clock: CLOCK,
    runPolicy: "plan_only",
    architectAction: { reason: { type: "plan_required" }, sequence: 1 },
  }).map((tool) => tool.definition.name);
  assert.equal(withoutArtifacts.includes("write_project_doc"), false);
});

test("architect prompt contains the documentation statements and the CLAUDE pointer", () => {
  const pack = buildArchitectContext({
    limits: { maxBytes: 64 * 1024, maxEstimatedTokens: 16 * 1024 },
    objective: "Document the project.",
    reason: { type: "plan_required" },
    projection: {
      runId: "run_docs",
      status: "running",
      planRevision: 0,
      tasks: {},
      guidance: {},
      userGuidance: {},
      userGuidanceVersion: 0,
      architectQuestions: {},
      architectQuestionVersion: 0,
      reviews: {},
      runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
      lastSequence: 0,
    },
    instructions: [],
    skills: [],
    memories: [],
    evidence: [],
    recentHistory: [],
  });
  assert.equal(pack.sections.find((section) => section.id === "project-documentation")?.required, true);
  for (const line of DOCS_LAYOUT_LINES) assert.ok(pack.text.includes(line), line);
  assert.ok(pack.text.includes(DOCS_READ_FIRST_SENTENCE));
  assert.ok(pack.text.includes(DOCS_UPDATE_SENTENCE));
  assert.ok(pack.text.includes(CLAUDE_POINTER_LINE));
  assert.ok(pack.text.includes(DEFAULT_AGENTS_SECTION_BODY));
  assert.ok(pack.text.includes(DEFAULT_README_TEMPLATE));
  assert.ok(pack.text.includes(DEFAULT_STATE_TEMPLATE));
  assert.ok(pack.text.includes(ARCHITECT_PROJECT_DOCS_INSTRUCTIONS));
  assert.match(pack.text, /At the start of every build, read `docs\/project\/README.md` and `docs\/project\/STATE.md` if present\./);
  assert.match(pack.text, /write it first from the templates/);
  assert.match(pack.text, /Keep the folder current as the plan changes\./);
  assert.match(pack.text, /Write `docs\/project\/STATE.md` as the last thing before completing or handing off\./);
});

test("a direct project_doc.requested append refuses lib/x.ts", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-project-doc-reducer-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_direct_lib";
  try {
    store.append(initialized(runId));
    const before = store.readRun(runId).length;
    assert.throws(
      () => store.append(requested(runId, "lib/x.ts")),
      /Project document path is refused: not_admitted\./,
    );
    assert.equal(store.readRun(runId).length, before);
    assert.equal(rebuildSchedulerProjection(store.readRun(runId)).projectDocs, undefined);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the project_doc.requested reducer enforces actor, hash, summary, size, and unique request ids", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-project-doc-rules-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_direct_rules";
  try {
    store.append(initialized(runId));
    assert.throws(
      () => store.append({ ...requested(runId, "docs/project/STATE.md"), actor: { role: "worker", id: "worker_1" } }),
      /Only the Architect may request a project document write\./,
    );
    assert.throws(
      () => store.append(requested(runId, "docs/project/STATE.md", { contentArtifactHash: "AB".repeat(32) })),
      /Project document content hash is invalid\./,
    );
    assert.throws(
      () => store.append(requested(runId, "docs/project/STATE.md", { summary: "   " })),
      /Project document summary is required\./,
    );
    assert.throws(
      () => store.append(requested(runId, "docs/project/STATE.md", { contentBytes: PROJECT_DOC_MAX_BYTES + 1 })),
      new RegExp(`Project document content exceeds ${PROJECT_DOC_MAX_BYTES} bytes\\.`),
    );
    assert.throws(
      () => store.append(requested(runId, "agents.md")),
      /Project document path is refused: case_variant\./,
    );
    const first = store.append(requested(runId, "docs/project/STATE.md", {}, "req-state"));
    assert.equal(first.type, "project_doc.requested");
    assert.throws(
      () => store.append(requested(runId, "docs/project/README.md", {}, "req-state")),
      /Project document request req-state is already recorded\./,
    );
    store.append(requested(runId, "docs/project/README.md", { contentBytes: PROJECT_DOC_MAX_BYTES }, "req-readme"));
    const pending = rebuildSchedulerProjection(store.readRun(runId)).projectDocs?.pending ?? [];
    assert.deepEqual(pending.map((request) => request.path), [
      "docs/project/STATE.md",
      "docs/project/README.md",
    ]);
    assert.equal(pending[1]?.contentBytes, PROJECT_DOC_MAX_BYTES);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function initialized(runId: string): NewSchedulerEvent {
  return {
    runId,
    type: "run.initialized",
    occurredAt: CLOCK(),
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: `${runId}:initialized`,
    payload: {},
  };
}

function requested(
  runId: string,
  path: string,
  payload: Record<string, unknown> = {},
  requestId = `req:${path}`,
): NewSchedulerEvent {
  return {
    runId,
    type: "project_doc.requested",
    occurredAt: CLOCK(),
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: `${runId}:${requestId}:${path}:${JSON.stringify(payload)}`,
    payload: {
      requestId,
      path,
      contentArtifactHash: HASH,
      contentBytes: 4,
      summary: "Record state",
      ...payload,
    },
  };
}

interface Fixture {
  runId: string;
  root: string;
  project: string;
  artifactRoot: string;
  store: SqliteSchedulerStore;
  artifacts: ArtifactStore;
  registry: ToolRegistry;
  close: () => void;
}

function openFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "aiboard-project-doc-tool-"));
  const project = join(root, "project");
  const artifactRoot = join(root, "artifacts");
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const artifacts = new ArtifactStore(artifactRoot);
  const runId = "run_project_doc";
  store.append(initialized(runId));
  return {
    runId,
    root,
    project,
    artifactRoot,
    store,
    artifacts,
    registry: registryFor({ store, artifacts }, 4),
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function registryFor(
  fixture: { store: SqliteSchedulerStore; artifacts: ArtifactStore },
  sequence: number,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createArchitectTools({
    store: fixture.store,
    clock: CLOCK,
    runPolicy: "plan_only",
    artifacts: fixture.artifacts,
    architectAction: { reason: { type: "plan_required" }, sequence },
  })) registry.register(tool);
  return registry;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  return block?.type === "text" ? block.text ?? "" : "";
}

async function invoke(
  registry: ToolRegistry,
  argumentsValue: unknown,
  runId = "run_project_doc",
  actor: ToolExecutionContext["actor"] = { role: "architect", id: "architect_1" },
  workspacePath?: string,
) {
  const call: ToolCallBlock = {
    type: "tool_call",
    callId: "write_project_doc:call",
    name: "write_project_doc",
    arguments: argumentsValue,
  };
  return await registry.invoke(call, {
    runId,
    sessionId: "architect:test",
    actor,
    ...(workspacePath ? { workspacePath } : {}),
  });
}
