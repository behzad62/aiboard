import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentModel,
  AgentModelRequest,
  ModelTurn,
  NativeTool,
  ToolExecutionOutput,
  ToolResult,
} from "../src/agent-contracts.js";
import { NEW_POLICY_PLANNING_INSTRUCTIONS, architectContextSections } from "../src/agent-prompts.js";
import { createArchitectTools } from "../src/architect-tools.js";
import { ArtifactStore } from "../src/artifact-store.js";
import {
  ARCHITECT_LIFECYCLE_SURFACE,
  architectLifecycleUniverseNames,
  BuildRuntime,
  type ArchitectActionRequest,
  type ArchitectRuntimeDriver,
} from "../src/build-runtime.js";
import {
  NativeArchitectRuntime,
  PlanningStateCommandGuard,
  PlanningStateInspectionRuntime,
  type ArchitectCommandWorkspaceProvider,
} from "../src/native-architect-runtime.js";
import type {
  ExecutionPlanPhase,
  SourceRequirement,
} from "../src/planning-contracts.js";
import {
  createPlanningTools,
  MAX_PLANNING_SOURCE_SECTION_BYTES,
  PLANNING_TOOL_NAMES,
} from "../src/planning-tools.js";
import {
  isPlanningState,
  newPolicyStaleTasksRequireArchitect,
  newPolicyTaskAdmissionBlocked,
  readyPlanIdentity,
  rebuildSchedulerProjection,
  reduceSchedulerEvent,
  type NewSchedulerEvent,
  type SchedulerEvent,
  type SchedulerProjection,
  type SchedulerStore,
} from "../src/scheduler-store.js";
import { buildSourceManifest, type ApprovedSourceManifest } from "../src/source-manifest.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "../src/runtime-router.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteProjectMemoryStore } from "../src/sqlite-project-memory.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import type { BuildTask } from "../src/task-contracts.js";
import {
  TaskScheduler,
  type WorkerAssignment,
  type WorkerOutcome,
  type WorkerRuntimeDriver,
} from "../src/task-scheduler.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { buildPlanningFixtureScenario } from "./fixtures/planning-source-fixture.js";
import { emptyFinalVerificationProfile } from "./support/final-verification-profile.js";
import {
  CRITERIA as VERIFIER_CRITERIA,
  REVIEW_ID as VERIFIER_REVIEW_ID,
  REVISION as VERIFIER_REVISION,
  SESSION_ID as VERIFIER_SESSION_ID,
  verifierRequestPayload,
} from "./support/verifier-run-fixture.js";

/**
 * T3a: Architect planning tools, the planning-state predicate, plan-only
 * rules, and the ready-plan admission gate.
 *
 * The coverage review + plan_ready events below are seeded directly as the
 * T3b stand-in: T3b will produce them through planning-review.ts and the
 * reviewer runtime, but the durable events already exist (T2), so direct
 * seeding proves the T3a gates against the exact identities T3b will carry.
 */

const CLOCK = "2026-09-24T00:00:00.000Z";
const clock = () => CLOCK;

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

/** Seeds run policy + planning policy + source. Policy stamp lands at sequence 2-3 (run creation). */
function seedNewPolicySource(
  store: SchedulerStore,
  runId: string,
  manifest: ApprovedSourceManifest,
  opts?: { runPolicy?: "finish" | "plan_only"; priorManifest?: ApprovedSourceManifest },
): void {
  const runPolicy = opts?.runPolicy ?? "finish";
  store.append({
    runId,
    type: "run.policy_configured",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "run-policy-configured",
    payload: { runPolicy },
  });
  store.append({
    runId,
    type: "planning.policy_configured",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "runner" },
    idempotencyKey: "planning-policy:1",
    payload: { version: 1 },
  });
  if (opts?.priorManifest) {
    store.append({
      runId,
      type: "planning.source_registered",
      occurredAt: CLOCK,
      actor: { role: "user", id: "owner" },
      idempotencyKey: "source:base",
      payload: { manifest: opts.priorManifest },
    });
    store.append({
      runId,
      type: "planning.source_amended",
      occurredAt: CLOCK,
      actor: { role: "user", id: "owner" },
      idempotencyKey: "source:amend-1",
      payload: { manifest },
    });
  } else {
    store.append({
      runId,
      type: "planning.source_registered",
      occurredAt: CLOCK,
      actor: { role: "user", id: "owner" },
      idempotencyKey: "source:base",
      payload: { manifest },
    });
  }
}

/** Fixture scenario with the amendment's recorded impact scoped (T2 pattern), so retirements validate. */
function scopedFixture() {
  const fixture = buildPlanningFixtureScenario();
  const amendment = fixture.manifest.amendment!;
  return {
    ...fixture,
    manifest: {
      ...fixture.manifest,
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

function withoutDigest<T extends { digest: string }>(value: T): Omit<T, "digest"> {
  const { digest: _digest, ...rest } = value;
  return rest;
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

function outputJson(output: ToolExecutionOutput): Record<string, unknown> {
  const block = output.content[0];
  if (!block || block.type !== "json") throw new Error("Expected a JSON tool output block.");
  return block.value as Record<string, unknown>;
}

/** Tiny manifest + bytes fully owned by the read/checkpoint tests (no fixture text duplication). */
function buildTrackSource(): { text: string; bytes: Buffer; manifest: ApprovedSourceManifest } {
  const lines = ["SECTION s1: alpha.", "SECTION s2: beta.", "SECTION s3: gamma."];
  const text = lines.join("\n");
  const bytes = Buffer.from(text, "utf8");
  const spans: { id: string; startByte: number; endByte: number }[] = [];
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    const lineBytes = Buffer.from(line + (index < lines.length - 1 ? "\n" : ""), "utf8");
    spans.push({ id: `s${index + 1}`, startByte: offset, endByte: offset + lineBytes.length });
    offset += lineBytes.length;
  }
  const manifest = buildSourceManifest(bytes, spans, {
    manifestId: "manifest_track",
    sourceId: "source_track",
    mediaType: "text/plain",
    encoding: "utf-8",
    authority: "owner",
    createdAt: CLOCK,
  });
  return { text, bytes, manifest };
}

function buildTrackLedger(manifest: ApprovedSourceManifest): {
  requirements: SourceRequirement[];
  phases: ExecutionPlanPhase[];
} {
  const requirement = (id: string, sectionId: string): SourceRequirement => ({
    id,
    reference: { sourceId: manifest.sourceId, sectionIds: [sectionId] },
    purpose: `Track obligation ${id}.`,
    observableOutcome: `Obligation ${id} is observably satisfied.`,
    obligationKind: "mandatory",
    applicability: { status: "applicable" },
    accountablePhaseId: "P1",
    contributingTaskIds: [],
    acceptanceConditions: [{
      id: `${id}-ac1`,
      description: `${id} is satisfied.`,
      responsibleGateId: "P1-exit",
      requiredEvidenceKinds: ["command"],
    }],
  });
  return {
    requirements: [requirement("R1", "s1"), requirement("R2", "s2"), requirement("R3", "s3")],
    phases: [{
      id: "P1",
      purpose: "Track phase.",
      requirementIds: ["R1", "R2", "R3"],
      scope: { includes: ["track/a.ts"], excludes: ["track/b.ts"] },
      entryConditions: ["Source registered."],
      contributingTaskIds: ["T1"],
      exitCriteria: ["All track obligations accepted."],
      requiredCombinedValidation: ["typecheck"],
      exitUnlocks: ["done"],
    }],
  };
}

function checkpointArgs(
  id: string,
  covered: readonly string[],
  completed: readonly string[] = ["requirement-ledger"],
): unknown {
  return {
    checkpoint: {
      id,
      coveredSourceSectionIds: [...covered],
      completedPlanningContractIds: [...completed],
      remainingWork: [`Remaining after ${id}.`],
      nextAction: `Continue after ${id}.`,
      recordedAt: CLOCK,
    },
  };
}

test("T3a planning tools expose the five lifecycle tools", () => {
  const store = new MemorySchedulerStore();
  const tools = createPlanningTools({ store, clock });
  try {
    assert.deepEqual(
      tools.map((tool) => tool.definition.name).sort(),
      [...PLANNING_TOOL_NAMES].sort(),
    );
    for (const tool of tools) {
      assert.equal(tool.definition.lifecycle, true, tool.definition.name);
    }
  } finally {
    store.close();
  }
});

test("T3a lifecycle surface and universe derivation include the new planning tools", () => {
  for (const name of PLANNING_TOOL_NAMES) {
    assert.equal(ARCHITECT_LIFECYCLE_SURFACE.includes(name), true, name);
  }
  const universe = architectLifecycleUniverseNames({} as SchedulerStore, clock);
  for (const name of PLANNING_TOOL_NAMES) {
    assert.equal(universe.includes(name), true, name);
  }
  assert.deepEqual([...ARCHITECT_LIFECYCLE_SURFACE], [...universe]);
});

test("T3a legacy architect registration omits planning tools; new-policy registration includes them", () => {
  const store = new MemorySchedulerStore();
  try {
    const legacy = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
      artifacts: {} as ArtifactStore,
    }).map((tool) => tool.definition.name);
    for (const name of PLANNING_TOOL_NAMES) {
      assert.equal(legacy.includes(name), false, `legacy must omit ${name}`);
    }
    const planned = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      planningTools: {},
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
      artifacts: {} as ArtifactStore,
    }).map((tool) => tool.definition.name);
    for (const name of PLANNING_TOOL_NAMES) {
      assert.equal(planned.includes(name), true, `new-policy must include ${name}`);
    }
  } finally {
    store.close();
  }
});

test("T3a source read covers every section in full over the complete inventory", async () => {
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_read";
  const { text, bytes, manifest } = buildTrackSource();
  seedNewPolicySource(store, runId, manifest);
  const tools = createPlanningTools({ store, clock, readSource: async () => bytes });
  try {
    const inventory = await invokePlanningTool(tools, "read_planning_source_section", {}, runId);
    assert.equal(inventory.isError, false);
    const listing = outputJson(inventory);
    assert.equal(listing.manifestId, manifest.manifestId);
    assert.deepEqual(
      (listing.sections as { id: string }[]).map((section) => section.id),
      ["s1", "s2", "s3"],
    );
    // Contiguous from byte 0 with no gap or uncovered tail.
    const sections = listing.sections as { startByte: number; endByte: number }[];
    assert.equal(sections[0]!.startByte, 0);
    assert.equal(sections.at(-1)!.endByte, bytes.length);
    assert.deepEqual(listing.remainingSourceSectionIds, ["s1", "s2", "s3"]);

    const texts: string[] = [];
    for (const sectionId of ["s1", "s2", "s3"]) {
      const output = await invokePlanningTool(
        tools,
        "read_planning_source_section",
        { sectionId },
        runId,
      );
      assert.equal(output.isError, false, sectionId);
      const body = outputJson(output);
      assert.equal(body.sectionId, sectionId);
      texts.push(body.text as string);
    }
    assert.equal(texts.join(""), text);
    // Reads are not lifecycle decisions: no event is appended by reading.
    assert.equal(store.readRun(runId).length, 3);
  } finally {
    store.close();
  }
});

test("T3a source bytes resolve from the artifact store by artifact digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t3a-artifact-source-"));
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_artifact_read";
  const { bytes, manifest } = buildTrackSource();
  seedNewPolicySource(store, runId, manifest);
  try {
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const record = await artifacts.put(Buffer.from(bytes), "text/plain", "source.txt");
    assert.equal(record.hash, manifest.artifactDigest);
    const tools = createPlanningTools({ store, clock, artifacts });
    const output = await invokePlanningTool(
      tools,
      "read_planning_source_section",
      { sectionId: "s2" },
      runId,
    );
    assert.equal(output.isError, false);
    assert.equal(outputJson(output).text, "SECTION s2: beta.\n");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T3a unread section is never counted as covered", async () => {
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_unread";
  const { bytes, manifest } = buildTrackSource();
  seedNewPolicySource(store, runId, manifest);
  const ledger = buildTrackLedger(manifest);
  const tools = createPlanningTools({ store, clock, readSource: async () => bytes });
  try {
    const persisted = await invokePlanningTool(tools, "persist_planning_ledger", {
      id: "ledger-1",
      requirements: ledger.requirements,
      phases: ledger.phases,
    }, runId);
    assert.equal(persisted.isError, false);

    const read = await invokePlanningTool(
      tools, "read_planning_source_section", { sectionId: "s1" }, runId,
    );
    assert.equal(read.isError, false);
    const first = await invokePlanningTool(
      tools, "record_planning_checkpoint", checkpointArgs("checkpoint-1", ["s1"]), runId,
    );
    assert.equal(first.isError, false);

    // s2 was never read: counting it is refused and durable coverage is unchanged.
    const refused = await invokePlanningTool(
      tools, "record_planning_checkpoint", checkpointArgs("checkpoint-2", ["s1", "s2"]), runId,
    );
    assert.equal(refused.isError, true);
    assert.equal(refused.error?.code, "unread_source_section");
    assert.match(refused.error?.message ?? "", /s2/);
    assert.deepEqual(projectionOf(store, runId).planning!.resume.coveredSourceSectionIds, ["s1"]);
  } finally {
    store.close();
  }
});

