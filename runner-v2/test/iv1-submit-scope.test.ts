import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NativeTool, ToolExecutionOutput } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import type {
  AcceptanceCriterion,
  CriterionEvidenceLink,
} from "../src/acceptance-contracts.js";
import { deliveryClaimsFromSubmission } from "../src/delivery-acceptance.js";
import type { EvidenceRecord } from "../src/evidence-store.js";
import {
  KERNEL_STAMPED_REVISION_FIELDS,
  requiredBaseForRevision,
  type PlanSubmissionRevision,
} from "../src/planning-contracts.js";
import { createPlanningTools } from "../src/planning-tools.js";
import {
  currentExplicitStartIdentity,
  rebuildSchedulerProjection,
  reduceSchedulerEvent,
  type NewSchedulerEvent,
  type SchedulerEvent,
  type SchedulerProjection,
  type SchedulerStore,
} from "../src/scheduler-store.js";
import type { ValidationScope } from "../src/validation-scope.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { createSubmitTaskTool } from "../src/worker-lifecycle-tools.js";
import { FIXTURE_AMENDED_TEXT, buildFixtureCoverageReview, buildPlanningFixtureScenario } from "./fixtures/planning-source-fixture.js";
import { seedBoundCoverageAndReady } from "./support/planning-seed.js";
import { captureGitBaseline, createChangeSet, WorkspaceManager } from "./support/git-fixture.js";

/**
 * IV-1 (CD-23): the required durable validationScope on the new-policy
 * submit path — tool requirement, change-set carriage, trusted scheduler
 * boundary, submission history, SQLite survival, retry reset, legacy
 * compatibility, and evidence separation.
 */

const CLOCK = "2026-09-24T00:00:00.000Z";
const clock = () => CLOCK;

function iv1Scope(): ValidationScope {
  return {
    changed: ["src/value.mjs"],
    verified: ["value exports 2"],
    testsRun: [
      {
        command: "node --test test/value.test.mjs",
        counts: { selected: 2, passed: 2, failed: 0, skipped: 0 },
      },
    ],
    notRun: [{ what: "full suite", why: "narrow change with no shared contract touched" }],
  };
}

class MemorySchedulerStore implements SchedulerStore {
  readonly events: SchedulerEvent[] = [];
  private readonly projections = new Map<string, SchedulerProjection | undefined>();

