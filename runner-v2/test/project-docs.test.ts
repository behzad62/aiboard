import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock, ToolExecutionContext } from "../src/agent-contracts.js";
import { ARCHITECT_PROJECT_DOCS_INSTRUCTIONS, CONTEXT_RECORDING_DECISION_GUIDANCE, buildArchitectContext } from "../src/agent-prompts.js";
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
  V2_AGENTS_SECTION_BODY,
  V2_CLAUDE_POINTER_LINE,
  agentsMarkedSectionSatisfies,
  agentsMarkedSectionSatisfiesV2,
  claudePointerSatisfies,
  claudePointerSatisfiesV2,
  projectDocRequestId,
  spliceMarkedArchitectSection,
  spliceMarkedArchitectSectionBytes,
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

test("write_project_doc refuses a multiline summary before recording the request", async () => {
  const fixture = openFixture();
  try {
    const tool = createArchitectTools({
      store: fixture.store,
      clock: CLOCK,
      artifacts: fixture.artifacts,
    }).find((candidate) => candidate.definition.name === "write_project_doc");
    const summarySchema = (tool?.definition.inputSchema as {
      properties?: { summary?: Record<string, unknown> };
    }).properties?.summary;
    assert.deepEqual(summarySchema, {
      type: "string",
      minLength: 1,
      maxLength: 200,
      pattern: "^[^\\r\\n\\u0000]+$",
      description: "One line; used as the commit message.",
    });
    for (const summary of ["first line\nsecond line", "nul\0byte", "has\rreturn", "x".repeat(201)]) {
      const result = await invoke(fixture.registry, {
        path: "docs/project/STATE.md",
        content: "body",
        summary,
      });
      assert.equal(result.isError, true, JSON.stringify(summary));
      assert.equal(result.error?.code, "invalid_arguments", JSON.stringify(summary));
    }
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
  assert.match(pack.text, /The project-docs section shows this run's committed documents, which your fs tools cannot see/);
  assert.match(pack.text, /Base every rewrite on the committed text, since write_project_doc replaces the whole file/);
  assert.match(pack.text, /write it first from the templates/);
  assert.match(pack.text, /Keep the folder current as the plan changes\./);
  assert.match(pack.text, /Write `docs\/project\/STATE.md` as the last thing before completing or handing off\./);
  assert.equal(pack.sections.find((section) => section.id === "project-docs")?.required, true);
  assert.match(pack.text, /stateCurrent: false/);
  assert.doesNotMatch(pack.text, /proceed_without_manifest/);
});

test("Architect context carries committed STATE.md text, stateCurrent, and recording guidance", () => {
  const limits = { maxBytes: 64 * 1024, maxEstimatedTokens: 16 * 1024 };
  const committed = "PF1_COMMITTED_STATE_MARKER\nWhere things stand.\n";
  const base = {
    limits,
    objective: "Document the project.",
    instructions: [],
    skills: [],
    memories: [],
    evidence: [],
    recentHistory: [],
  };
  const projection = {
    runId: "run_docs",
    status: "running" as const,
    planRevision: 1,
    tasks: {},
    guidance: {},
    userGuidance: {},
    userGuidanceVersion: 0,
    architectQuestions: {},
    architectQuestionVersion: 0,
    reviews: {},
    runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
    lastSequence: 8,
    latestIntegratedTaskSequence: 4,
    projectDocs: {
      pending: [],
      committed: [{
        requestId: "state-1",
        path: "docs/project/STATE.md",
        commit: "c".repeat(40),
        parent: "p".repeat(40),
        head: "c".repeat(40),
        readme: true,
        agentsMarkedSection: true,
        claudePointer: false,
        sequence: 6,
      }],
      abandoned: [{
        requestId: "bad-1",
        path: "docs/project/decisions.md",
        reason: "Project document summary is invalid.",
        sequence: 7,
      }],
    },
  };
  const current = buildArchitectContext({
    ...base,
    reason: { type: "plan_required" },
    projection,
    projectDocsStateText: committed,
  });
  assert.match(current.text, /PF1_COMMITTED_STATE_MARKER/);
  assert.match(current.text, /stateCurrent: true/);
  assert.match(current.text, /entryPoint: readme=true agentsMarkedSection=true claudePointer=false/);
  assert.match(current.text, /docs\/project\/STATE.md sequence=6/);
  assert.match(current.text, /abandoned:\ndocs\/project\/decisions.md sequence=7 Project document summary is invalid\./);
  const stale = buildArchitectContext({
    ...base,
    reason: { type: "plan_required" },
    projection: { ...projection, latestIntegratedTaskSequence: 9 },
    projectDocsStateText: committed,
  });
  assert.match(stale.text, /stateCurrent: false/);
  assert.match(stale.text, /PF1_COMMITTED_STATE_MARKER/);
  const oversized = buildArchitectContext({
    ...base,
    reason: { type: "plan_required" },
    projection,
    projectDocsStateText: `${"x".repeat(5000)}END_MARKER`,
  });
  assert.match(oversized.text, /\[truncated\]/);
  assert.doesNotMatch(oversized.text, /END_MARKER/);
  const decision = buildArchitectContext({
    ...base,
    reason: {
      type: "context_recording_decision_required",
      purpose: "architect:plan_required",
      attempts: 3,
      reason: "disk full",
      noteSequence: 2,
      retriesRemaining: 2,
    },
    projection: {
      ...projection,
      projectDocs: { pending: [] },
    },
  });
  assert.ok(decision.text.includes(CONTEXT_RECORDING_DECISION_GUIDANCE));
  assert.match(decision.text, /"retriesRemaining": 2/);
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


test("C2b: the v2 entry lines splice byte-for-byte and satisfy only the v2 checks", () => {
  assert.ok(V2_AGENTS_SECTION_BODY.includes("Read docs/project/STATE.md first"));
  assert.equal(V2_CLAUDE_POINTER_LINE, "@AGENTS.md");
  // Pre-existing content outside the markers survives byte-for-byte.
  const surrounding = `alpha\n${AGENTS_SECTION_START}\nold body\n${AGENTS_SECTION_END}\nomega`;
  const spliced = spliceMarkedArchitectSection(surrounding, V2_AGENTS_SECTION_BODY);
  assert.equal(
    spliced,
    `alpha\n${AGENTS_SECTION_START}\n${V2_AGENTS_SECTION_BODY}\n${AGENTS_SECTION_END}\nomega`,
  );
  assert.equal(agentsMarkedSectionSatisfiesV2(spliced), true);
  // A missing file is created with just the section.
  assert.equal(
    spliceMarkedArchitectSection("", V2_AGENTS_SECTION_BODY),
    `${AGENTS_SECTION_START}\n${V2_AGENTS_SECTION_BODY}\n${AGENTS_SECTION_END}\n`,
  );
  const claude = spliceMarkedArchitectSection("# Claude\nkeep me\n", V2_CLAUDE_POINTER_LINE);
  assert.ok(claude.startsWith("# Claude\nkeep me\n"));
  assert.equal(claudePointerSatisfiesV2(claude), true);
  // The v1 text and checks are unchanged: v2 content fails the v1 checks.
  assert.equal(agentsMarkedSectionSatisfies(spliced), false);
  assert.equal(claudePointerSatisfies(claude), false);
  assert.equal(agentsMarkedSectionSatisfiesV2("no markers here"), false);
  assert.equal(claudePointerSatisfiesV2("no markers here"), false);
});

test("marked-section byte splice keeps outside bytes and matches EOL (C2b repair m3)", () => {
  // Probe J shape: Latin-1 bytes, no markers. Outside bytes survive exactly.
  const latin1 = Buffer.from([0x23, 0x20, 0x52, 0xe9, 0x67, 0x6c, 0x65, 0x73, 0x0a]);
  const appended = spliceMarkedArchitectSectionBytes(latin1, V2_AGENTS_SECTION_BODY);
  assert.ok(appended.subarray(0, latin1.length).equals(latin1), "bytes outside the markers are kept exactly");
  assert.ok(appended.includes(V2_AGENTS_SECTION_BODY));
  assert.equal(appended.includes(Buffer.from([0x0d])), false, "no CR introduced into an LF file");
  // A CRLF file without markers takes a CRLF section: no mixed endings.
  const crlf = Buffer.from("alpha\r\nomega\r\n", "latin1");
  const splicedCrlf = spliceMarkedArchitectSectionBytes(crlf, "body");
  assert.deepEqual(
    splicedCrlf,
    Buffer.from(`alpha\r\nomega\r\n${AGENTS_SECTION_START}\r\nbody\r\n${AGENTS_SECTION_END}\r\n`),
  );
  // Markers present with non-UTF-8 outside: only the section is replaced.
  const marked = Buffer.concat([latin1, Buffer.from(`${AGENTS_SECTION_START}\nold\n${AGENTS_SECTION_END}\n`)]);
  const replaced = spliceMarkedArchitectSectionBytes(marked, "new");
  assert.ok(replaced.subarray(0, latin1.length).equals(latin1));
  assert.ok(replaced.includes("new"));
  assert.equal(replaced.includes("old\n"), false);
  // A missing file is created with just the section.
  assert.deepEqual(
    spliceMarkedArchitectSectionBytes(null, "b"),
    Buffer.from(`${AGENTS_SECTION_START}\nb\n${AGENTS_SECTION_END}\n`),
  );
});

test("byte splice normalizes a multi-line body to the file's EOL (C2b repair N-5/probe J)", () => {
  // Probe J shape: a CRLF file with a multi-line body (the v1 Architect
  // body). No lone LF may survive in the spliced file.
  const crlfFile = Buffer.from(
    `head\r\n${AGENTS_SECTION_START}\r\nold\r\nline2\r\n${AGENTS_SECTION_END}\r\ntail\r\n`,
    "latin1",
  );
  const spliced = spliceMarkedArchitectSectionBytes(crlfFile, "new\nbody\nlines");
  assert.ok(spliced.includes("new\r\nbody\r\nlines"), "the multi-line body takes the file's CRLF");
  for (let index = 0; index < spliced.length; index += 1) {
    if (spliced[index] === 0x0a) {
      assert.equal(spliced[index - 1], 0x0d, `no lone LF at byte ${index}`);
    }
  }
  assert.ok(spliced.subarray(0, 6).equals(Buffer.from("head\r\n", "latin1")), "outside bytes are kept exactly");
  // An LF file keeps LF bodies untouched.
  const lfFile = Buffer.from(`head\n${AGENTS_SECTION_START}\nold\n${AGENTS_SECTION_END}\ntail\n`, "latin1");
  const splicedLf = spliceMarkedArchitectSectionBytes(lfFile, "new\nbody");
  assert.ok(splicedLf.includes("new\nbody"));
  assert.equal(splicedLf.includes(Buffer.from([0x0d])), false, "no CR introduced into an LF file");
  // A CRLF file without markers takes a CRLF multi-line section too.
  const appended = spliceMarkedArchitectSectionBytes(Buffer.from("alpha\r\nomega\r\n", "latin1"), "one\ntwo");
  assert.ok(appended.includes("one\r\ntwo"));
  for (let index = 0; index < appended.length; index += 1) {
    if (appended[index] === 0x0a) {
      assert.equal(appended[index - 1], 0x0d, `no lone LF at byte ${index}`);
    }
  }
});