test("T3a oversized section is refused, never truncated, and never counted", async () => {
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_oversized";
  const bytes = Buffer.from(`head\n${"x".repeat(MAX_PLANNING_SOURCE_SECTION_BYTES + 1)}`, "utf8");
  const headBytes = Buffer.from("head\n", "utf8").length;
  const manifest = buildSourceManifest(bytes, [
    { id: "s1", startByte: 0, endByte: headBytes },
    { id: "s2", startByte: headBytes, endByte: bytes.length },
  ], {
    manifestId: "manifest_oversized",
    sourceId: "source_oversized",
    mediaType: "text/plain",
    encoding: "utf-8",
    authority: "owner",
    createdAt: CLOCK,
  });
  seedNewPolicySource(store, runId, manifest);
  const tools = createPlanningTools({ store, clock, readSource: async () => bytes });
  try {
    const ledger = buildTrackLedger({ ...manifest, sourceId: manifest.sourceId });
    const requirements = [
      { ...ledger.requirements[0]!, id: "R1", reference: { sourceId: manifest.sourceId, sectionIds: ["s1"] } },
      { ...ledger.requirements[1]!, id: "R2", reference: { sourceId: manifest.sourceId, sectionIds: ["s2"] } },
    ];
    const phases = [{ ...ledger.phases[0]!, requirementIds: ["R1", "R2"] }];
    const persisted = await invokePlanningTool(tools, "persist_planning_ledger", {
      id: "ledger-1",
      requirements,
      phases,
    }, runId);
    assert.equal(persisted.isError, false);

    const read = await invokePlanningTool(
      tools, "read_planning_source_section", { sectionId: "s2" }, runId,
    );
    assert.equal(read.isError, true);
    assert.equal(read.error?.code, "source_section_too_large");
    assert.match(read.error?.message ?? "", /never counts as covered/);

    const checkpoint = await invokePlanningTool(
      tools, "record_planning_checkpoint", checkpointArgs("checkpoint-1", ["s2"]), runId,
    );
    assert.equal(checkpoint.isError, true);
    assert.equal(checkpoint.error?.code, "unread_source_section");
    assert.deepEqual(projectionOf(store, runId).planning!.resume.coveredSourceSectionIds, []);
  } finally {
    store.close();
  }
});

test("T3a drifted source bytes are refused and never counted", async () => {
  const runId = "run_t3a_drift";
  const { bytes, manifest } = buildTrackSource();
  const tampered = Buffer.from(bytes);
  tampered[3] = tampered[3]! ^ 0xff;
  const truncated = bytes.subarray(0, bytes.length - 1);
  for (const [label, poisoned] of [["tampered", tampered], ["truncated", truncated]] as const) {
    const store = new MemorySchedulerStore();
    seedNewPolicySource(store, `${runId}_${label}`, manifest);
    const tools = createPlanningTools({ store, clock, readSource: async () => poisoned });
    try {
      const read = await invokePlanningTool(
        tools, "read_planning_source_section", { sectionId: "s1" }, `${runId}_${label}`,
      );
      assert.equal(read.isError, true, label);
      assert.equal(read.error?.code, "source_bytes_drift", label);
    } finally {
      store.close();
    }
  }
});

test("T3a stale manifest and unknown section are refused without reading bytes", async () => {
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_stale";
  const fixture = scopedFixture();
  seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
  // No readSource and no artifacts: these refusals must not need source bytes.
  const tools = createPlanningTools({ store, clock });
  try {
    const stale = await invokePlanningTool(tools, "read_planning_source_section", {
      manifestId: fixture.priorManifest.manifestId,
      sectionId: "s1",
    }, runId);
    assert.equal(stale.isError, true);
    assert.equal(stale.error?.code, "stale_manifest");

    const unknown = await invokePlanningTool(tools, "read_planning_source_section", {
      sectionId: "no-such-section",
    }, runId);
    assert.equal(unknown.isError, true);
    assert.equal(unknown.error?.code, "unknown_manifest_section");
  } finally {
    store.close();
  }
});

test("T3a draft before the ledger is refused; ledger then draft then revise succeed", async () => {
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_ledger_first";
  const fixture = scopedFixture();
  seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
  const tools = createPlanningTools({ store, clock });
  try {
    const early = await invokePlanningTool(tools, "draft_planning_plan", {
      revision: withoutDigest(fixture.revision),
    }, runId);
    assert.equal(early.isError, true);
    assert.equal(early.error?.code, "ledger_required");
    assert.equal(projectionOf(store, runId).planning!.plan, undefined);

    const persisted = await invokePlanningTool(tools, "persist_planning_ledger", {
      id: "ledger-1",
      requirements: fixture.requirements,
      phases: fixture.phases,
    }, runId);
    assert.equal(persisted.isError, false, JSON.stringify(persisted.error));

    const drafted = await invokePlanningTool(tools, "draft_planning_plan", {
      revision: withoutDigest(fixture.revision),
    }, runId);
    assert.equal(drafted.isError, false, JSON.stringify(drafted.error));
    const plan = projectionOf(store, runId).planning!.plan!;
    assert.equal(plan.currentRevisionId, "revision_1");
    assert.equal(plan.currentDigest, fixture.revision.digest);
    // The investigation contract survives the tool round-trip intact.
    const investigation = plan.revisionsById[plan.currentRevisionId]!.tasks
      .find((task) => task.id === "T-INV")!.investigation!;
    assert.ok(investigation.question.length > 0);
    assert.ok(investigation.deliverable.length > 0);
    assert.ok(investigation.decisionCriterion.length > 0);
    assert.deepEqual(investigation.dependentUnlockTaskIds, ["T3"]);

    const revised = await invokePlanningTool(tools, "revise_planning_plan", {
      revision: { ...withoutDigest(fixture.revision), revisionId: "revision_2" },
      expectedRevisionId: plan.currentRevisionId,
      expectedDigest: plan.currentDigest,
    }, runId);
    assert.equal(revised.isError, false, JSON.stringify(revised.error));
    const after = projectionOf(store, runId).planning!.plan!;
    assert.equal(after.currentRevisionId, "revision_2");
    assert.deepEqual(after.revisionHistoryIds, ["revision_1", "revision_2"]);
  } finally {
    store.close();
  }
});

test("T3a invalid ledger and stale revise base are refused", async () => {
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_invalid";
  const fixture = scopedFixture();
  seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
  const tools = createPlanningTools({ store, clock });
  try {
    // Dropping REQ-MANDATORY leaves source section s1 uncovered.
    const dropped = fixture.requirements.filter((item) => item.id !== "REQ-MANDATORY");
    const invalid = await invokePlanningTool(tools, "persist_planning_ledger", {
      id: "ledger-1",
      requirements: dropped,
      phases: fixture.phases,
    }, runId);
    assert.equal(invalid.isError, true);
    assert.equal(invalid.error?.code, "invalid_requirement_ledger");
    assert.match(invalid.error?.message ?? "", /s1/);

    const persisted = await invokePlanningTool(tools, "persist_planning_ledger", {
      id: "ledger-1",
      requirements: fixture.requirements,
      phases: fixture.phases,
    }, runId);
    assert.equal(persisted.isError, false);
    const drafted = await invokePlanningTool(tools, "draft_planning_plan", {
      revision: withoutDigest(fixture.revision),
    }, runId);
    assert.equal(drafted.isError, false);
    const plan = projectionOf(store, runId).planning!.plan!;

    const stale = await invokePlanningTool(tools, "revise_planning_plan", {
      revision: { ...withoutDigest(fixture.revision), revisionId: "revision_2" },
      expectedRevisionId: plan.currentRevisionId,
      expectedDigest: "0".repeat(64),
    }, runId);
    assert.equal(stale.isError, true);
    assert.equal(stale.error?.code, "stale_plan_revision");
  } finally {
    store.close();
  }
});

test("T3a checkpoint and resume through the tools, including after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t3a-resume-"));
  const database = join(root, "scheduler.sqlite");
  const runId = "run_t3a_resume";
  const { bytes, manifest } = buildTrackSource();
  const ledger = buildTrackLedger(manifest);
  const firstStore = new SqliteSchedulerStore(database);
  try {
    seedNewPolicySource(firstStore, runId, manifest);
    const firstTools = createPlanningTools({
      store: firstStore,
      clock,
      readSource: async () => bytes,
    });
    const persisted = await invokePlanningTool(firstTools, "persist_planning_ledger", {
      id: "ledger-1",
      requirements: ledger.requirements,
      phases: ledger.phases,
    }, runId);
    assert.equal(persisted.isError, false);
    const read = await invokePlanningTool(
      firstTools, "read_planning_source_section", { sectionId: "s1" }, runId,
    );
    assert.equal(read.isError, false);
    const checkpoint = await invokePlanningTool(
      firstTools, "record_planning_checkpoint", checkpointArgs("checkpoint-1", ["s1"]), runId,
    );
    assert.equal(checkpoint.isError, false);
    const resume = projectionOf(firstStore, runId).planning!.resume;
    assert.deepEqual(resume.coveredSourceSectionIds, ["s1"]);
    assert.deepEqual(resume.remainingSourceSectionIds, ["s2", "s3"]);
    assert.equal(resume.nextSourceSectionId, "s2");
  } finally {
    firstStore.close();
  }

  // Restart: a fresh store handle and fresh tools resume the exact next section.
  const secondStore = new SqliteSchedulerStore(database);
  try {
    const before = projectionOf(secondStore, runId).planning!.resume;
    assert.deepEqual(before.coveredSourceSectionIds, ["s1"]);
    assert.equal(before.nextSourceSectionId, "s2");
    // Durably covered sections need no re-read; the new section does.
    const secondTools = createPlanningTools({
      store: secondStore,
      clock,
      readSource: async () => bytes,
    });
    const refused = await invokePlanningTool(
      secondTools, "record_planning_checkpoint", checkpointArgs("checkpoint-2", ["s1", "s2"]), runId,
    );
    assert.equal(refused.isError, true);
    assert.equal(refused.error?.code, "unread_source_section");
    const read = await invokePlanningTool(
      secondTools, "read_planning_source_section", { sectionId: "s2" }, runId,
    );
    assert.equal(read.isError, false);
    const checkpoint = await invokePlanningTool(
      secondTools, "record_planning_checkpoint", checkpointArgs("checkpoint-2", ["s1", "s2"]), runId,
    );
    assert.equal(checkpoint.isError, false);
    const after = projectionOf(secondStore, runId).planning!.resume;
    assert.deepEqual(after.coveredSourceSectionIds, ["s1", "s2"]);
    assert.equal(after.nextSourceSectionId, "s3");
  } finally {
    secondStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T3a planning-state predicate: legacy never, new-policy until ready or triage answer", () => {
  const fixture = scopedFixture();
  const legacyStore = new MemorySchedulerStore();
  legacyStore.append({
    runId: "run_t3a_legacy",
    type: "run.policy_configured",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "run-policy-configured",
    payload: { runPolicy: "finish" },
  });
  try {
    assert.equal(isPlanningState(projectionOf(legacyStore, "run_t3a_legacy")), false);
  } finally {
    legacyStore.close();
  }

  const store = new MemorySchedulerStore();
  const runId = "run_t3a_predicate";
  seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
  try {
    // No triage decision yet (T9 has not landed): planning state.
    assert.equal(isPlanningState(projectionOf(store, runId)), true);

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
    store.append({
      runId,
      type: "planning.plan_drafted",
      occurredAt: CLOCK,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:revision-1",
      payload: { revision: fixture.revision, expectedRevisionId: null, expectedDigest: null },
    });
    const drafted = projectionOf(store, runId);
    assert.equal(isPlanningState(drafted), true);
    assert.equal(readyPlanIdentity(drafted), undefined);
    // Triage build/clarify stay in planning state; answer leaves it (T9 seam:
    // the decision field is set directly until T9's triage events land).
    assert.equal(
      isPlanningState({ ...drafted, planningTriageDecision: "build" }),
      true,
    );
    assert.equal(
      isPlanningState({ ...drafted, planningTriageDecision: "clarify" }),
      true,
    );
    assert.equal(
      isPlanningState({ ...drafted, planningTriageDecision: "answer" }),
      false,
    );

    // The T3b stand-in: a bound coverage review plus plan_ready.
    store.append({
      runId,
      type: "planning.coverage_review_recorded",
      occurredAt: CLOCK,
      actor: { role: "verifier", id: "reviewer" },
      idempotencyKey: "coverage:1",
      payload: { review: fixture.coverageReview },
    });
    store.append({
      runId,
      type: "planning.plan_ready",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "runner" },
      idempotencyKey: "ready:1",
      payload: { hostCapabilities: fixture.hostCapabilities },
    });
    const ready = projectionOf(store, runId);
    assert.equal(isPlanningState(ready), false);
    assert.deepEqual(readyPlanIdentity(ready), {
      revisionId: "revision_1",
      digest: fixture.revision.digest,
    });
  } finally {
    store.close();
  }
});