  append(input: NewSchedulerEvent): SchedulerEvent {
    const existing = this.events.find(
      (event) => event.runId === input.runId && event.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return existing;
    const event: SchedulerEvent = {
      ...input,
      eventId: `memory_${this.events.length + 1}`,
      sequence: this.events.filter((candidate) => candidate.runId === input.runId).length + 1,
    };
    this.projections.set(
      input.runId,
      reduceSchedulerEvent(this.projections.get(input.runId), event),
    );
    this.events.push(event);
    return event;
  }

  readRun(runId: string): SchedulerEvent[] {
    return this.events.filter((event) => event.runId === runId);
  }

  close(): void {}
}

function projectionOf(store: SchedulerStore, runId: string): SchedulerProjection {
  return rebuildSchedulerProjection(store.readRun(runId));
}

async function invokePlanningTool(
  tools: readonly NativeTool<unknown>[],
  name: string,
  args: unknown,
  runId: string,
): Promise<ToolExecutionOutput> {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  assert.ok(tool, `planning tool ${name} is registered`);
  const validation = tool.validate(args);
  assert.equal(validation.ok, true, `arguments for ${name} validate`);
  return await tool.execute(
    validation.ok ? validation.value : undefined,
    { runId, sessionId: `architect:${runId}`, actor: { role: "architect", id: "architect_1" } },
  );
}

type Iv1Fixture = ReturnType<typeof buildPlanningFixtureScenario>;

function iv1Fixture(runId: string): Iv1Fixture {
  const raw = buildPlanningFixtureScenario({ runId, createdAt: CLOCK });
  const amendment = raw.manifest.amendment!;
  return {
    ...raw,
    manifest: {
      ...raw.manifest,
      amendment: {
        ...amendment,
        recordedImpact: {
          addsSectionIds: ["s8"],
          retiresSectionIds: ["s7"],
          addsRequirementIds: [],
          retiresRequirementIds: ["REQ-RETIRED"],
        },
      },
    },
  };
}

function strippedSubmission(fixture: Iv1Fixture, revisionId: string): PlanSubmissionRevision {
  const clone = structuredClone(fixture.revision) as unknown as Record<string, unknown>;
  for (const field of [...KERNEL_STAMPED_REVISION_FIELDS]) delete clone[field];
  const tasks = clone["tasks"] as Record<string, unknown>[];
  for (const task of tasks) delete task["requiredBase"];
  for (const key of ["planningDecisions", "nonNormativeSections", "retiredRequirementIds"] as const) {
    const records = clone[key];
    if (Array.isArray(records)) {
      for (const record of records) delete (record as Record<string, unknown>)["decidedAt"];
    }
  }
  for (const requirement of clone["requirements"] as Array<{ applicability: { disposition?: Record<string, unknown> } }>) {
    if (requirement.applicability.disposition) delete requirement.applicability.disposition["decidedAt"];
  }
  clone["revisionId"] = revisionId;
  if (revisionId !== "revision_1") {
    for (const task of tasks) task["requiredBase"] = requiredBaseForRevision(revisionId);
  }
  delete clone["digest"];
  return clone as unknown as PlanSubmissionRevision;
}

function seedPolicySourceLedger(store: SchedulerStore, runId: string, fixture: Iv1Fixture): void {
  store.append({
    runId,
    type: "run.policy_configured",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "run-policy-configured",
    payload: { runPolicy: "finish" },
  });
  store.append({
    runId,
    type: "planning.policy_configured",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "runner" },
    idempotencyKey: "planning-policy:1",
    payload: { version: 1 },
  });
  store.append({
    runId,
    type: "planning.source_registered",
    occurredAt: CLOCK,
    actor: { role: "user", id: "owner" },
    idempotencyKey: "source:base",
    payload: { manifest: fixture.priorManifest },
  });
  store.append({
    runId,
    type: "planning.source_amended",
    occurredAt: CLOCK,
    actor: { role: "user", id: "owner" },
    idempotencyKey: "source:amend-1",
    payload: { manifest: fixture.manifest },
  });
  store.append({
    runId,
    type: "request.triaged",
    occurredAt: CLOCK,
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "triage:build",
    payload: { decision: "build", rationale: "IV-1: the fixture request changes the project." },
  });
  store.append({
    runId,
    type: "planning.ledger_persisted",
    occurredAt: CLOCK,
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "ledger:1",
    payload: {
      id: "ledger-1",
      requirements: fixture.requirements,
      phases: fixture.phases,
      nonNormativeSections: [],
    },
  });
}

async function iv1ReadyStore(
  runId: string,
  store: SchedulerStore,
  options: { activateValidationScope: boolean },
): Promise<Iv1Fixture> {
  const fixture = iv1Fixture(runId);
  if (options.activateValidationScope) {
    store.append({
      runId,
      type: "run.initialized",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "init:iv1",
      payload: { validationScopePolicyVersion: 1 },
    });
  }
  seedPolicySourceLedger(store, runId, fixture);
  const tools = createPlanningTools({ store, clock });
  const drafted = await invokePlanningTool(
    tools,
    "draft_planning_plan",
    { revision: strippedSubmission(fixture, "revision_1") },
    runId,
  );
  assert.equal(drafted.isError, false, JSON.stringify(drafted.error));
  const stored = projectionOf(store, runId).planning!.plan!.revisionsById["revision_1"]!;
  const review = { ...buildFixtureCoverageReview(stored, fixture.manifest, { runId }), id: "coverage_1" };
  seedBoundCoverageAndReady(store, runId, {
    revision: stored,
    manifest: fixture.manifest,
    review,
    hostCapabilities: fixture.hostCapabilities,
  });
  assert.equal(projectionOf(store, runId).planning!.readiness, "ready");
  return fixture;
}

function submitPatch(
  scope: unknown,
  withScope: boolean,
  evidenceId = "e1",
  artifactHash = "ab".repeat(32),
): Record<string, unknown> {
  return {
    changeSetId: "changeset_1",
    criterionEvidenceLinks: [
      { criterionId: "c1", evidenceId, artifactHashes: [artifactHash], attempt: 1 },
    ],
    ...(withScope ? { validationScope: scope } : {}),
  };
}