test("T3a planning-state inspection runtime refuses commands and keeps inspection", async () => {
  const registry = new ToolRegistry();
  const probe: NativeTool<unknown> = {
    definition: {
      name: "run_evidence_command",
      description: "probe",
      inputSchema: { type: "object", additionalProperties: false },
      readOnly: false,
      effect: "none",
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({ content: [], isError: false }),
  };
  const reader: NativeTool<unknown> = {
    definition: {
      name: "fs.read",
      description: "probe reader",
      inputSchema: { type: "object", additionalProperties: false },
      readOnly: true,
      effect: "none",
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({ content: [{ type: "text", text: "content" }], isError: false }),
  };
  registry.register(probe);
  registry.register(reader);
  const runtime = new PlanningStateInspectionRuntime(registry);
  const names = runtime.definitions().map((definition) => definition.name);
  assert.equal(names.includes("run_evidence_command"), false);
  assert.equal(names.includes("fs.read"), true);
  const context = {
    runId: "run_t3a_refusal",
    sessionId: "architect:run_t3a_refusal",
    actor: { role: "architect" as const, id: "architect" },
  };
  const refused = await runtime.invoke({
    type: "tool_call",
    callId: "forged",
    name: "run_evidence_command",
    arguments: {},
  }, context);
  assert.equal(refused.isError, true);
  assert.equal(refused.error?.code, "planning_state_command_refused");
  const allowed = await runtime.invoke({
    type: "tool_call",
    callId: "read",
    name: "fs.read",
    arguments: {},
  }, context);
  assert.equal(allowed.isError, false);
});

class ScriptedModel implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly turns: Array<ModelTurn | Error>) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const turn = this.turns.shift();
    if (!turn) throw new Error("script exhausted");
    if (turn instanceof Error) throw turn;
    return turn;
  }
}

function toolResults(model: ScriptedModel, requestIndex: number): ToolResult[] {
  return (model.requests[requestIndex]?.messages ?? []).flatMap((message) =>
    message.role === "tool" && typeof message.content !== "string" && !Array.isArray(message.content)
      ? [message.content]
      : [],
  );
}

async function driveArchitectPlanningStateTurn(input: {
  label: string;
  seed: (store: SqliteSchedulerStore, runId: string) => void;
}): Promise<{ model: ScriptedModel; creates: number; cleanups: number }> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-t3a-${input.label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
  const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
  const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
  const runId = `run-${input.label}`;
  const objective = "Build the feature.";
  const seen = { creates: 0, cleanups: 0 };
  try {
    scheduler.append({
      runId,
      type: "run.initialized",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "test" },
      idempotencyKey: "init",
      payload: { objective },
    });
    input.seed(scheduler, runId);
    // A valid integration revision, so the command tool WOULD be composed for
    // a run outside planning state — its absence below is the guard, not a
    // missing revision.
    scheduler.append({
      runId,
      type: "integration.revision_advanced",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "test" },
      idempotencyKey: "integration",
      payload: { integrationRevision: "a".repeat(40) },
    });
    const candidate: AgentRuntimeCandidate = {
      runtimeId: "test:architect",
      providerId: "test",
      modelId: "architect",
      capabilities: ["code"],
      priority: 1,
    };
    const health = new ProviderHealthRegistry();
    const model = new ScriptedModel([
      {
        blocks: [{
          type: "tool_call",
          callId: "cmd-1",
          name: "run_evidence_command",
          arguments: { label: "cmd-1", command: "echo", args: ["hi"], cwd: "." },
        }],
        stopReason: "tool_calls",
      },
      { blocks: [], stopReason: "cancelled" },
    ]);
    const architect = new NativeArchitectRuntime({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates: [candidate], health }),
      health,
      candidates: [candidate],
      models: new Map([[candidate.runtimeId, model]]),
      initialRuntimeId: candidate.runtimeId,
      sessions,
      artifacts,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      evidenceStore: evidence,
      projectId: `project-${input.label}`,
      projectRoot: project,
      objective,
      commandWorkspace: {
        workspaceKind: "independent-verifier",
        create: async () => {
          seen.creates += 1;
          return { path: join(root, "copy") };
        },
        cleanup: async () => {
          seen.cleanups += 1;
        },
      } satisfies ArchitectCommandWorkspaceProvider,
    });
    await architect.run({
      runId,
      reason: { type: "plan_required" },
      projection: projectionOf(scheduler, runId),
      tools: new ToolRegistry(),
      context: {
        runId,
        sessionId: `architect:${runId}`,
        actor: { role: "architect", id: "architect" },
      },
    });
    return { model, creates: seen.creates, cleanups: seen.cleanups };
  } finally {
    sessions.close();
    scheduler.close();
    evidence.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("T3a architect turn in planning state is refused command execution before triage", async () => {
  const { manifest } = buildTrackSource();
  const { model, creates, cleanups } = await driveArchitectPlanningStateTurn({
    label: "t3a-planning-state",
    seed: (scheduler, runId) => seedNewPolicySource(scheduler, runId, manifest),
  });
  const listed = (model.requests[0]?.tools ?? []).map((tool) => tool.name);
  assert.equal(listed.includes("run_evidence_command"), false);
  assert.equal(listed.includes("fs.read"), true);
  // The command layer is never composed, so the forged call is not registered
  // at all; no disposable copy is created.
  const results = toolResults(model, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.isError, true);
  assert.equal(results[0]!.error?.code, "unknown_tool");
  assert.equal(creates, 0);
  assert.equal(cleanups, 0);
});

test("T3a legacy architect turn still lists the command tool", async () => {
  const { model } = await driveArchitectPlanningStateTurn({
    label: "t3a-legacy-command",
    seed: (scheduler, runId) => {
      scheduler.append({
        runId,
        type: "run.policy_configured",
        occurredAt: CLOCK,
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: "run-policy-configured",
        payload: { runPolicy: "finish" },
      });
    },
  });
  const listed = (model.requests[0]?.tools ?? []).map((tool) => tool.name);
  assert.equal(listed.includes("run_evidence_command"), true);
});

test("T3a new-policy planning instructions appear only on new-policy runs", () => {
  assert.equal(NEW_POLICY_PLANNING_INSTRUCTIONS.split("\n").length, 5);
  assert.match(NEW_POLICY_PLANNING_INSTRUCTIONS, /read_planning_source_section/);
  assert.match(NEW_POLICY_PLANNING_INSTRUCTIONS, /persist_planning_ledger/);
  assert.match(NEW_POLICY_PLANNING_INSTRUCTIONS, /planning state/);
  const { manifest } = buildTrackSource();
  const store = new MemorySchedulerStore();
  seedNewPolicySource(store, "run_t3a_prompts", manifest);
  try {
    const sections = architectContextSections({
      limits: { maxBytes: 1024 * 1024, maxEstimatedTokens: 128 * 1024 },
      objective: "Build the feature.",
      reason: { type: "plan_required" },
      projection: projectionOf(store, "run_t3a_prompts"),
      instructions: [],
      skills: [],
      memories: [],
      evidence: [],
      recentHistory: [],
    });
    assert.equal(
      sections.some((section) => section.id === "new-policy-planning"),
      true,
    );
    const legacySections = architectContextSections({
      limits: { maxBytes: 1024 * 1024, maxEstimatedTokens: 128 * 1024 },
      objective: "Build the feature.",
      reason: { type: "plan_required" },
      projection: { ...projectionOf(store, "run_t3a_prompts"), planningPolicyVersion: undefined },
      instructions: [],
      skills: [],
      memories: [],
      evidence: [],
      recentHistory: [],
    });
    assert.equal(
      legacySections.some((section) => section.id === "new-policy-planning"),
      false,
    );
  } finally {
    store.close();
  }
});

function seedReadyPlan(
  store: SchedulerStore,
  runId: string,
  fixture: ReturnType<typeof scopedFixture>,
): void {
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
  store.append({
    runId,
    type: "planning.plan_drafted",
    occurredAt: CLOCK,
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "plan:revision-1",
    payload: { revision: fixture.revision, expectedRevisionId: null, expectedDigest: null },
  });
  // T3b stand-in: the coverage review and plan_ready T3b will produce.
  store.append({
    runId,
    type: "planning.coverage_review_recorded",
    occurredAt: CLOCK,
    actor: { role: "verifier", id: "reviewer" },
    idempotencyKey: "coverage:1",
    payload: { review: fixture.coverageReview },
  });
  store.append({
    runId,
    type: "planning.plan_ready",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "runner" },
    idempotencyKey: "ready:1",
    payload: { hostCapabilities: fixture.hostCapabilities },
  });
}

async function invokeCompleteRun(store: SchedulerStore, runId: string): Promise<ToolExecutionOutput> {
  const tools = createArchitectTools({
    store,
    clock,
    runPolicy: "plan_only",
    planOnlyCompletionAvailable: true,
    architectAction: {
      reason: { type: "completion_decision_required", runPolicy: "plan_only" },
      sequence: 0,
    },
  });
  const tool = tools.find((candidate) => candidate.definition.name === "complete_run");
  assert.ok(tool, "complete_run is registered");
  const validation = tool.validate({ summary: "Plan complete." });
  assert.equal(validation.ok, true);
  return await tool.execute(
    validation.ok ? validation.value : undefined,
    { runId, sessionId: `architect:${runId}`, actor: { role: "architect", id: "architect_1" } },
  );
}

function planTask(id: string, dependencies: string[] = []): BuildTask {
  return {
    id,
    objective: `Objective ${id}`,
    dependencies,
    acceptanceCriteria: [{ id: "ready", text: `Task ${id} is complete.` }],
    acceptanceCriteriaVersion: 1,
    status: "planned",
    requiredCapabilities: [],
    attempt: 0,
  };
}

function seedLegacyPlan(store: SchedulerStore, runId: string, tasks: BuildTask[]): void {
  store.append({
    runId,
    type: "plan.created",
    occurredAt: CLOCK,
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "plan:1",
    payload: { revision: 1, tasks },
  });
}

/** Owner amendment that adds one section, flipping durable readiness back to not_ready. */
function appendSourceAmendment(
  store: SchedulerStore,
  runId: string,
  key: string,
  sectionId: string,
): void {
  const current = projectionOf(store, runId).planning!.source;
  const prior = current.manifestsById[current.currentManifestId]!;
  store.append({
    runId,
    type: "planning.source_amended",
    occurredAt: CLOCK,
    actor: { role: "user", id: "owner" },
    idempotencyKey: key,
    payload: {
      manifest: {
        ...prior,
        manifestId: `manifest_${sectionId}`,
        artifactDigest: "9".repeat(64),
        byteLength: prior.byteLength + 10,
        sections: [
          ...prior.sections,
          {
            id: sectionId,
            startByte: prior.byteLength,
            endByte: prior.byteLength + 10,
            digest: "8".repeat(64),
          },
        ],
        amendment: {
          id: `amend_${sectionId}`,
          priorManifestId: prior.manifestId,
          priorArtifactDigest: prior.artifactDigest,
          authorizedBy: "owner",
          rationale: "Add a section after readiness.",
          recordedImpact: {
            addsSectionIds: [sectionId],
            retiresSectionIds: [],
            addsRequirementIds: [],
            retiresRequirementIds: [],
          },
        },
        createdAt: CLOCK,
      },
    },
  });
}