function driveToRunning(store: SchedulerStore, runId: string): void {
  store.append({
    runId,
    type: "task.transitioned",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "scheduler" },
    idempotencyKey: "assign:T1",
    payload: { taskId: "T1", status: "assigned", patch: { attempt: 1, assignedWorkerId: "worker_1" } },
  });
  store.append({
    runId,
    type: "task.transitioned",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "scheduler" },
    idempotencyKey: "running:T1",
    payload: { taskId: "T1", status: "running", patch: {} },
  });
}

// ---------------------------------------------------------------------------
// Tool: the new-policy surface requires a validated scope; legacy does not.
// ---------------------------------------------------------------------------

function submitSchemaOf(tool: ReturnType<typeof createSubmitTaskTool>): {
  required: unknown;
  properties: Record<string, unknown>;
} {
  const schema = tool.definition.inputSchema as {
    required: unknown;
    properties: Record<string, unknown>;
  };
  return { required: schema.required, properties: schema.properties };
}

test("IV-1 new-policy submit_task requires validationScope in schema and validation", () => {
  const tool = createSubmitTaskTool(
    async () => {
      throw new Error("schema only");
    },
    { requireCriterionEvidenceLinks: true, requireValidationScope: true }
  );
  const schema = submitSchemaOf(tool);
  assert.deepEqual(schema.required, ["summary", "readiness", "criterionEvidenceLinks", "validationScope"]);
  assert.ok(schema.properties.validationScope, "schema advertises validationScope");
  const missing = tool.validate({
    summary: "done",
    readiness: "ready_for_architect_review",
    criterionEvidenceLinks: [],
  });
  assert.equal(missing.ok, false);
  assert.match(
    (missing as { ok: false; issues: string[] }).issues.join(" "),
    /validationScope is required/
  );
});

test("IV-1 new-policy submit_task rejects malformed, negative, and inconsistent scopes", () => {
  const tool = createSubmitTaskTool(
    async () => {
      throw new Error("schema only");
    },
    { requireValidationScope: true }
  );
  const base = {
    summary: "done",
    readiness: "ready_for_architect_review" as const,
    unresolvedConcerns: [],
    criterionEvidenceLinks: [],
  };
  for (const [label, scope] of [
    ["missing", undefined],
    ["wrong shape", "trust me"],
    [
      "negative count",
      {
        ...iv1Scope(),
        testsRun: [{ command: "node --test", counts: { selected: 1, passed: -1, failed: 0, skipped: 2 } }],
      },
    ],
    [
      "inconsistent count",
      {
        ...iv1Scope(),
        testsRun: [{ command: "node --test", counts: { selected: 2, passed: 1, failed: 0, skipped: 0 } }],
      },
    ],
    [
      "zero selected",
      {
        ...iv1Scope(),
        testsRun: [{ command: "node --test", counts: { selected: 0, passed: 0, failed: 0, skipped: 0 } }],
      },
    ],
    ["all empty", { changed: [], verified: [], testsRun: [], notRun: [] }],
  ] as const) {
    const result = tool.validate(scope === undefined ? base : { ...base, validationScope: scope });
    assert.equal(result.ok, false, `${label} is refused`);
  }
  const valid = tool.validate({ ...base, validationScope: { ...iv1Scope(), changed: ["  src/value.mjs  "] } });
  assert.equal(valid.ok, true, "a valid scope parses");
  if (valid.ok) {
    assert.deepEqual(valid.value.validationScope?.changed, ["src/value.mjs"]);
  }
});

test("IV-1 new-policy submit_task carries the validated scope to its submit callback", async () => {
  let received: unknown;
  const tool = createSubmitTaskTool(
    async (input) => {
      received = input.validationScope;
      return { id: "changeset_1" } as never;
    },
    { requireValidationScope: true }
  );
  const validated = tool.validate({
    summary: "done",
    readiness: "ready_for_architect_review",
    validationScope: iv1Scope(),
  });
  assert.equal(validated.ok, true);
  if (!validated.ok) throw new Error("unreachable");
  const output = await tool.execute(validated.value, {} as never);
  assert.equal(output.isError, false);
  assert.deepEqual(received, iv1Scope());
});

test("IV-1 legacy submit_task keeps its surface and refuses a smuggled scope", () => {
  const plain = createSubmitTaskTool(async () => {
    throw new Error("schema only");
  });
  assert.deepEqual(submitSchemaOf(plain).required, ["summary", "readiness"]);
  assert.equal("validationScope" in submitSchemaOf(plain).properties, false);
  const accepted = plain.validate({ summary: "done", readiness: "ready_for_architect_review" });
  assert.equal(accepted.ok, true, "legacy submissions without a scope still validate");
  const smuggled = plain.validate({
    summary: "done",
    readiness: "ready_for_architect_review",
    validationScope: iv1Scope(),
  });
  assert.equal(smuggled.ok, false);
  assert.match(
    (smuggled as { ok: false; issues: string[] }).issues.join(" "),
    /not accepted on this run/
  );
  const linked = createSubmitTaskTool(
    async () => {
      throw new Error("schema only");
    },
    { requireCriterionEvidenceLinks: true }
  );
  assert.deepEqual(submitSchemaOf(linked).required, ["summary", "readiness", "criterionEvidenceLinks"]);
});

// ---------------------------------------------------------------------------
// Change set: the validated scope rides the immutable submission.
// ---------------------------------------------------------------------------

function iv1EvidenceRecord(
  runId: string,
  id: string,
  taskId: string,
  attempt: number,
  artifactHash: string,
): EvidenceRecord {
  return {
    id,
    runId,
    taskId,
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: {
      kind: "browser_screenshot",
      label: "criterion evidence",
      capturedAt: "2026-07-13T00:00:00.000Z",
      screenshotArtifactHash: artifactHash,
      mediaType: "image/png",
      byteLength: 16,
    },
    createdAt: "2026-07-13T00:00:00.000Z",
    idempotencyKey: id,
    attempt,
  };
}