test("T3a plan_only completion requires the ready plan identity", async () => {
  const fixture = scopedFixture();
  const store = new MemorySchedulerStore();
  const unreadyRun = "run_t3a_planonly_unready";
  seedNewPolicySource(store, unreadyRun, fixture.manifest, {
    runPolicy: "plan_only",
    priorManifest: fixture.priorManifest,
  });
  try {
    const refused = await invokeCompleteRun(store, unreadyRun);
    assert.equal(refused.isError, true);
    assert.equal(refused.error?.code, "completion_not_ready");
    assert.match(refused.error?.message ?? "", /ready plan/);
    // The reducer agrees on the direct event path.
    assert.throws(
      () =>
        store.append({
          runId: unreadyRun,
          type: "project.handoff_requested",
          occurredAt: CLOCK,
          actor: { role: "architect", id: "architect_1" },
          idempotencyKey: "project-handoff-requested",
          payload: { summary: "Plan complete." },
        }),
      /requires a ready plan revision/,
    );

    const readyRun = "run_t3a_planonly_ready";
    seedNewPolicySource(store, readyRun, fixture.manifest, {
      runPolicy: "plan_only",
      priorManifest: fixture.priorManifest,
    });
    seedReadyPlan(store, readyRun, fixture);
    const completed = await invokeCompleteRun(store, readyRun);
    assert.equal(completed.isError, false, JSON.stringify(completed.error));
    assert.equal(projectionOf(store, readyRun).projectHandoff?.status, "requested");

    // Legacy plan_only keeps its exact legacy gate.
    const legacyRun = "run_t3a_planonly_legacy";
    store.append({
      runId: legacyRun,
      type: "run.policy_configured",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "run-policy-configured",
      payload: { runPolicy: "plan_only" },
    });
    assert.throws(
      () =>
        store.append({
          runId: legacyRun,
          type: "project.handoff_requested",
          occurredAt: CLOCK,
          actor: { role: "architect", id: "architect_1" },
          idempotencyKey: "project-handoff-requested",
          payload: { summary: "Plan complete." },
        }),
      /requires a valid plan/,
    );
  } finally {
    store.close();
  }
});

test("T3a documentation gate still blocks new-policy plan_only completion", async () => {
  const fixture = scopedFixture();
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_docs_gate";
  seedNewPolicySource(store, runId, fixture.manifest, {
    runPolicy: "plan_only",
    priorManifest: fixture.priorManifest,
  });
  seedReadyPlan(store, runId, fixture);
  store.append({
    runId,
    type: "project_docs.policy_configured",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "project-docs-policy",
    payload: { version: 1 },
  });
  try {
    // Ready plan, but docs/project/STATE.md was never committed: blocked (G-3).
    const refused = await invokeCompleteRun(store, runId);
    assert.equal(refused.isError, true);
    assert.equal(refused.error?.code, "completion_not_ready");
    assert.match(refused.error?.message ?? "", /docs\/project\/STATE\.md/);
  } finally {
    store.close();
  }
});

class CountingWorkerDriver implements WorkerRuntimeDriver {
  readonly assignments: string[] = [];
  async run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    this.assignments.push(assignment.task.id);
    return { type: "failed", reason: "must_not_dispatch" };
  }
}