async function iv1ChangeSetHarness<T>(
  run: (input: {
    workspacePath: string;
    taskCommit: Parameters<typeof createChangeSet>[0]["taskCommit"];
    artifacts: ArtifactStore;
    criteria: AcceptanceCriterion[];
    links: CriterionEvidenceLink[];
    evidenceRecords: EvidenceRecord[];
  }) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-iv1-changeset-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "value.txt"), "one\n");
  try {
    const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: "run_iv1" });
    const workspaces = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_iv1",
      baselineRevision: baseline.revision,
    });
    const workspace = await workspaces.createTaskWorkspace("task_iv1");
    writeFileSync(join(workspace.path, "value.txt"), "two\n");
    const taskCommit = await workspaces.commitTask("task_iv1", "Implement IV-1 fixture");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    const evidenceArtifact = await artifacts.put(Buffer.from("criterion evidence"), "text/plain", "criterion evidence");
    const criteria: AcceptanceCriterion[] = [{ id: "behavior", text: "The behavior changes as requested." }];
    const links: CriterionEvidenceLink[] = [
      {
        criterionId: "behavior",
        evidenceId: "evidence_behavior",
        artifactHashes: [evidenceArtifact.hash],
        taskId: "task_iv1",
        attempt: 1,
      },
    ];
    const evidenceRecords: EvidenceRecord[] = [
      iv1EvidenceRecord("run_iv1", "evidence_behavior", "task_iv1", 1, evidenceArtifact.hash),
    ];
    return await run({
      workspacePath: workspace.path,
      taskCommit,
      artifacts,
      criteria,
      links,
      evidenceRecords,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("IV-1 valid scope reaches the immutable change set; malformed scope is refused", async () => {
  await iv1ChangeSetHarness(async ({ workspacePath, taskCommit, artifacts, criteria, links, evidenceRecords }) => {
    const changeSet = await createChangeSet({
      workspacePath,
      taskCommit,
      artifacts,
      acceptanceCriteria: criteria,
      criterionEvidenceLinks: links,
      evidenceRecords,
      taskId: "task_iv1",
      attempt: 1,
      assignedWorkerId: "worker_1",
      validationScope: { ...iv1Scope(), changed: ["  src/value.mjs  "] },
    });
    assert.deepEqual(changeSet.validationScope, iv1Scope());
    await assert.rejects(
      () =>
        createChangeSet({
          workspacePath,
          taskCommit,
          artifacts,
          acceptanceCriteria: criteria,
          criterionEvidenceLinks: links,
          evidenceRecords,
          taskId: "task_iv1",
          attempt: 1,
          assignedWorkerId: "worker_1",
          validationScope: { ...iv1Scope(), testsRun: [] as never, changed: [], verified: [], notRun: [] },
        }),
      /at least one/
    );
  });
});

test("IV-1 change sets without a scope stay legacy-compatible", async () => {
  await iv1ChangeSetHarness(async ({ workspacePath, taskCommit, artifacts, criteria, links, evidenceRecords }) => {
    const changeSet = await createChangeSet({
      workspacePath,
      taskCommit,
      artifacts,
      acceptanceCriteria: criteria,
      criterionEvidenceLinks: links,
      evidenceRecords,
      taskId: "task_iv1",
      attempt: 1,
      assignedWorkerId: "worker_1",
    });
    assert.equal(changeSet.validationScope, undefined);
  });
});

test("IV-1 scope strings and counts never substitute for durable evidence", async () => {
  await iv1ChangeSetHarness(async ({ workspacePath, taskCommit, artifacts }) => {
    await assert.rejects(
      () =>
        createChangeSet({
          workspacePath,
          taskCommit,
          artifacts,
          validationScope: iv1Scope(),
        }),
      /requires durable evidence/
    );
  });
  const claims = deliveryClaimsFromSubmission({
    summary: "Worker summary.",
    criteria: [{ id: "c1", text: "works" }],
    links: [{ criterionId: "c1", evidenceId: "e1" }],
  });
  assert.deepEqual(
    claims.map((claim) => claim.id),
    ["claim:c1", "claim:summary"]
  );
  assert.ok(!JSON.stringify(claims).includes("testsRun"), "claims carry no scope report");
});

// ---------------------------------------------------------------------------
// Scheduler kernel: the trusted submitted boundary requires the scope.
// ---------------------------------------------------------------------------

test("IV-1 activated new-policy submit without a scope is refused at the trusted boundary", async () => {
  const runId = "run_iv1_kernel_refuse";
  const store = new MemorySchedulerStore();
  await iv1ReadyStore(runId, store, { activateValidationScope: true });
  driveToRunning(store, runId);
  assert.throws(
    () =>
      store.append({
        runId,
        type: "task.transitioned",
        occurredAt: CLOCK,
        actor: { role: "runner", id: "scheduler" },
        idempotencyKey: "submit:T1:noscope",
        payload: { taskId: "T1", status: "submitted", patch: submitPatch(undefined, false) },
      }),
    /validationScope/
  );
  assert.equal(projectionOf(store, runId).tasks["T1"]!.status, "running");
});

test("IV-1 activated submit with a malformed scope is refused", async () => {
  const runId = "run_iv1_kernel_malformed";
  const store = new MemorySchedulerStore();
  await iv1ReadyStore(runId, store, { activateValidationScope: true });
  driveToRunning(store, runId);
  assert.throws(
    () =>
      store.append({
        runId,
        type: "task.transitioned",
        occurredAt: CLOCK,
        actor: { role: "runner", id: "scheduler" },
        idempotencyKey: "submit:T1:bad",
        payload: {
          taskId: "T1",
          status: "submitted",
          patch: submitPatch(
            {
              ...iv1Scope(),
              testsRun: [
                { command: "node --test", counts: { selected: 2, passed: 1, failed: 0, skipped: 0 } },
              ],
            },
            true
          ),
        },
      }),
    /inconsistent/
  );
  assert.equal(projectionOf(store, runId).tasks["T1"]!.status, "running");
});

test("IV-1 a shaped scope from an untrusted actor is refused", async () => {
  const runId = "run_iv1_kernel_actor";
  const store = new MemorySchedulerStore();
  await iv1ReadyStore(runId, store, { activateValidationScope: true });
  driveToRunning(store, runId);
  assert.throws(
    () =>
      store.append({
        runId,
        type: "task.transitioned",
        occurredAt: CLOCK,
        actor: { role: "worker", id: "worker_1" },
        idempotencyKey: "submit:T1:untrusted",
        payload: { taskId: "T1", status: "submitted", patch: submitPatch(iv1Scope(), true) },
      }),
    /trusted scheduler/
  );
  assert.equal(projectionOf(store, runId).tasks["T1"]!.status, "running");
});

test("IV-1 scope records apply only to activated submissions", async () => {
  const runId = "run_iv1_kernel_status";
  const store = new MemorySchedulerStore();
  await iv1ReadyStore(runId, store, { activateValidationScope: true });
  assert.throws(
    () =>
      store.append({
        runId,
        type: "task.transitioned",
        occurredAt: CLOCK,
        actor: { role: "runner", id: "scheduler" },
        idempotencyKey: "assign:T1:scoped",
        payload: {
          taskId: "T1",
          status: "assigned",
          patch: { assignedWorkerId: "worker_1", validationScope: iv1Scope() },
        },
      }),
    /only to activated submissions/
  );
});

test("IV-1 valid scope reaches the task projection and submission history", async () => {
  const runId = "run_iv1_kernel_store";
  const store = new MemorySchedulerStore();
  await iv1ReadyStore(runId, store, { activateValidationScope: true });
  driveToRunning(store, runId);
  store.append({
    runId,
    type: "task.transitioned",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "scheduler" },
    idempotencyKey: "submit:T1",
    payload: {
      taskId: "T1",
      status: "submitted",
      patch: submitPatch({ ...iv1Scope(), changed: ["  src/value.mjs  "] }, true),
    },
  });
  const projection = projectionOf(store, runId);
  assert.equal(projection.tasks["T1"]!.status, "submitted");
  assert.deepEqual(projection.tasks["T1"]!.validationScope, iv1Scope());
  const history = projection.submissionHistory!["T1"]!;
  assert.equal(history.length, 1);
  assert.deepEqual(history[0]!.validationScope, iv1Scope());
  assert.equal(history[0]!.changeSetId, "changeset_1");
  // Rebuild from the same events reproduces the scope (append/replay stable).
  const rebuilt = rebuildSchedulerProjection(store.readRun(runId));
  assert.deepEqual(rebuilt.tasks["T1"]!.validationScope, iv1Scope());
  assert.deepEqual(rebuilt.submissionHistory!["T1"]![0]!.validationScope, iv1Scope());
});

test("IV-1 legacy runs without activation submit without a scope", async () => {
  const runId = "run_iv1_legacy";
  const store = new MemorySchedulerStore();
  await iv1ReadyStore(runId, store, { activateValidationScope: false });
  assert.equal(projectionOf(store, runId).validationScopePolicyVersion, undefined);
  driveToRunning(store, runId);
  store.append({
    runId,
    type: "task.transitioned",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "scheduler" },
    idempotencyKey: "submit:T1",
    payload: { taskId: "T1", status: "submitted", patch: submitPatch(undefined, false) },
  });
  const projection = projectionOf(store, runId);
  assert.equal(projection.tasks["T1"]!.status, "submitted");
  assert.equal(projection.tasks["T1"]!.validationScope, undefined);
  assert.equal(projection.submissionHistory!["T1"]![0]!.validationScope, undefined);
});

test("IV-1 legacy runs refuse a scope smuggled in the patch", async () => {
  const runId = "run_iv1_legacy_smuggle";
  const store = new MemorySchedulerStore();
  await iv1ReadyStore(runId, store, { activateValidationScope: false });
  driveToRunning(store, runId);
  assert.throws(
    () =>
      store.append({
        runId,
        type: "task.transitioned",
        occurredAt: CLOCK,
        actor: { role: "runner", id: "scheduler" },
        idempotencyKey: "submit:T1:smuggle",
        payload: { taskId: "T1", status: "submitted", patch: submitPatch(iv1Scope(), true) },
      }),
    /only to activated submissions/
  );
});

test("IV-1 retry replaces the scope instead of inheriting the old attempt", async () => {
  const runId = "run_iv1_retry";
  const store = new MemorySchedulerStore();
  await iv1ReadyStore(runId, store, { activateValidationScope: true });
  driveToRunning(store, runId);
  store.append({
    runId,
    type: "task.transitioned",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "scheduler" },
    idempotencyKey: "submit:T1:1",
    payload: { taskId: "T1", status: "submitted", patch: submitPatch(iv1Scope(), true) },
  });
  assert.deepEqual(projectionOf(store, runId).tasks["T1"]!.validationScope, iv1Scope());
  store.append({
    runId,
    type: "task.transitioned",
    occurredAt: CLOCK,
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "review:T1:1",
    payload: { taskId: "T1", status: "architect_review", patch: {} },
  });
  store.append({
    runId,
    type: "task.transitioned",
    occurredAt: CLOCK,
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "reject:T1:1",
    payload: { taskId: "T1", status: "rejected", patch: {} },
  });
  store.append({
    runId,
    type: "task.transitioned",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "scheduler" },
    idempotencyKey: "retry:T1:1",
    payload: { taskId: "T1", status: "planned", patch: {} },
  });
  const projection = projectionOf(store, runId);
  assert.equal(projection.tasks["T1"]!.status, "planned");
  assert.equal(
    projection.tasks["T1"]!.validationScope,
    undefined,
    "retry clears the old attempt scope"
  );
  assert.deepEqual(
    projection.submissionHistory!["T1"]![0]!.validationScope,
    iv1Scope(),
    "history keeps the submitted scope"
  );
});