class PlanningArchitectDriver implements ArchitectRuntimeDriver {
  readonly turns: string[][] = [];
  private step = 0;
  constructor(private readonly fixture: ReturnType<typeof scopedFixture>) {}
  async run(request: ArchitectActionRequest): Promise<void> {
    this.turns.push(request.tools.definitions().map((tool) => tool.name));
    const step = this.step++;
    const invoke = async (callId: string, name: string, args: unknown) => {
      const result = await request.tools.invoke(
        { type: "tool_call", callId, name, arguments: args },
        request.context,
      );
      assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.error)}`);
    };
    if (step === 0) {
      await invoke(`plan-${step}`, "persist_planning_ledger", {
        id: "ledger-1",
        requirements: this.fixture.requirements,
        phases: this.fixture.phases,
      });
    } else if (step === 2) {
      await invoke(`plan-${step}`, "draft_planning_plan", {
        revision: withoutDigest(this.fixture.revision),
      });
    } else {
      await invoke(`plan-${step}`, "record_planning_checkpoint", checkpointArgs(`checkpoint-${step}`, []));
    }
  }
}

test("T3a plan_only new-policy run dispatches zero workers, including after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t3a-planonly-"));
  const database = join(root, "scheduler.sqlite");
  const runId = "run_t3a_planonly";
  const fixture = scopedFixture();
  const worker = new CountingWorkerDriver();
  const architect = new PlanningArchitectDriver(fixture);
  let workspaceCalls = 0;
  const runtimeOptions = (store: SchedulerStore) => ({
    runId,
    runPolicy: "plan_only" as const,
    store,
    workerDriver: worker as WorkerRuntimeDriver,
    architectDriver: architect,
    integrationDriver: {
      integrate: async (): Promise<never> => {
        throw new Error("must_not_integrate");
      },
    },
    maxConcurrency: 1,
    workspaceFor: async (): Promise<never> => {
      throw new Error("must_not_allocate");
    },
    clock,
  });
  const directAssigned = (store: SchedulerStore, key: string): void => {
    store.append({
      runId,
      type: "task.transitioned",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: key,
      payload: {
        taskId: "a",
        status: "assigned",
        patch: { attempt: 1, assignedWorkerId: "worker_a_1", workspacePath: "C:/work/a" },
      },
    });
  };
  const firstStore = new SqliteSchedulerStore(database);
  try {
    seedNewPolicySource(firstStore, runId, fixture.manifest, {
      runPolicy: "plan_only",
      priorManifest: fixture.priorManifest,
    });
    const first = new BuildRuntime(runtimeOptions(firstStore));
    for (let turn = 0; turn < 3; turn += 1) {
      const step = await first.step();
      assert.equal(step.status, "progressed", `turn ${turn}`);
      assert.equal(step.action, "plan_required", `turn ${turn}`);
    }
    assert.deepEqual(worker.assignments, []);
    assert.equal(projectionOf(firstStore, runId).integrationRevision, undefined);
    for (const names of architect.turns) {
      for (const name of PLANNING_TOOL_NAMES) {
        assert.equal(names.includes(name), true, `turn registers ${name}`);
      }
      assert.equal(names.includes("complete_run"), false, "complete_run is not offered before readiness");
      // T3a repair (B1b): planning-state turns hide the legacy plan tools
      // (reconcile_plan is finish-only, so only the other two are sharp here;
      // the B1 definitions test covers all three on finish runs).
      for (const name of ["plan_tasks", "revise_task"]) {
        assert.equal(names.includes(name), false, `planning-state turn hides ${name}`);
      }
    }
    // The sharp arm: a READY plan plus real scheduler tasks, then a tick.
    // Without the plan_only guards this dispatches.
    firstStore.append({
      runId,
      type: "planning.coverage_review_recorded",
      occurredAt: CLOCK,
      actor: { role: "verifier", id: "reviewer" },
      idempotencyKey: "coverage:1",
      payload: { review: fixture.coverageReview },
    });
    firstStore.append({
      runId,
      type: "planning.plan_ready",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "runner" },
      idempotencyKey: "ready:1",
      payload: { hostCapabilities: fixture.hostCapabilities },
    });
    seedLegacyPlan(firstStore, runId, [planTask("a"), planTask("b")]);
    const scheduler = new TaskScheduler({
      runId,
      store: firstStore,
      driver: worker as WorkerRuntimeDriver,
      maxConcurrency: 1,
      workspaceFor: async () => {
        workspaceCalls += 1;
        return "C:/work/planonly";
      },
      clock,
    });
    await scheduler.tick();
    await scheduler.awaitIdle();
    assert.deepEqual(worker.assignments, []);
    assert.equal(workspaceCalls, 0);
    assert.deepEqual(
      Object.values(projectionOf(firstStore, runId).tasks).map((task) => task.status),
      ["planned", "planned"],
    );
    assert.throws(() => directAssigned(firstStore, "direct:planonly-first"), /never admit workers/);
  } finally {
    firstStore.close();
  }

  const secondStore = new SqliteSchedulerStore(database);
  try {
    // After restart the ready plan and its tasks are still there — and the
    // tick still dispatches nothing.
    assert.equal(projectionOf(secondStore, runId).planning!.readiness, "ready");
    assert.deepEqual(Object.keys(projectionOf(secondStore, runId).tasks).sort(), ["a", "b"]);
    const scheduler = new TaskScheduler({
      runId,
      store: secondStore,
      driver: worker as WorkerRuntimeDriver,
      maxConcurrency: 1,
      workspaceFor: async () => {
        workspaceCalls += 1;
        return "C:/work/planonly";
      },
      clock,
    });
    await scheduler.tick();
    await scheduler.awaitIdle();
    assert.deepEqual(worker.assignments, []);
    assert.equal(workspaceCalls, 0);
    assert.deepEqual(
      Object.values(projectionOf(secondStore, runId).tasks).map((task) => task.status),
      ["planned", "planned"],
    );
    assert.throws(() => directAssigned(secondStore, "direct:planonly-second"), /never admit workers/);
  } finally {
    secondStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

class DeferredDriver implements WorkerRuntimeDriver {
  readonly assignments: string[] = [];
  private readonly pending = new Map<string, (outcome: WorkerOutcome) => void>();
  run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    this.assignments.push(assignment.task.id);
    return new Promise((resolve) => {
      this.pending.set(assignment.task.id, resolve);
    });
  }
  resolve(taskId: string, outcome: WorkerOutcome): void {
    this.pending.get(taskId)?.(outcome);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for scheduler state.");
}

test("T3a worker admission refused until ready, blocked again after a source change", async () => {
  const fixture = scopedFixture();
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_admission";
  seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
  const tools = createPlanningTools({ store, clock });
  try {
    // Ledger and draft flow through the tools; coverage + ready are the T3b stand-in.
    const persisted = await invokePlanningTool(tools, "persist_planning_ledger", {
      id: "ledger-1",
      requirements: fixture.requirements,
      phases: fixture.phases,
    }, runId);
    assert.equal(persisted.isError, false);
    const drafted = await invokePlanningTool(tools, "draft_planning_plan", {
      revision: withoutDigest(fixture.revision),
    }, runId);
    assert.equal(drafted.isError, false);
    const driver = new DeferredDriver();
    const scheduler = new TaskScheduler({
      runId,
      store,
      driver: driver as WorkerRuntimeDriver,
      maxConcurrency: 2,
      workspaceFor: async (task, attempt) => `C:/work/${task.id}/${attempt}`,
      clock,
    });
    // Before readiness no scheduler task can even exist on a new-policy run:
    // the reducer refuses plan.created outright (see the B1 direct-event
    // test), so the pre-ready tick trivially dispatches nothing.
    await scheduler.tick();
    assert.deepEqual(driver.assignments, []);
    assert.deepEqual(Object.keys(projectionOf(store, runId).tasks), []);

    store.append({
      runId,
      type: "planning.coverage_review_recorded",
      occurredAt: CLOCK,
      actor: { role: "verifier", id: "reviewer" },
      idempotencyKey: "coverage:1",
      payload: { review: fixture.coverageReview },
    });
    store.append({
      runId,
      type: "planning.plan_ready",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "runner" },
      idempotencyKey: "ready:1",
      payload: { hostCapabilities: fixture.hostCapabilities },
    });
    // Legacy scheduler tasks stand in for the T4 bridge. They may only be
    // seeded once the ready plan exists, and are bound to it at creation.
    seedLegacyPlan(store, runId, [planTask("a"), planTask("b"), planTask("c")]);
    await scheduler.tick();
    assert.deepEqual(driver.assignments, ["a", "b"]);
    driver.resolve("a", { type: "failed", reason: "fixture_failure" });
    driver.resolve("b", { type: "failed", reason: "fixture_failure" });
    await waitFor(() => projectionOf(store, runId).tasks.a.status === "failed");
    await waitFor(() => projectionOf(store, runId).tasks.b.status === "failed");

    // A source amendment after readiness blocks further admission until re-readiness.
    const current = projectionOf(store, runId).planning!.source;
    const prior = current.manifestsById[current.currentManifestId]!;
    store.append({
      runId,
      type: "planning.source_amended",
      occurredAt: CLOCK,
      actor: { role: "user", id: "owner" },
      idempotencyKey: "source:amend-2",
      payload: {
        manifest: {
          ...prior,
          manifestId: "manifest_amend_2",
          artifactDigest: "9".repeat(64),
          byteLength: prior.byteLength + 10,
          sections: [
            ...prior.sections,
            {
              id: "s9",
              startByte: prior.byteLength,
              endByte: prior.byteLength + 10,
              digest: "8".repeat(64),
            },
          ],
          amendment: {
            id: "amend-2",
            priorManifestId: prior.manifestId,
            priorArtifactDigest: prior.artifactDigest,
            authorizedBy: "owner",
            rationale: "Add section s9 after readiness.",
            recordedImpact: {
              addsSectionIds: ["s9"],
              retiresSectionIds: [],
              addsRequirementIds: [],
              retiresRequirementIds: [],
            },
          },
          createdAt: CLOCK,
        },
      },
    });
    assert.equal(projectionOf(store, runId).planning!.readiness, "not_ready");
    await scheduler.tick();
    assert.deepEqual(driver.assignments, ["a", "b"]);
    assert.equal(projectionOf(store, runId).tasks.c.status, "planned");
    await scheduler.awaitIdle();
  } finally {
    store.close();
  }
});

test("T3a worker admission blocked again after a plan change, with a ready control", async () => {
  const fixture = scopedFixture();
  for (const label of ["control", "revised"] as const) {
    const store = new MemorySchedulerStore();
    const runId = `run_t3a_revise_${label}`;
    seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
    const tools = createPlanningTools({ store, clock });
    try {
      const persisted = await invokePlanningTool(tools, "persist_planning_ledger", {
        id: "ledger-1",
        requirements: fixture.requirements,
        phases: fixture.phases,
      }, runId);
      assert.equal(persisted.isError, false);
      const drafted = await invokePlanningTool(tools, "draft_planning_plan", {
        revision: withoutDigest(fixture.revision),
      }, runId);
      assert.equal(drafted.isError, false);
      store.append({
        runId,
        type: "planning.coverage_review_recorded",
        occurredAt: CLOCK,
        actor: { role: "verifier", id: "reviewer" },
        idempotencyKey: "coverage:1",
        payload: { review: fixture.coverageReview },
      });
      store.append({
        runId,
        type: "planning.plan_ready",
        occurredAt: CLOCK,
        actor: { role: "runner", id: "runner" },
        idempotencyKey: "ready:1",
        payload: { hostCapabilities: fixture.hostCapabilities },
      });
      // Tasks stand in for the T4 bridge; seeding requires the ready plan.
      seedLegacyPlan(store, runId, [planTask("a"), planTask("b")]);
      const driver = new DeferredDriver();
      const scheduler = new TaskScheduler({
        runId,
        store,
        driver: driver as WorkerRuntimeDriver,
        maxConcurrency: 1,
        workspaceFor: async (task, attempt) => `C:/work/${task.id}/${attempt}`,
        clock,
      });
      await scheduler.tick();
      assert.deepEqual(driver.assignments, ["a"], label);
      driver.resolve("a", { type: "failed", reason: "fixture_failure" });
      await waitFor(() => projectionOf(store, runId).tasks.a.status === "failed");
      if (label === "revised") {
        const plan = projectionOf(store, runId).planning!.plan!;
        const revised = await invokePlanningTool(tools, "revise_planning_plan", {
          revision: { ...withoutDigest(fixture.revision), revisionId: "revision_2" },
          expectedRevisionId: plan.currentRevisionId,
          expectedDigest: plan.currentDigest,
        }, runId);
        assert.equal(revised.isError, false);
        assert.equal(projectionOf(store, runId).planning!.readiness, "not_ready");
      }
      await scheduler.tick();
      if (label === "control") {
        assert.deepEqual(driver.assignments, ["a", "b"], label);
      } else {
        assert.deepEqual(driver.assignments, ["a"], label);
        assert.equal(projectionOf(store, runId).tasks.b.status, "planned", label);
      }
      driver.resolve("b", { type: "failed", reason: "fixture_failure" });
      await scheduler.awaitIdle();
    } finally {
      store.close();
    }
  }
});

test("T3a direct scheduler dispatch bypass is refused before readiness", () => {
  const fixture = scopedFixture();
  const store = new MemorySchedulerStore();
  const transition = (runId: string, taskId: string, status: string, key: string): NewSchedulerEvent => ({
    runId,
    type: "task.transitioned",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "scheduler" },
    idempotencyKey: key,
    payload: {
      taskId,
      status,
      patch: { attempt: 1, assignedWorkerId: `worker_${taskId}_1`, workspacePath: `C:/work/${taskId}` },
    },
  });
  try {
    // Readiness lost after tasks exist: transitions are refused again.
    // (Tasks cannot exist before the first readiness at all — plan.created
    // itself is refused; see the B1 direct-event test.)
    const unreadyRun = "run_t3a_bypass_unready";
    seedNewPolicySource(store, unreadyRun, fixture.manifest, { priorManifest: fixture.priorManifest });
    seedReadyPlan(store, unreadyRun, fixture);
    seedLegacyPlan(store, unreadyRun, [planTask("a"), planTask("b")]);
    appendSourceAmendment(store, unreadyRun, "source:amend-lost", "s9");
    assert.equal(projectionOf(store, unreadyRun).planning!.readiness, "not_ready");
    assert.throws(
      () => store.append(transition(unreadyRun, "a", "assigned", "direct:assigned")),
      /requires a ready plan revision/,
    );
    assert.throws(
      () => store.append(transition(unreadyRun, "b", "running", "direct:running")),
      /requires a ready plan revision/,
    );

    // Plan-only with a READY plan: the sharp case — plan-only never admits
    // workers even when a ready plan exists.
    const planOnlyRun = "run_t3a_bypass_planonly";
    seedNewPolicySource(store, planOnlyRun, fixture.manifest, {
      runPolicy: "plan_only",
      priorManifest: fixture.priorManifest,
    });
    seedReadyPlan(store, planOnlyRun, fixture);
    seedLegacyPlan(store, planOnlyRun, [planTask("a")]);
    assert.throws(
      () => store.append(transition(planOnlyRun, "a", "assigned", "direct:planonly")),
      /never admit workers/,
    );

    const readyRun = "run_t3a_bypass_ready";
    seedNewPolicySource(store, readyRun, fixture.manifest, { priorManifest: fixture.priorManifest });
    seedReadyPlan(store, readyRun, fixture);
    seedLegacyPlan(store, readyRun, [planTask("a")]);
    store.append(transition(readyRun, "a", "assigned", "direct:ready"));
    assert.equal(projectionOf(store, readyRun).tasks.a.status, "assigned");

    // Legacy runs keep today's direct-dispatch behavior, including plan_only.
    for (const runPolicy of ["finish", "plan_only"] as const) {
      const legacyRun = `run_t3a_bypass_legacy_${runPolicy}`;
      store.append({
        runId: legacyRun,
        type: "run.policy_configured",
        occurredAt: CLOCK,
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: "run-policy-configured",
        payload: { runPolicy },
      });
      seedLegacyPlan(store, legacyRun, [planTask("a")]);
      store.append(transition(legacyRun, "a", "assigned", "direct:legacy"));
      assert.equal(projectionOf(store, legacyRun).tasks.a.status, "assigned", runPolicy);
    }
  } finally {
    store.close();
  }
});

test("T3a plan_only scheduler tick dispatches zero workers directly, even when ready", async () => {
  const fixture = scopedFixture();
  for (const label of ["unready", "ready"] as const) {
    const store = new MemorySchedulerStore();
    const runId = `run_t3a_tick_${label}`;
    seedNewPolicySource(store, runId, fixture.manifest, {
      runPolicy: "plan_only",
      priorManifest: fixture.priorManifest,
    });
    // Tasks may only be seeded under a ready plan; the unready arm then
    // loses readiness again, so both arms hold a task the tick must refuse.
    seedReadyPlan(store, runId, fixture);
    seedLegacyPlan(store, runId, [planTask("a")]);
    if (label === "unready") {
      appendSourceAmendment(store, runId, "source:amend-lost", "s9");
      assert.equal(projectionOf(store, runId).planning!.readiness, "not_ready");
    }
    const driver = new DeferredDriver();
    const scheduler = new TaskScheduler({
      runId,
      store,
      driver,
      maxConcurrency: 1,
      workspaceFor: async (task, attempt) => `C:/work/${task.id}/${attempt}`,
      clock,
    });
    try {
      await scheduler.tick();
      assert.deepEqual(driver.assignments, [], label);
      assert.equal(projectionOf(store, runId).tasks.a.status, "planned", label);
      await scheduler.awaitIdle();
    } finally {
      store.close();
    }
  }
});

test("T3a repair B1: legacy plan tools refuse before readiness and bind once ready", async () => {
  const fixture = scopedFixture();
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_b1_toolpath";
  seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
  const invoke = async (name: string, args: unknown): Promise<ToolExecutionOutput> => {
    const tools = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
    });
    const tool = tools.find((candidate) => candidate.definition.name === name);
    assert.ok(tool, `${name} is registered`);
    const validation = tool.validate(args);
    assert.equal(validation.ok, true, `${name} arguments validate`);
    return await tool.execute(
      validation.ok ? validation.value : undefined,
      { runId, sessionId: `architect:${runId}`, actor: { role: "architect", id: "architect_1" } },
    );
  };
  try {
    const rogueTask = {
      id: "rogue",
      objective: "Rogue objective.",
      dependencies: [],
      requiredCapabilities: [],
      acceptanceCriteria: [{ id: "ready", text: "Rogue is complete." }],
    };
    const refused = await invoke("plan_tasks", { revision: 1, tasks: [rogueTask] });
    assert.equal(refused.isError, true);
    assert.equal(refused.error?.code, "plan_not_ready");
    assert.deepEqual(Object.keys(projectionOf(store, runId).tasks), []);

    const reconciled = await invoke("reconcile_plan", {
      revision: 1,
      summary: "Add rogue.",
      taskUpdates: [],
      newTasks: [rogueTask],
    });
    assert.equal(reconciled.isError, true);
    assert.equal(reconciled.error?.code, "plan_not_ready");

    const revised = await invoke("revise_task", {
      taskId: "rogue",
      revision: 2,
      objective: "Revised rogue.",
    });
    assert.equal(revised.isError, true);
    assert.equal(revised.error?.code, "plan_not_ready");

    // Once the ready plan exists the same plan_tasks call succeeds, and the
    // created task is stamped with the ready plan identity.
    seedReadyPlan(store, runId, fixture);
    const created = await invoke("plan_tasks", { revision: 1, tasks: [rogueTask] });
    assert.equal(created.isError, false, JSON.stringify(created.error));
    assert.deepEqual(Object.keys(projectionOf(store, runId).tasks), ["rogue"]);
    const ready = readyPlanIdentity(projectionOf(store, runId))!;
    assert.deepEqual(projectionOf(store, runId).readyPlanTaskBindings, {
      rogue: { revisionId: ready.revisionId, digest: ready.digest },
    });
  } finally {
    store.close();
  }
});

test("T3a repair B1: reducer refuses task-adding and task-revising events before readiness", () => {
  const fixture = scopedFixture();
  const store = new MemorySchedulerStore();
  try {
    const runId = "run_t3a_b1_direct";
    seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
    const rogueNewTask = {
      id: "rogue",
      objective: "Rogue objective.",
      dependencies: [],
      requiredCapabilities: [],
      acceptanceCriteria: [{ id: "ready", text: "Rogue is complete." }],
    };
    assert.throws(
      () => store.append({
        runId,
        type: "plan.created",
        occurredAt: CLOCK,
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "plan:1",
        payload: { revision: 1, tasks: [planTask("rogue")] },
      }),
      /require a ready plan revision/,
    );
    assert.throws(
      () => store.append({
        runId,
        type: "plan.reconciled",
        occurredAt: CLOCK,
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "plan:reconcile-1",
        payload: { revision: 1, summary: "Add rogue.", taskUpdates: [], newTasks: [rogueNewTask] },
      }),
      /requires a ready plan revision/,
    );
    assert.throws(
      () => store.append({
        runId,
        type: "task.revised",
        occurredAt: CLOCK,
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "task-revision:2:rogue",
        payload: { taskId: "rogue", revision: 2, patch: { objective: "Revised rogue." } },
      }),
      /requires a ready plan revision/,
    );
    assert.deepEqual(Object.keys(projectionOf(store, runId).tasks), []);

    // Ready: create, then reconcile-add, then revise all append.
    seedReadyPlan(store, runId, fixture);
    store.append({
      runId,
      type: "plan.created",
      occurredAt: CLOCK,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:1",
      payload: { revision: 1, tasks: [planTask("a")] },
    });
    store.append({
      runId,
      type: "plan.reconciled",
      occurredAt: CLOCK,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:reconcile-2",
      payload: {
        revision: 2,
        summary: "Add b.",
        taskUpdates: [],
        newTasks: [{ ...rogueNewTask, id: "b", objective: "Objective b." }],
      },
    });
    store.append({
      runId,
      type: "task.revised",
      occurredAt: CLOCK,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "task-revision:3:b",
      payload: { taskId: "b", revision: 3, patch: { objective: "Revised b." } },
    });
    assert.deepEqual(Object.keys(projectionOf(store, runId).tasks).sort(), ["a", "b"]);

    // Legacy runs are untouched: the same events append with no ready plan.
    const legacyRun = "run_t3a_b1_direct_legacy";
    store.append({
      runId: legacyRun,
      type: "run.policy_configured",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "run-policy-configured",
      payload: { runPolicy: "finish" },
    });
    store.append({
      runId: legacyRun,
      type: "plan.created",
      occurredAt: CLOCK,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:1",
      payload: { revision: 1, tasks: [planTask("a")] },
    });
    store.append({
      runId: legacyRun,
      type: "plan.reconciled",
      occurredAt: CLOCK,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:reconcile-2",
      payload: {
        revision: 2,
        summary: "Add b.",
        taskUpdates: [],
        newTasks: [{ ...rogueNewTask, id: "b", objective: "Objective b." }],
      },
    });
    store.append({
      runId: legacyRun,
      type: "task.revised",
      occurredAt: CLOCK,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "task-revision:3:b",
      payload: { taskId: "b", revision: 3, patch: { objective: "Revised b." } },
    });
    assert.deepEqual(Object.keys(projectionOf(store, legacyRun).tasks).sort(), ["a", "b"]);
    assert.equal(projectionOf(store, legacyRun).readyPlanTaskBindings, undefined);
  } finally {
    store.close();
  }
});

test("T3a repair B1: planning-state turns hide legacy plan tools; forged invokes fail", async () => {
  const store = new MemorySchedulerStore();
  try {
    const hidden = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
      planningTools: {},
      planningState: true,
    });
    const names = hidden.map((tool) => tool.definition.name);
    for (const name of ["plan_tasks", "reconcile_plan", "revise_task"]) {
      assert.equal(names.includes(name), false, `${name} is hidden in planning state`);
    }
    for (const name of PLANNING_TOOL_NAMES) {
      assert.equal(names.includes(name), true, `${name} is still offered`);
    }
    for (const name of ["complete_run", "request_integration", "review_task"]) {
      assert.equal(names.includes(name), true, `required tool ${name} is still offered`);
    }

    // A forged invoke of a hidden tool is refused: it is not registered.
    const registry = new ToolRegistry();
    for (const tool of hidden) registry.register(tool);
    const forged = await registry.invoke(
      { type: "tool_call", callId: "forged-1", name: "plan_tasks", arguments: { revision: 1, tasks: [] } },
      { runId: "run_t3a_b1_hidden", sessionId: "architect:run_t3a_b1_hidden", actor: { role: "architect", id: "architect_1" } },
    );
    assert.equal(forged.isError, true);
    assert.equal(forged.error?.code, "unknown_tool");

    // Outside planning state the same registration offers all three.
    const offered = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
      planningTools: {},
    });
    const offeredNames = offered.map((tool) => tool.definition.name);
    for (const name of ["plan_tasks", "reconcile_plan", "revise_task"]) {
      assert.equal(offeredNames.includes(name), true, `${name} is offered outside planning state`);
    }
  } finally {
    store.close();
  }
});

test("T3a repair B1: no task outside the ready plan is ever dispatched", async () => {
  const fixture = scopedFixture();
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_b1_repro";
  seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
  try {
    // The reviewer's reproduction: plan_tasks before the ledger is refused,
    // so no `rogue` task exists when the ready plan later arrives.
    const architectTools = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
    });
    const planTasks = architectTools.find((tool) => tool.definition.name === "plan_tasks");
    assert.ok(planTasks, "plan_tasks is registered");
    const planValidation = planTasks.validate({
      revision: 1,
      tasks: [{
        id: "rogue",
        objective: "Rogue objective.",
        dependencies: [],
        requiredCapabilities: [],
        acceptanceCriteria: [{ id: "ready", text: "Rogue is complete." }],
      }],
    });
    assert.equal(planValidation.ok, true);
    const rogueAttempt = await planTasks.execute(
      planValidation.ok ? planValidation.value : undefined,
      { runId, sessionId: `architect:${runId}`, actor: { role: "architect", id: "architect_1" } },
    );
    assert.equal(rogueAttempt.isError, true);
    assert.equal(rogueAttempt.error?.code, "plan_not_ready");
    assert.equal(projectionOf(store, runId).planning!.ledger, undefined);
    assert.deepEqual(Object.keys(projectionOf(store, runId).tasks), []);

    // The planning flow then runs normally: ledger -> draft -> coverage -> ready.
    const planningTools = createPlanningTools({ store, clock });
    const persisted = await invokePlanningTool(planningTools, "persist_planning_ledger", {
      id: "ledger-1",
      requirements: fixture.requirements,
      phases: fixture.phases,
    }, runId);
    assert.equal(persisted.isError, false);
    const drafted = await invokePlanningTool(planningTools, "draft_planning_plan", {
      revision: withoutDigest(fixture.revision),
    }, runId);
    assert.equal(drafted.isError, false);
    store.append({
      runId,
      type: "planning.coverage_review_recorded",
      occurredAt: CLOCK,
      actor: { role: "verifier", id: "reviewer" },
      idempotencyKey: "coverage:1",
      payload: { review: fixture.coverageReview },
    });
    store.append({
      runId,
      type: "planning.plan_ready",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "runner" },
      idempotencyKey: "ready:1",
      payload: { hostCapabilities: fixture.hostCapabilities },
    });
    const r1 = readyPlanIdentity(projectionOf(store, runId))!;
    assert.ok(r1);

    // Tasks created under the ready plan dispatch; `rogue` was never created.
    // Only "a" dispatches (concurrency 1), so "b" stays planned: the stale
    // tick-skip below is sharp only for a planned task (failed tasks never
    // retry through the tick).
    seedLegacyPlan(store, runId, [planTask("a"), planTask("b")]);
    const driver = new DeferredDriver();
    const scheduler = new TaskScheduler({
      runId,
      store,
      driver: driver as WorkerRuntimeDriver,
      maxConcurrency: 1,
      workspaceFor: async (task, attempt) => `C:/work/${task.id}/${attempt}`,
      clock,
    });
    await scheduler.tick();
    assert.deepEqual(driver.assignments, ["a"]);
    assert.equal(driver.assignments.includes("rogue"), false);
    assert.equal(projectionOf(store, runId).tasks.b.status, "planned");
    driver.resolve("a", { type: "failed", reason: "fixture_failure" });
    await waitFor(() => projectionOf(store, runId).tasks.a.status === "failed");
    await scheduler.awaitIdle();

    // Both ready-bound tasks dispatch; nothing outside the ready plan
    // does. (Repair cycle 2: the old R1→R2 stranding assertions lived here;
    // re-readiness now rebinds tasks — see the T3a repair B2 test below.)
    await scheduler.tick();
    assert.deepEqual(driver.assignments, ["a", "b"]);
    assert.equal(driver.assignments.includes("rogue"), false);
    driver.resolve("b", { type: "failed", reason: "fixture_failure" });
    await waitFor(() => projectionOf(store, runId).tasks.b.status === "failed");
    await scheduler.awaitIdle();

    // A task added later by reconciliation is bound to the ready plan and
    // dispatches normally.
    store.append({
      runId,
      type: "plan.reconciled",
      occurredAt: CLOCK,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:reconcile-2",
      payload: {
        revision: 2,
        summary: "Add c under the ready plan.",
        taskUpdates: [],
        newTasks: [{
          id: "c",
          objective: "Objective c.",
          dependencies: [],
          requiredCapabilities: [],
          acceptanceCriteria: [{ id: "ready", text: "Task c is complete." }],
        }],
      },
    });
    await scheduler.tick();
    assert.deepEqual(driver.assignments, ["a", "b", "c"]);
    assert.equal(projectionOf(store, runId).tasks.b.status, "failed");
    driver.resolve("c", { type: "failed", reason: "fixture_failure" });
    await scheduler.awaitIdle();
  } finally {
    store.close();
  }
});

test("T3a repair N3: a source change during workspace allocation cannot dispatch", async () => {
  const fixture = scopedFixture();
  // The running arm comes first: an already-running task dispatches with no
  // reducer transition, so the tick re-check is its sole enforcement.
  for (const label of ["running", "assigned", "planned"] as const) {
    const store = new MemorySchedulerStore();
    const runId = `run_t3a_n3_${label}`;
    seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
    seedReadyPlan(store, runId, fixture);
    seedLegacyPlan(store, runId, [planTask("a"), planTask("b")]);
    if (label === "running" || label === "assigned") {
      // First-loop arms: task a is already assigned/running without a
      // workspace path, so the tick allocates for it in that loop.
      store.append({
        runId,
        type: "task.transitioned",
        occurredAt: CLOCK,
        actor: { role: "runner", id: "scheduler" },
        idempotencyKey: "direct:assign-a",
        payload: {
          taskId: "a",
          status: "assigned",
          patch: { attempt: 1, assignedWorkerId: "worker_a_1" },
        },
      });
    }
    if (label === "running") {
      store.append({
        runId,
        type: "task.transitioned",
        occurredAt: CLOCK,
        actor: { role: "runner", id: "scheduler" },
        idempotencyKey: "direct:run-a",
        payload: { taskId: "a", status: "running", patch: {} },
      });
    }
    try {
      const driver = new DeferredDriver();
      let amended = false;
      const scheduler = new TaskScheduler({
        runId,
        store,
        driver: driver as WorkerRuntimeDriver,
        maxConcurrency: 2,
        workspaceFor: async (task, attempt) => {
          // A source amendment lands while the first allocation is in flight.
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (!amended) {
            amended = true;
            appendSourceAmendment(store, runId, "source:amend-n3", "s9");
          }
          return `C:/work/${task.id}/${attempt}`;
        },
        clock,
      });
      // Must resolve cleanly: the re-check skips the task instead of letting
      // the reducer throw out of tick(). Assertions come before awaitIdle so
      // a disabled guard fails fast instead of hanging on a dispatched worker.
      await scheduler.tick();
      assert.equal(amended, true, label);
      assert.equal(projectionOf(store, runId).planning!.readiness, "not_ready", label);
      assert.deepEqual(driver.assignments, [], label);
      assert.equal(
        projectionOf(store, runId).tasks.a.status,
        label === "planned" ? "planned" : label,
        label,
      );
      assert.equal(projectionOf(store, runId).tasks.b.status, "planned", label);
      await scheduler.awaitIdle();
    } finally {
      store.close();
    }
  }
});

test("T3a repair N4: command refusal is evaluated on every invoke", async () => {
  const fixture = scopedFixture();
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_n4";
  seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
  seedReadyPlan(store, runId, fixture);
  assert.equal(isPlanningState(projectionOf(store, runId)), false);
  try {
    const inner = new ToolRegistry();
    let commandInvokes = 0;
    inner.register({
      definition: {
        name: "run_evidence_command",
        description: "Probe command tool.",
        inputSchema: { type: "object", additionalProperties: false },
        readOnly: false,
        effect: "none",
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => {
        commandInvokes += 1;
        return { content: [{ type: "text", text: "ok" }], isError: false };
      },
    });
    const guard = new PlanningStateCommandGuard(inner, () => projectionOf(store, runId));
    // Ready: the command passes through.
    const allowed = await guard.invoke(
      { type: "tool_call", callId: "cmd-1", name: "run_evidence_command", arguments: {} },
      { runId, sessionId: `architect:${runId}`, actor: { role: "architect", id: "architect_1" } },
    );
    assert.equal(allowed.isError, false);
    assert.equal(commandInvokes, 1);
    // Readiness lost mid-turn: the same guard refuses from that point on,
    // while the tool stays listed.
    appendSourceAmendment(store, runId, "source:amend-n4", "s9");
    assert.equal(isPlanningState(projectionOf(store, runId)), true);
    assert.equal(
      guard.definitions().some((definition) => definition.name === "run_evidence_command"),
      true,
    );
    const refused = await guard.invoke(
      { type: "tool_call", callId: "cmd-2", name: "run_evidence_command", arguments: {} },
      { runId, sessionId: `architect:${runId}`, actor: { role: "architect", id: "architect_1" } },
    );
    assert.equal(refused.isError, true);
    assert.equal(refused.error?.code, "planning_state_command_refused");
    assert.equal(commandInvokes, 1);
  } finally {
    store.close();
  }
});

test("T3a repair B2: re-readiness rebinds tasks so they dispatch again (probe B)", async () => {
  const fixture = scopedFixture();
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_b2_rebind";
  seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
  try {
    const planningTools = createPlanningTools({ store, clock });
    const persisted = await invokePlanningTool(planningTools, "persist_planning_ledger", {
      id: "ledger-1",
      requirements: fixture.requirements,
      phases: fixture.phases,
    }, runId);
    assert.equal(persisted.isError, false);
    const drafted = await invokePlanningTool(planningTools, "draft_planning_plan", {
      revision: withoutDigest(fixture.revision),
    }, runId);
    assert.equal(drafted.isError, false);
    store.append({
      runId,
      type: "planning.coverage_review_recorded",
      occurredAt: CLOCK,
      actor: { role: "verifier", id: "reviewer" },
      idempotencyKey: "coverage:1",
      payload: { review: fixture.coverageReview },
    });
    store.append({
      runId,
      type: "planning.plan_ready",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "runner" },
      idempotencyKey: "ready:1",
      payload: { hostCapabilities: fixture.hostCapabilities },
    });
    const r1 = readyPlanIdentity(projectionOf(store, runId))!;
    assert.ok(r1);

    // Ready R1 → tasks exist, bound to R1.
    seedLegacyPlan(store, runId, [planTask("a"), planTask("b")]);
    assert.deepEqual(
      projectionOf(store, runId).readyPlanTaskBindings?.a,
      { revisionId: r1.revisionId, digest: r1.digest },
    );

    // A plan revision supersedes R1; admission closes until re-readiness.
    const r1plan = projectionOf(store, runId).planning!.plan!;
    const revised = await invokePlanningTool(planningTools, "revise_planning_plan", {
      revision: { ...withoutDigest(fixture.revision), revisionId: "revision_2" },
      expectedRevisionId: r1plan.currentRevisionId,
      expectedDigest: r1plan.currentDigest,
    }, runId);
    assert.equal(revised.isError, false);
    assert.equal(projectionOf(store, runId).planning!.readiness, "not_ready");

    // Re-ready as R2 through a second T3b stand-in review bound to it.
    const r2plan = projectionOf(store, runId).planning!.plan!;
    store.append({
      runId,
      type: "planning.coverage_review_recorded",
      occurredAt: CLOCK,
      actor: { role: "verifier", id: "reviewer" },
      idempotencyKey: "coverage:2",
      payload: {
        review: {
          ...fixture.coverageReview,
          id: "coverage_2",
          planRevisionId: r2plan.currentRevisionId,
          planRevisionDigest: r2plan.currentDigest,
        },
      },
    });
    store.append({
      runId,
      type: "planning.plan_ready",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "runner" },
      idempotencyKey: "ready:2",
      payload: { hostCapabilities: fixture.hostCapabilities },
    });
    assert.equal(projectionOf(store, runId).planning!.readiness, "ready");
    const r2 = readyPlanIdentity(projectionOf(store, runId))!;
    assert.notEqual(r2.revisionId, r1.revisionId);

    // THE B2 ASSERTION: non-terminal tasks are rebound to R2, so admission
    // works again (EP23: blocked only "until re-readiness").
    const bindings = projectionOf(store, runId).readyPlanTaskBindings!;
    assert.deepEqual(bindings.a, { revisionId: r2.revisionId, digest: r2.digest });
    assert.deepEqual(bindings.b, { revisionId: r2.revisionId, digest: r2.digest });

    // Direct admission succeeds again after the rebind.
    store.append({
      runId,
      type: "task.transitioned",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "direct:rebound",
      payload: {
        taskId: "a",
        status: "assigned",
        patch: { attempt: 1, assignedWorkerId: "worker_a_1", workspacePath: "C:/work/a" },
      },
    });
    assert.equal(projectionOf(store, runId).tasks.a.status, "assigned");

    // And the tick dispatches both tasks again.
    const driver = new DeferredDriver();
    const scheduler = new TaskScheduler({
      runId,
      store,
      driver: driver as WorkerRuntimeDriver,
      maxConcurrency: 2,
      workspaceFor: async (task, attempt) => `C:/work/${task.id}/${attempt}`,
      clock,
    });
    await scheduler.tick();
    assert.deepEqual(driver.assignments, ["a", "b"]);
    driver.resolve("a", { type: "failed", reason: "fixture_failure" });
    driver.resolve("b", { type: "failed", reason: "fixture_failure" });
    await scheduler.awaitIdle();

    // Replay-safe: an incremental reduce of the log derives identical bindings.
    let incremental: SchedulerProjection | undefined;
    for (const event of store.readRun(runId)) {
      incremental = reduceSchedulerEvent(incremental, event);
    }
    assert.deepEqual(incremental!.readyPlanTaskBindings, bindings);
  } finally {
    store.close();
  }
});

test("T3a repair B2: a stale-only state wakes the Architect instead of idling (probe D)", async () => {
  const fixture = scopedFixture();
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_b2_wake";
  seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
  seedReadyPlan(store, runId, fixture);
  seedLegacyPlan(store, runId, [planTask("a")]);
  // Readiness lost with a task pending: nothing is admissible (stale-only).
  appendSourceAmendment(store, runId, "source:amend-b2wake", "s9");
  try {
    assert.equal(projectionOf(store, runId).planning!.readiness, "not_ready");
    assert.equal(newPolicyStaleTasksRequireArchitect(projectionOf(store, runId)), true);
    const architectReasons: string[] = [];
    const runtime = new BuildRuntime({
      runId,
      runPolicy: "finish",
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: {
        run: async (request) => {
          architectReasons.push(request.reason.type);
          // Stand-in typed action (the harness requires the sequence to
          // advance): the Architect asks how to reconcile the stale work.
          store.append({
            runId,
            type: "architect.question_requested",
            occurredAt: CLOCK,
            actor: { role: "architect", id: "architect_1" },
            idempotencyKey: "question:stale-wake",
            payload: {
              questionId: "q-stale",
              question: "How should the stale tasks be reconciled?",
              version: 1,
              decisionKind: undefined,
              checkpoint: undefined,
            },
          });
        },
      },
      integrationDriver: {
        integrate: async () => {
          throw new Error("no integration in this test");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async (task) => `C:/work/${task.id}`,
      clock,
    });
    const result = await runtime.step();
    assert.deepEqual(architectReasons, ["plan_required"]);
    assert.equal(result.status, "progressed");
    assert.equal(result.action, "plan_required");
  } finally {
    store.close();
  }
});

test("T3a repair B2: the stale-task predicate only fires when pending work is fully blocked", () => {
  const fixture = scopedFixture();
  const store = new MemorySchedulerStore();
  try {
    // Ready with a bound planned task: work can proceed.
    const readyRun = "run_t3a_stale_ready";
    seedNewPolicySource(store, readyRun, fixture.manifest, { priorManifest: fixture.priorManifest });
    seedReadyPlan(store, readyRun, fixture);
    seedLegacyPlan(store, readyRun, [planTask("a")]);
    assert.equal(newPolicyStaleTasksRequireArchitect(projectionOf(store, readyRun)), false);
    // Readiness lost: the same pending task is now fully blocked.
    appendSourceAmendment(store, readyRun, "source:amend-stale", "s9");
    assert.equal(newPolicyStaleTasksRequireArchitect(projectionOf(store, readyRun)), true);

    // Legacy runs are never stalled.
    const legacyRun = "run_t3a_stale_legacy";
    store.append({
      runId: legacyRun,
      type: "run.policy_configured",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "run-policy-configured",
      payload: { runPolicy: "finish" },
    });
    seedLegacyPlan(store, legacyRun, [planTask("a")]);
    assert.equal(newPolicyStaleTasksRequireArchitect(projectionOf(store, legacyRun)), false);

    // No tasks, or nothing pending: nothing to wake for.
    const emptyRun = "run_t3a_stale_empty";
    seedNewPolicySource(store, emptyRun, fixture.manifest, { priorManifest: fixture.priorManifest });
    seedReadyPlan(store, emptyRun, fixture);
    assert.equal(newPolicyStaleTasksRequireArchitect(projectionOf(store, emptyRun)), false);
    const terminalRun = "run_t3a_stale_terminal";
    seedNewPolicySource(store, terminalRun, fixture.manifest, { priorManifest: fixture.priorManifest });
    seedReadyPlan(store, terminalRun, fixture);
    seedLegacyPlan(store, terminalRun, [{ ...planTask("a"), status: "integrated", attempt: 1 }]);
    assert.equal(newPolicyStaleTasksRequireArchitect(projectionOf(store, terminalRun)), false);

    // The kernel final-verification task is never worker-dispatched, so a
    // run with only it pending is not stalled — even though the task
    // itself is admission-blocked (unbound), which makes this sharp.
    const fvRun = "run_t3a_stale_fv";
    seedNewPolicySource(store, fvRun, fixture.manifest, { priorManifest: fixture.priorManifest });
    seedReadyPlan(store, fvRun, fixture);
    seedLegacyPlan(store, fvRun, [{ ...planTask("implementation-one"), status: "integrated", attempt: 1 }]);
    const revision = "a".repeat(40);
    store.append({
      runId: fvRun,
      type: "integration.revision_advanced",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "integration" },
      idempotencyKey: "integration:1",
      payload: { integrationRevision: revision },
    });
    store.append({
      runId: fvRun,
      type: "final_verification.generation_created",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "runtime" },
      idempotencyKey: "generation:1",
      payload: {
        taskId: "final-verification",
        generationId: "final-generation",
        targetRevision: revision,
        planVersion: 1,
        plan: finalVerificationPlanAllSkipped(),
        executionProfile: emptyFinalVerificationProfile(revision),
      },
    });
    const fvProjection = projectionOf(store, fvRun);
    assert.notEqual(
      newPolicyTaskAdmissionBlocked(fvProjection, "final-verification"),
      undefined,
    );
    assert.equal(newPolicyStaleTasksRequireArchitect(fvProjection), false);
  } finally {
    store.close();
  }
});

/** Final-verification plan with every category legitimately skipped (mirrors the FV fixtures). */
function finalVerificationPlanAllSkipped() {
  return {
    checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({
      category,
      status: "not_applicable" as const,
      rationale: `No ${category} fixture is configured.`,
      repositoryInspection: {
        paths: ["package.json"],
        summary: `No ${category} fixture is configured.`,
      },
    })),
  };
}

/** Seeds a green final-verification generation through review_requested (mirrors the FV fixtures). */
function seedGreenFinalVerification(
  store: SchedulerStore,
  runId: string,
  input: {
    taskId: string;
    generationId: string;
    targetRevision: string;
    submissionId: string;
    reviewId: string;
  },
): { plan: ReturnType<typeof finalVerificationPlanAllSkipped> } {
  const plan = finalVerificationPlanAllSkipped();
  const runner = { role: "runner" as const, id: "runtime" };
  store.append({
    runId,
    type: "final_verification.generation_created",
    occurredAt: CLOCK,
    actor: runner,
    idempotencyKey: "generation:1",
    payload: {
      taskId: input.taskId,
      generationId: input.generationId,
      targetRevision: input.targetRevision,
      planVersion: 1,
      plan,
      executionProfile: emptyFinalVerificationProfile(input.targetRevision),
    },
  });
  for (const check of plan.checks) {
    store.append({
      runId,
      type: "final_verification.check_completed",
      occurredAt: CLOCK,
      actor: runner,
      idempotencyKey: `check:${check.category}`,
      payload: {
        taskId: input.taskId,
        generationId: input.generationId,
        targetRevision: input.targetRevision,
        attempt: 1,
        workspacePath: "C:/verify",
        startedAt: CLOCK,
        finishedAt: CLOCK,
        result: { ...check, green: true, evidenceIds: [], facts: [], issues: [] },
      },
    });
  }
  store.append({
    runId,
    type: "final_verification.submitted",
    occurredAt: CLOCK,
    actor: runner,
    idempotencyKey: "submission:1",
    payload: {
      taskId: input.taskId,
      generationId: input.generationId,
      targetRevision: input.targetRevision,
      attempt: 1,
      submissionId: input.submissionId,
      submissionResult: {
        kind: "final_verification_submission",
        generationId: input.generationId,
        runId,
        taskId: input.taskId,
        attempt: 1,
        targetRevision: input.targetRevision,
        plan,
        executionProfile: emptyFinalVerificationProfile(input.targetRevision),
        checks: plan.checks.map((check) => ({ ...check, green: true, evidenceIds: [], facts: [] })),
        evidenceIds: [],
        submittedAt: CLOCK,
        green: true,
      },
    },
  });
  store.append({
    runId,
    type: "final_verification.cleanup_started",
    occurredAt: CLOCK,
    actor: runner,
    idempotencyKey: "cleanup:start",
    payload: {
      taskId: input.taskId,
      generationId: input.generationId,
      targetRevision: input.targetRevision,
      attempt: 1,
    },
  });
  store.append({
    runId,
    type: "final_verification.cleanup_succeeded",
    occurredAt: CLOCK,
    actor: runner,
    idempotencyKey: "cleanup:done",
    payload: {
      taskId: input.taskId,
      generationId: input.generationId,
      targetRevision: input.targetRevision,
      attempt: 1,
    },
  });
  store.append({
    runId,
    type: "final_verification.review_requested",
    occurredAt: CLOCK,
    actor: runner,
    idempotencyKey: "review:request",
    payload: {
      taskId: input.taskId,
      generationId: input.generationId,
      targetRevision: input.targetRevision,
      attempt: 1,
      submissionId: input.submissionId,
      reviewId: input.reviewId,
    },
  });
  return { plan };
}

test("T3a repair B3: verifier repair tasks are bound to the ready plan and dispatched by tick", async () => {
  const fixture = scopedFixture();
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_b3_verifier";
  seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
  seedReadyPlan(store, runId, fixture);
  try {
    // Integrated implementation plan (mirrors the verifier fixture) under
    // the ready plan, then the canonical revision and a green approved
    // final verification (the verifier lifecycle prerequisite).
    store.append({
      runId,
      type: "plan.created",
      occurredAt: CLOCK,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:1",
      payload: {
        revision: 1,
        tasks: [
          {
            id: "task-api",
            objective: "Implement the API",
            dependencies: [],
            status: "integrated",
            requiredCapabilities: ["code"],
            acceptanceCriteria: [
              { id: "shared", text: "The API meets its user-visible behavior." },
              { id: "typed", text: "The API rejects malformed input." },
            ],
            acceptanceCriteriaVersion: 1,
            attempt: 1,
          },
          {
            id: "task-ui",
            objective: "Implement the UI",
            dependencies: ["task-api"],
            status: "integrated",
            requiredCapabilities: ["code"],
            acceptanceCriteria: [
              { id: "shared", text: "The UI exposes the requested workflow." },
            ],
            acceptanceCriteriaVersion: 1,
            attempt: 1,
          },
        ],
      },
    });
    store.append({
      runId,
      type: "integration.revision_advanced",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "integration" },
      idempotencyKey: "integration:1",
      payload: { integrationRevision: VERIFIER_REVISION },
    });
    const { plan } = seedGreenFinalVerification(store, runId, {
      taskId: "final-verification",
      generationId: "final-generation",
      targetRevision: VERIFIER_REVISION,
      submissionId: "final-submission",
      reviewId: "final-review",
    });
    store.append({
      runId,
      type: "final_verification.review_decided",
      occurredAt: CLOCK,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "review:decision",
      payload: {
        taskId: "final-verification",
        generationId: "final-generation",
        targetRevision: VERIFIER_REVISION,
        attempt: 1,
        submissionId: "final-submission",
        reviewId: "final-review",
        decision: "approved",
        summary: "Every final-verification category is approved.",
        categoryReviews: plan.checks.map((check) => ({
          category: check.category,
          verdict: "approved",
          rationale: `${check.category} is current and green.`,
          evidenceIds: [],
        })),
      },
    });

    // The independent verifier reviews and returns an unsatisfied verdict.
    store.append({
      runId,
      type: "verifier.review_requested",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "native-verifier-runtime" },
      idempotencyKey: "verifier:request",
      payload: { ...verifierRequestPayload() },
    });
    store.append({
      runId,
      type: "verifier.verdict_submitted",
      occurredAt: CLOCK,
      actor: { role: "verifier", id: "google:verifier" },
      idempotencyKey: "verifier:verdict",
      payload: {
        reviewId: VERIFIER_REVIEW_ID,
        targetRevision: VERIFIER_REVISION,
        sessionId: VERIFIER_SESSION_ID,
        criterionVerdicts: VERIFIER_CRITERIA.map((criterion, index) => ({
          ...criterion,
          verdict: index === 0 ? "unsatisfied" : "satisfied",
          rationale: index === 0
            ? "The API behavior is incomplete."
            : `Criterion ${index + 1} is satisfied.`,
          evidenceIds: [`evidence-${index + 1}`],
        })),
      },
    });

    // The Architect plans repairs; the repair task must be stamped with
    // the ready identity so the tick actually dispatches it.
    assert.equal(projectionOf(store, runId).planRevision, 1);
    store.append({
      runId,
      type: "verifier.repairs_planned",
      occurredAt: CLOCK,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "repair:verifier",
      payload: {
        reviewId: VERIFIER_REVIEW_ID,
        targetRevision: VERIFIER_REVISION,
        revision: 2,
        tasks: [{
          id: "repair-api",
          objective: "Repair the rejected API behavior.",
          criteria: [{ taskId: "task-api", criterionId: "shared" }],
          evidenceIds: ["evidence-1"],
          dependencies: [],
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{
            id: "repair-api",
            text: "The rejected API behavior is repaired.",
          }],
        }],
      },
    });
    const projection = projectionOf(store, runId);
    assert.equal(projection.tasks["repair-api"]?.status, "planned");
    const ready = readyPlanIdentity(projection)!;
    assert.ok(ready);
    assert.deepEqual(
      projection.readyPlanTaskBindings?.["repair-api"],
      { revisionId: ready.revisionId, digest: ready.digest },
    );
    const driver = new DeferredDriver();
    const scheduler = new TaskScheduler({
      runId,
      store,
      driver: driver as WorkerRuntimeDriver,
      maxConcurrency: 2,
      workspaceFor: async (task, attempt) => `C:/work/${task.id}/${attempt}`,
      clock,
    });
    await scheduler.tick();
    assert.deepEqual(driver.assignments, ["repair-api"]);
    driver.resolve("repair-api", { type: "failed", reason: "fixture_failure" });
    await scheduler.awaitIdle();
  } finally {
    store.close();
  }
});

test("T3a repair B3: final-verification repair tasks are bound to the ready plan and dispatched by tick", async () => {
  const fixture = scopedFixture();
  const store = new MemorySchedulerStore();
  const runId = "run_t3a_b3_fv";
  seedNewPolicySource(store, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
  seedReadyPlan(store, runId, fixture);
  try {
    const targetRevision = "a".repeat(40);
    store.append({
      runId,
      type: "plan.created",
      occurredAt: CLOCK,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:1",
      payload: {
        revision: 1,
        tasks: [{
          id: "implementation-one",
          objective: "Implement feature",
          dependencies: [],
          status: "integrated",
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "done", text: "Feature implemented." }],
          acceptanceCriteriaVersion: 1,
          attempt: 1,
        }],
      },
    });
    store.append({
      runId,
      type: "integration.revision_advanced",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "integration" },
      idempotencyKey: "integration:1",
      payload: { integrationRevision: targetRevision },
    });
    const { plan } = seedGreenFinalVerification(store, runId, {
      taskId: "final-verification",
      generationId: "final-generation",
      targetRevision,
      submissionId: "final-submission",
      reviewId: "final-review",
    });
    // Semantic failure: the review requires repairs in two categories.
    const failed = ["tests", "browser"];
    store.append({
      runId,
      type: "final_verification.review_decided",
      occurredAt: CLOCK,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "review:decision",
      payload: {
        taskId: "final-verification",
        generationId: "final-generation",
        targetRevision,
        attempt: 1,
        submissionId: "final-submission",
        reviewId: "final-review",
        decision: "repair_required",
        summary: "Tests and browser behavior need targeted repairs.",
        categoryReviews: plan.checks.map((check) => ({
          category: check.category,
          verdict: failed.includes(check.category) ? "repair_required" : "approved",
          rationale: `Persisted ${check.category} facts were semantically reviewed.`,
          evidenceIds: [],
        })),
      },
    });

    // The Architect plans repairs; both repair tasks must be stamped with
    // the ready identity so the tick actually dispatches them.
    assert.equal(projectionOf(store, runId).planRevision, 1);
    store.append({
      runId,
      type: "final_verification.repairs_planned",
      occurredAt: CLOCK,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "repair:fv",
      payload: {
        finalVerificationTaskId: "final-verification",
        generationId: "final-generation",
        targetRevision,
        revision: 2,
        source: {
          type: "semantic_review",
          submissionId: "final-submission",
          reviewId: "final-review",
        },
        tasks: [
          {
            id: "repair-tests",
            objective: "Repair the test behavior identified by final verification review.",
            categories: ["tests"],
            evidenceIds: [],
            dependencies: ["implementation-one"],
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{
              id: "tests-repaired",
              text: "The reviewed tests gap is repaired and regression evidence is recorded.",
            }],
          },
          {
            id: "repair-browser",
            objective: "Repair the browser behavior identified by final verification review.",
            categories: ["browser"],
            evidenceIds: [],
            dependencies: ["implementation-one"],
            requiredCapabilities: ["browser", "code"],
            acceptanceCriteria: [{
              id: "browser-repaired",
              text: "The reviewed browser gap is repaired and browser evidence is recorded.",
            }],
          },
        ],
      },
    });
    const projection = projectionOf(store, runId);
    assert.equal(projection.tasks["repair-tests"]?.status, "planned");
    assert.equal(projection.tasks["repair-browser"]?.status, "planned");
    const ready = readyPlanIdentity(projection)!;
    assert.ok(ready);
    for (const taskId of ["repair-tests", "repair-browser"]) {
      assert.deepEqual(
        projection.readyPlanTaskBindings?.[taskId],
        { revisionId: ready.revisionId, digest: ready.digest },
      );
    }
    const driver = new DeferredDriver();
    const scheduler = new TaskScheduler({
      runId,
      store,
      driver: driver as WorkerRuntimeDriver,
      maxConcurrency: 2,
      workspaceFor: async (task, attempt) => `C:/work/${task.id}/${attempt}`,
      clock,
    });
    await scheduler.tick();
    assert.deepEqual([...driver.assignments].sort(), ["repair-browser", "repair-tests"]);
    driver.resolve("repair-tests", { type: "failed", reason: "fixture_failure" });
    driver.resolve("repair-browser", { type: "failed", reason: "fixture_failure" });
    await scheduler.awaitIdle();
  } finally {
    store.close();
  }
});

test("T3a repair N-B: mid-turn readiness loss refuses later commands through the real runtime wiring", async () => {
  const fixture = scopedFixture();
  const root = mkdtempSync(join(tmpdir(), "aiboard-t3a-nb-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
  const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
  const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
  const runId = "run-t3a-nb";
  const objective = "Build the feature.";
  const seen = { creates: 0, cleanups: 0 };
  try {
    scheduler.append({
      runId,
      type: "run.initialized",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "test" },
      idempotencyKey: "init",
      payload: { objective },
    });
    // The turn starts READY, so the command layer is composed behind the
    // per-invoke guard (not the turn-start planning-state path).
    seedNewPolicySource(scheduler, runId, fixture.manifest, { priorManifest: fixture.priorManifest });
    seedReadyPlan(scheduler, runId, fixture);
    scheduler.append({
      runId,
      type: "integration.revision_advanced",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "test" },
      idempotencyKey: "integration",
      payload: { integrationRevision: "a".repeat(40) },
    });
    assert.equal(isPlanningState(projectionOf(scheduler, runId)), false);

    // A lifecycle tool whose side effect drops readiness mid-turn.
    const tools = new ToolRegistry();
    tools.register({
      definition: {
        name: "t3a_amend_source",
        description: "Probe tool that amends the approved source.",
        inputSchema: { type: "object", additionalProperties: false },
        readOnly: false,
        effect: "none",
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => {
        appendSourceAmendment(scheduler, runId, "source:amend-nb", "s9");
        return { content: [{ type: "text", text: "amended" }], isError: false };
      },
    });
    const candidate: AgentRuntimeCandidate = {
      runtimeId: "test:architect",
      providerId: "test",
      modelId: "architect",
      capabilities: ["code"],
      priority: 1,
    };
    const health = new ProviderHealthRegistry();
    const model = new ScriptedModel([
      {
        blocks: [{
          type: "tool_call",
          callId: "amend-1",
          name: "t3a_amend_source",
          arguments: {},
        }],
        stopReason: "tool_calls",
      },
      {
        blocks: [{
          type: "tool_call",
          callId: "cmd-1",
          name: "run_evidence_command",
          arguments: { label: "cmd-1", command: "echo", args: ["hi"], cwd: "." },
        }],
        stopReason: "tool_calls",
      },
      { blocks: [], stopReason: "cancelled" },
    ]);
    const architect = new NativeArchitectRuntime({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates: [candidate], health }),
      health,
      candidates: [candidate],
      models: new Map([[candidate.runtimeId, model]]),
      initialRuntimeId: candidate.runtimeId,
      sessions,
      artifacts,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      evidenceStore: evidence,
      projectId: "project-t3a-nb",
      projectRoot: project,
      objective,
      commandWorkspace: {
        workspaceKind: "independent-verifier",
        create: async () => {
          seen.creates += 1;
          return { path: join(root, "copy") };
        },
        cleanup: async () => {
          seen.cleanups += 1;
        },
      } satisfies ArchitectCommandWorkspaceProvider,
    });
    await architect.run({
      runId,
      reason: { type: "plan_required" },
      projection: projectionOf(scheduler, runId),
      tools,
      context: {
        runId,
        sessionId: `architect:${runId}`,
        actor: { role: "architect", id: "architect" },
      },
    });

    // The amendment landed mid-turn, so the run is back in planning state.
    assert.equal(isPlanningState(projectionOf(scheduler, runId)), true);
    const amendResults = toolResults(model, 1);
    assert.equal(amendResults.length, 1);
    assert.equal(amendResults[0]!.isError, false);
    // The command tool was listed at turn start (ready) ...
    const listed = (model.requests[0]?.tools ?? []).map((tool) => tool.name);
    assert.equal(listed.includes("run_evidence_command"), true);
    // ... but the post-amendment invoke is refused through the composed
    // guard, and no disposable copy is ever created. (Request 2 carries
    // the cumulative history: the amend result plus the command refusal.)
    const results = toolResults(model, 2);
    assert.equal(results.length, 2);
    const refused = results.find((result) => result.callId === "cmd-1");
    assert.ok(refused);
    assert.equal(refused.isError, true);
    assert.equal(refused.error?.code, "planning_state_command_refused");
    assert.equal(seen.creates, 0);
  } finally {
    sessions.close();
    scheduler.close();
    evidence.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});