test("IV-1 scope survives real SQLite append, rebuild, and reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-iv1-sqlite-"));
  const database = join(root, "scheduler.sqlite");
  const runId = "run_iv1_sqlite";
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(database, { evidenceStore: evidence, artifacts });
  try {
    const fixture = await iv1ReadyStore(runId, store, { activateValidationScope: true });
    store.append({
      runId,
      type: "project_docs.policy_configured",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "docs-policy:iv1",
      payload: { version: 1 },
    });
    const startIdentity = currentExplicitStartIdentity(projectionOf(store, runId));
    assert.ok(startIdentity, "the fixture plan is ready with a complete start identity");
    store.append({
      runId,
      type: "planning.execution_authorized",
      occurredAt: CLOCK,
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "iv1-owner-start",
      payload: { authorization: { ...startIdentity!, version: 1, ownerChoice: "execute" } },
    });
    const stored = await artifacts.put(Buffer.from(FIXTURE_AMENDED_TEXT, "utf8"), "text/plain", "iv1 approved source");
    assert.equal(stored.hash, fixture.manifest.artifactDigest, "the stored source bytes are the manifest authority");
    const evidenceArtifact = await artifacts.put(
      Buffer.from("iv1 sqlite criterion evidence", "utf8"),
      "text/plain",
      "iv1 sqlite criterion evidence",
    );
    const evidenceRecord = evidence.record({
      runId,
      taskId: "T1",
      actor: { role: "worker", id: "worker_1" },
      attempt: 1,
      fact: {
        kind: "command",
        label: "iv1 sqlite criterion",
        command: "node",
        args: ["--test", "test/value.test.mjs"],
        cwd: root,
        startedAt: CLOCK,
        finishedAt: CLOCK,
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
        stdoutArtifactHash: evidenceArtifact.hash,
        stderrArtifactHash: evidenceArtifact.hash,
      },
      createdAt: CLOCK,
      idempotencyKey: "iv1-sqlite-evidence",
    });
    driveToRunning(store, runId);
    store.append({
      runId,
      type: "task.transitioned",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "submit:T1",
      payload: { taskId: "T1", status: "submitted", patch: submitPatch(iv1Scope(), true, evidenceRecord.id, evidenceArtifact.hash) },
    });
    assert.deepEqual(projectionOf(store, runId).tasks["T1"]!.validationScope, iv1Scope());
  } finally {
    store.close();
  }
  const reopened = new SqliteSchedulerStore(database, { evidenceStore: evidence, artifacts });
  try {
    const after = projectionOf(reopened, runId);
    assert.equal(after.tasks["T1"]!.status, "submitted");
    assert.deepEqual(after.tasks["T1"]!.validationScope, iv1Scope());
    assert.deepEqual(after.submissionHistory!["T1"]![0]!.validationScope, iv1Scope());
  } finally {
    reopened.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});
