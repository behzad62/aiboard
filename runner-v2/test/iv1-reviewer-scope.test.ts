import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentModel,
  AgentModelRequest,
  ModelTurn,
  NativeTool,
  ToolExecutionOutput,
} from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { loadDeliverableReviewInputs, type DurableSubmission } from "../src/delivery-execution.js";
import {
  DELIVERABLE_REVIEWER_INVARIANTS,
  deliveryReviewerSystemPrompt,
  NativeDeliverableReviewRuntime,
  type DeliverableReviewInputs,
} from "../src/native-deliverable-review.js";
import type { BuildTask } from "../src/task-contracts.js";
import type { ChangeSet } from "../src/change-set.js";
import type { ContextSection } from "../src/context-assembler.js";
import type { ExecutionTaskContract } from "../src/planning-contracts.js";
import {
  KERNEL_STAMPED_REVISION_FIELDS,
  requiredBaseForRevision,
  type PlanSubmissionRevision,
} from "../src/planning-contracts.js";
import { createPlanningTools } from "../src/planning-tools.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import {
  rebuildSchedulerProjection,
  reduceSchedulerEvent,
  resolveTaskContractReference,
  type NewSchedulerEvent,
  type SchedulerEvent,
  type SchedulerProjection,
  type SchedulerStore,
} from "../src/scheduler-store.js";
import type { AgentRuntimeCandidate } from "../src/runtime-router.js";
import { RuntimeRouter } from "../src/runtime-router.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import type { ValidationScope } from "../src/validation-scope.js";
import { claimBindingDigest, computeReviewKey } from "../src/review-key.js";
import { buildFixtureCoverageReview, buildPlanningFixtureScenario } from "./fixtures/planning-source-fixture.js";
import { seedBoundCoverageAndReady } from "./support/planning-seed.js";

/**
 * IV-1 (CD-23): the reviewer receives the durable validationScope, judges it
 * against the diff and the task validation rationales, and raises ordinary
 * blocking findings through the existing finding tool. No parallel
 * scope-verdict state machine, no kernel-invented findings.
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

function thinScope(): ValidationScope {
  return {
    changed: ["src/value.mjs", "src/dependents.mjs", "src/other.mjs"],
    verified: ["it works"],
    testsRun: [],
    notRun: [{ what: "affected tests", why: "no time" }],
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

// ---------------------------------------------------------------------------
// Review inputs: the exact durable scope rides in; tampered copies are refused.
// ---------------------------------------------------------------------------

async function iv1ReviewInputHarness<T>(
  run: (input: {
    task: BuildTask;
    changeSet: ChangeSet;
    submission: DurableSubmission;
    artifacts: ArtifactStore;
  }) => Promise<T>,
  mutate?: { taskScope?: ValidationScope | undefined; changeScope?: ValidationScope | undefined },
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-iv1-inputs-"));
  try {
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const diffText = "diff --git a/src/value.mjs b/src/value.mjs\n+export const value = 2;\n";
    const diffHash = (await artifacts.put(Buffer.from(diffText, "utf8"), "text/x-diff", "diff")).hash;
    const scope = iv1Scope();
    const changeSet = {
      id: "changeset_1",
      runId: "run_iv1_inputs",
      taskId: "T1",
      baselineRevision: "b".repeat(40),
      taskRevision: "c".repeat(40),
      commits: ["c".repeat(40)],
      changedPaths: ["src/value.mjs"],
      diffArtifactHash: diffHash,
      evidenceArtifactHashes: ["ab".repeat(32)],
      unresolvedConcerns: [],
      externalEffects: [],
      guidanceIds: [],
      memoryIds: [],
      ...(mutate && "changeScope" in mutate
        ? mutate.changeScope === undefined
          ? {}
          : { validationScope: mutate.changeScope }
        : { validationScope: scope }),
    } as unknown as ChangeSet;
    const task = {
      id: "T1",
      objective: "Export value 2.",
      dependencies: [],
      status: "submitted",
      requiredCapabilities: [],
      acceptanceCriteria: [{ id: "c1", text: "value is 2" }],
      attempt: 1,
      changeSetId: "changeset_1",
      ...(mutate && "taskScope" in mutate
        ? mutate.taskScope === undefined
          ? {}
          : { validationScope: mutate.taskScope }
        : { validationScope: scope }),
    } as unknown as BuildTask;
    const submission = {
      changeSet,
      summary: "Worker summary for T1.",
      authorRuntimeId: "author-runtime",
    } as unknown as DurableSubmission;
    return await run({ task, changeSet, submission, artifacts });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("IV-1 review inputs carry the exact durable scope", async () => {
  await iv1ReviewInputHarness(async ({ task, submission, artifacts }) => {
    const inputs = await loadDeliverableReviewInputs({ task, submission, artifacts });
    assert.deepEqual(inputs.validationScope, iv1Scope());
  });
});

test("IV-1 review inputs refuse a mismatched or tampered scope copy", async () => {
  await iv1ReviewInputHarness(
    async ({ task, submission, artifacts }) => {
      await assert.rejects(
        () => loadDeliverableReviewInputs({ task, submission, artifacts }),
        /differs from its durable kernel binding/
      );
    },
    { changeScope: { ...iv1Scope(), changed: ["src/forged.mjs"] } }
  );
  await iv1ReviewInputHarness(
    async ({ task, submission, artifacts }) => {
      await assert.rejects(
        () => loadDeliverableReviewInputs({ task, submission, artifacts }),
        /differs from its durable kernel binding/
      );
    },
    { changeScope: undefined }
  );
});

test("IV-1 review inputs without any scope stay legacy-compatible", async () => {
  await iv1ReviewInputHarness(
    async ({ task, submission, artifacts }) => {
      const inputs = await loadDeliverableReviewInputs({ task, submission, artifacts });
      assert.equal(inputs.validationScope, undefined);
    },
    { taskScope: undefined, changeScope: undefined }
  );
});

// ---------------------------------------------------------------------------
// F2: one-sided scope copies are refused in both directions.
test("IV-1 review inputs refuse one-sided scope copies in both directions", async () => {
  await iv1ReviewInputHarness(
    async ({ task, submission, artifacts }) => {
      await assert.rejects(
        () => loadDeliverableReviewInputs({ task, submission, artifacts }),
        /differs from its durable kernel binding/
      );
    },
    { taskScope: iv1Scope(), changeScope: undefined }
  );
  await iv1ReviewInputHarness(
    async ({ task, submission, artifacts }) => {
      await assert.rejects(
        () => loadDeliverableReviewInputs({ task, submission, artifacts }),
        /differs from its durable kernel binding/
      );
    },
    { taskScope: undefined, changeScope: iv1Scope() }
  );
});

// F1: the ReviewKey binds canonical validationScope semantics via claimBindingDigest.
test("IV-1 ReviewKey binds validationScope: identical reuses, changed misses", () => {
  const base = {
    objective: "Export value 2.",
    criteria: [{ id: "c1", text: "value is 2" }],
    claims: [{ id: "claim:c1", text: "Criterion c1 is satisfied.", evidenceContent: [] as string[] }],
    workerSummary: "Worker summary for T1.",
    unresolvedConcerns: [] as string[],
  };
  const adequate = iv1Scope();
  const thin = thinScope();
  assert.equal(
    claimBindingDigest({ ...base, validationScope: adequate }),
    claimBindingDigest({ ...base, validationScope: structuredClone(adequate) }),
    "identical scope reuses"
  );
  assert.notEqual(
    claimBindingDigest({ ...base, validationScope: adequate }),
    claimBindingDigest({ ...base, validationScope: thin }),
    "adequate -> thin cannot reuse a prior clean verdict"
  );
  assert.notEqual(
    claimBindingDigest(base),
    claimBindingDigest({ ...base, validationScope: adequate }),
    "scope presence invalidates legacy reuse"
  );
  assert.equal(
    claimBindingDigest(base),
    claimBindingDigest({ ...base }),
    "legacy absent scope hashes stably"
  );
});

test("IV-1 ReviewKey: changed scope changes the full key", () => {
  const base = {
    objective: "Export value 2.",
    criteria: [{ id: "c1", text: "value is 2" }],
    claims: [{ id: "claim:c1", text: "Criterion c1 is satisfied.", evidenceContent: [] as string[] }],
    workerSummary: "Worker summary for T1.",
    unresolvedConcerns: [] as string[],
  };
  const adequateDigest = claimBindingDigest({ ...base, validationScope: iv1Scope() });
  const thinDigest = claimBindingDigest({ ...base, validationScope: thinScope() });
  assert.notEqual(adequateDigest, thinDigest);
  const keyBase = {
    semanticContractDigest: "a".repeat(64),
    baseTree: "b".repeat(40),
    headTree: "c".repeat(40),
    diffDigest: "d".repeat(64),
    diffArtifactHash: "e".repeat(64),
    evidenceContentDigest: "f".repeat(64),
    claimBindingDigest: adequateDigest,
    testIntegrityDigest: "1".repeat(64),
    tier: "low",
    reviewerPolicyVersion: 2,
    authorModelIdentity: "author-model",
    policyVersions: "evidence:0|integrity:0|scope:0|encoding:0",
  };
  assert.notEqual(
    computeReviewKey(keyBase),
    computeReviewKey({ ...keyBase, claimBindingDigest: thinDigest }),
    "changed scope forces a new review"
  );
  assert.equal(
    computeReviewKey(keyBase),
    computeReviewKey({ ...keyBase, claimBindingDigest: adequateDigest }),
    "identical scope keeps the key"
  );
});

// Sections: findings and verdict see the scope plus rationales; obligations stays blind.
// ---------------------------------------------------------------------------

function iv1ReviewContract(): ExecutionTaskContract {
  return {
    id: "T1",
    lineage: [],
    accountablePhaseId: "P1",
    requirementIds: ["REQ-1"],
    outcome: { user: "Export value 2.", system: "The module exports 2." },
    scope: { includes: ["src/value.mjs"], excludes: [] },
    writableSurfaces: ["src/value.mjs"],
    forbiddenSurfaces: ["infra/**"],
    dependencies: [],
    requiredBase: "accepted plan revision revision_1",
    inputs: ["plan"],
    outputs: ["src/value.mjs"],
    steps: ["Write the module."],
    acceptance: {
      criteria: [{ id: "c1", text: "value is 2" }],
      definitionOfDone: "Tests pass.",
    },
    validation: {
      targetedRationale: "Run the value test file.",
      affectedScopeRationale: "Cover the direct dependents of the value module.",
    },
    negativeProofApplicability: { applicable: false, rationale: "New module." },
    reviewCriteria: ["Review confirms the value."],
    integrationChecks: ["Post-integration tests."],
    cleanup: { cleanup: "None.", recovery: "Retry.", rollback: "Revert." },
    requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-1" }],
  };
}

function iv1SectionsHarness(): {
  sectionsFor: (pass: "obligations" | "findings" | "verdict", scope: ValidationScope | undefined) => ContextSection[];
} {
  const runId = "run_iv1_sections";
  const store = new MemorySchedulerStore();
  store.append({
    runId,
    type: "run.policy_configured",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "run-policy-configured",
    payload: { runPolicy: "finish" },
  });
  const reviewRuntime = new NativeDeliverableReviewRuntime({
    store,
    architectRuntimeId: "architect-runtime",
    router: { selectVerifier: () => { throw new Error("unused"); } } as never,
    candidates: [],
    models: new Map(),
    reviewerRuntimeIds: ["reviewer-runtime"],
    sessions: {} as never,
    artifacts: {} as never,
    evidenceStore: {} as never,
    loadInputs: async () => { throw new Error("unused"); },
    workspace: { create: async () => ({ path: tmpdir() }), cleanup: async () => undefined },
    depth: { run: async () => { throw new Error("unused"); } },
  });
  const sectionsFor = (
    pass: "obligations" | "findings" | "verdict",
    scope: ValidationScope | undefined
  ): ContextSection[] =>
    (reviewRuntime as unknown as { sections(context: unknown, pass: string): ContextSection[] }).sections(
      {
        request: { runId },
        reviewId: "review_1",
        inputs: {
          taskId: "T1",
          attempt: 1,
          changeSetId: "changeset_1",
          baselineRevision: "b".repeat(40),
          taskRevision: "c".repeat(40),
          diffArtifactHash: "d".repeat(64),
          diffText: "diff --git a/src/value.mjs b/src/value.mjs",
          changedPaths: ["src/value.mjs"],
          objective: "Export value 2.",
          criteria: [{ id: "c1", text: "value is 2" }],
          workerSummary: "Worker summary for T1.",
          unresolvedConcerns: [],
          claims: [],
          authorRuntimeId: "author-runtime",
          contract: iv1ReviewContract(),
          contractRef: { revisionId: "revision_1", digest: "e".repeat(64), taskId: "T1" },
          ...(scope ? { validationScope: scope } : {}),
        },
        candidate: {},
        model: {},
        independence: "distinct_model",
        tier: "low",
      },
      pass
    );
  return { sectionsFor };
}

test("IV-1 findings and verdict carry the scope plus rationales; obligations stays blind", () => {
  const { sectionsFor } = iv1SectionsHarness();
  const obligations = sectionsFor("obligations", iv1Scope());
  assert.ok(!obligations.some((section) => section.id === "validation-scope"), "obligations never sees the scope");
  assert.ok(!obligations.some((section) => section.id === "submitted-diff"), "obligations precedes the diff");
  for (const pass of ["findings", "verdict"] as const) {
    const sections = sectionsFor(pass, iv1Scope());
    const scope = sections.find((section) => section.id === "validation-scope");
    assert.ok(scope, `${pass} carries the validation-scope section`);
    assert.ok(scope.content.includes("a claim, not evidence"), `${pass} labels the scope a claim`);
    assert.ok(scope.content.includes("node --test test/value.test.mjs"), `${pass} shows the exact command`);
    assert.ok(scope.content.includes("targeted and affected-scope validation rationales"), `${pass} points at the rationales`);
    const contract = sections.find((section) => section.id === "task-contract");
    assert.ok(contract, `${pass} keeps the reviewer contract block`);
    assert.ok(contract.content.includes("Targeted validation rationale: Run the value test file."), `${pass} shows targetedRationale`);
    assert.ok(
      contract.content.includes("Affected-scope validation rationale: Cover the direct dependents"),
      `${pass} shows affectedScopeRationale`
    );
  }
  const findingsIds = sectionsFor("findings", iv1Scope()).map((section) => section.id);
  assert.ok(!findingsIds.includes("worker-report"), "findings still precede the worker report");
  assert.ok(!findingsIds.includes("worker-claims"), "findings still precede worker claims");
});

// ---------------------------------------------------------------------------
// Prompt: the reviewer is told to judge scope sufficiency and raise findings.
// ---------------------------------------------------------------------------

test("IV-1 reviewer prompt judges scope sufficiency on findings and verdict, never obligations", () => {
  assert.ok(DELIVERABLE_REVIEWER_INVARIANTS.includes("independent reviewer"), "invariants intact");
  const findings = deliveryReviewerSystemPrompt("findings", "low");
  assert.ok(findings.includes("Compare the actual diff/changed paths"), "findings compares diff and scope");
  assert.ok(findings.includes("validation-scope report"), "findings names the scope report");
  assert.ok(findings.includes("changed/verified/testsRun/notRun"), "findings names every scope part");
  assert.ok(
    findings.includes("targeted and affected-scope validation rationales"),
    "findings names both rationales"
  );
  assert.ok(findings.includes("not run and notRun lacks a concrete justification"), "findings gates on justification");
  assert.ok(findings.includes("thin or generic"), "findings gates on thin rationale");
  assert.ok(
    findings.includes("record a normal blocking finding through record_deliverable_findings"),
    "findings uses the existing finding tool"
  );
  assert.ok(
    findings.includes("withheld until the verdict pass"),
    "findings keeps claims withheld"
  );
  assert.ok(!findings.includes("You have NOT seen the worker's report"), "stale line replaced");
  const verdict = deliveryReviewerSystemPrompt("verdict", "low");
  assert.ok(verdict.includes("Weigh the worker validation-scope report"), "verdict weighs the scope");
  assert.ok(verdict.includes("as a claim, not evidence"), "verdict keeps the scope a claim");
  for (const tier of ["low", "medium", "high"] as const) {
    assert.ok(
      !deliveryReviewerSystemPrompt("obligations", tier).includes("validation-scope"),
      `obligations stays blind at ${tier} tier`
    );
  }
});

// ---------------------------------------------------------------------------
// Scripted reviewer: a thin scope yields a real blocking finding through the
// existing finding tool; an adequate scope yields no fabricated finding. The
// decision is model-owned (the script stands in for the model); the kernel
// records exactly what the model returns.
// ---------------------------------------------------------------------------

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

async function invokePlanningTool(
  tools: readonly NativeTool<unknown>[],
  name: string,
  args: unknown,
  runId: string
): Promise<ToolExecutionOutput> {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  assert.ok(tool, `planning tool ${name} is registered`);
  const validation = tool.validate(args);
  assert.equal(validation.ok, true, `arguments for ${name} validate`);
  return await tool.execute(
    validation.ok ? validation.value : undefined,
    { runId, sessionId: `architect:${runId}`, actor: { role: "architect", id: "architect_1" } }
  );
}

async function iv1ReadyStore(runId: string, store: SchedulerStore): Promise<void> {
  const fixture = iv1Fixture(runId);
  store.append({
    runId,
    type: "run.initialized",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "init:iv1",
    payload: { validationScopePolicyVersion: 1 },
  });
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
  const tools = createPlanningTools({ store, clock });
  const drafted = await invokePlanningTool(
    tools,
    "draft_planning_plan",
    { revision: strippedSubmission(fixture, "revision_1") },
    runId
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
}

type Iv1ReviewPass = "obligations" | "findings" | "verdict";

const EMPTY_TESTS_RUN_PATTERN = /"testsRun"\s*:\s*\[\s*\]/;

/** Thin-scope signal: testsRun is an empty JSON array, ignoring insignificant whitespace. */
function hasEmptyTestsRun(text: string): boolean {
  return EMPTY_TESTS_RUN_PATTERN.test(text);
}

/** Stand-in model judgement: thin scopes (no run at all) get a blocking finding. */
class Iv1ScriptedReviewer implements AgentModel {
  readonly requests: Array<{ pass: Iv1ReviewPass; text: string }> = [];

  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const system = request.messages.find((message) => message.role === "system");
    const pass = (system?.id.replace("delivery-", "").replace("-system", "") ?? "findings") as Iv1ReviewPass;
    const text = request.messages
      .filter((message) => typeof message.content === "string")
      .map((message) => message.content as string)
      .join("\n");
    const toolResults = request.messages.filter((message) => message.role === "tool");
    this.requests.push({ pass, text });
    const call = (name: string, args: unknown): ModelTurn => ({
      blocks: [
        {
          type: "tool_call",
          callId: `${pass}-${name}-${this.requests.length}-${toolResults.length}`,
          name,
          arguments: args,
        },
      ],
      stopReason: "tool_calls",
    });
    if (pass === "obligations") {
      return call("record_deliverable_obligations", {
        obligations: [{ id: "obl-1", description: "The change must meet every criterion." }],
      });
    }
    if (pass === "findings") {
      const needsInspect =
        text.includes("at least one inspection tool") &&
        !toolResults.some((message) => (message.content as { toolName?: string }).toolName === "fs.read");
      if (needsInspect) {
        return call("fs.read", { path: "src/value.mjs" });
      }
      const thin = hasEmptyTestsRun(text);
      return call("record_deliverable_findings", {
        findings: thin
          ? [
              {
                id: "f-scope-1",
                category: "missing_coverage",
                severity: "blocking",
                claim: "Impacted areas were not run and notRun lacks a concrete justification.",
                location: "src/value.mjs",
                evidenceRefs: ["src/value.mjs:1"],
                defectClass: "unverified scope",
              },
            ]
          : [],
      });
    }
    const thin = hasEmptyTestsRun(text);
    return call("submit_deliverable_verdict", {
      summary: "Judged against the criteria and the scope report.",
      satisfied: !thin,
      claimVerdicts: [
        {
          claimId: "claim:c1",
          status: thin ? "unverified" : "verified",
          rationale: thin ? "Blocked by the scope gap." : "Checked against the diff.",
        },
        {
          claimId: "claim:summary",
          status: thin ? "unverified" : "verified",
          rationale: thin ? "Blocked by the scope gap." : "Checked against the diff.",
        },
      ],
    });
  }
}

const IV1_CANDIDATES: AgentRuntimeCandidate[] = [
  { runtimeId: "architect-runtime", providerId: "architect", modelId: "architect-model", capabilities: ["code"], priority: 1 },
  { runtimeId: "author-runtime", providerId: "author", modelId: "author-model", capabilities: ["code"], priority: 2 },
  { runtimeId: "reviewer-runtime", providerId: "reviewer", modelId: "reviewer-model", capabilities: ["code"], priority: 3 },
];

const IV1_DIFF = [
  "diff --git a/src/value.mjs b/src/value.mjs",
  "--- a/src/value.mjs",
  "+++ b/src/value.mjs",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 2;",
].join("\n");

async function iv1ReviewCase(scope: ValidationScope, label: string): Promise<{
  status: string;
  findings: Array<{ id: string; severity: string; category: string; claim: string }>;
  satisfied: boolean | undefined;
  reviewer: Iv1ScriptedReviewer;
}> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-iv1-review-${label}-`));
  const runId = `run_iv1_review_${label}`;
  const scheduler = new MemorySchedulerStore();
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  try {
    await iv1ReadyStore(runId, scheduler);
    scheduler.append({
      runId,
      type: "task.transitioned",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "assign:T1",
      payload: { taskId: "T1", status: "assigned", patch: { attempt: 1, assignedWorkerId: "worker_1" } },
    });
    scheduler.append({
      runId,
      type: "task.transitioned",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "running:T1",
      payload: { taskId: "T1", status: "running", patch: {} },
    });
    scheduler.append({
      runId,
      type: "worker.runtime_assigned",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: "runtime:T1:1",
      payload: { taskId: "T1", attempt: 1, runtimeId: "author-runtime", sessionId: "session:T1:1" },
    });
    scheduler.append({
      runId,
      type: "task.transitioned",
      occurredAt: CLOCK,
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "submit:T1",
      payload: {
        taskId: "T1",
        status: "submitted",
        patch: {
          changeSetId: "changeset_1",
          criterionEvidenceLinks: [
            { criterionId: "c1", evidenceId: "e1", artifactHashes: ["ab".repeat(32)], attempt: 1 },
          ],
          validationScope: scope,
        },
      },
    });
    const projection = projectionOf(scheduler, runId);
    const resolution = resolveTaskContractReference(projection, "T1");
    assert.equal(resolution.status, "current");
    if (resolution.status !== "current") throw new Error("unreachable");
    const diff = await artifacts.put(Buffer.from(IV1_DIFF, "utf8"), "text/x-diff", "diff");
    const reviewer = new Iv1ScriptedReviewer();
    const router = new RuntimeRouter({ health: new ProviderHealthRegistry(), candidates: IV1_CANDIDATES });
    const workspaceRoot = join(root, "review-workspace");
    const review = new NativeDeliverableReviewRuntime({
      store: scheduler,
      architectRuntimeId: "architect-runtime",
      router,
      candidates: IV1_CANDIDATES,
      models: new Map(IV1_CANDIDATES.map((candidate) => [candidate.runtimeId, reviewer])),
      reviewerRuntimeIds: ["reviewer-runtime"],
      sessions,
      artifacts,
      evidenceStore: evidence,
      loadInputs: async ({ task }): Promise<DeliverableReviewInputs> => {
        const criteria = (task.acceptanceCriteria ?? []).map((criterion) => ({
          id: criterion.id,
          text: criterion.text,
        }));
        return {
          taskId: task.id,
          attempt: task.attempt,
          changeSetId: task.changeSetId!,
          baselineRevision: "b".repeat(40),
          taskRevision: "c".repeat(40),
          diffArtifactHash: diff.hash,
          diffText: IV1_DIFF,
          changedPaths: ["src/value.mjs"],
          objective: task.objective,
          criteria,
          workerSummary: `Worker summary for ${task.id}`,
          unresolvedConcerns: [],
          claims: [
            ...criteria.map((criterion) => ({
              id: `claim:${criterion.id}`,
              text: `Criterion ${criterion.id} is satisfied.`,
              evidenceIds: [] as string[],
            })),
            { id: "claim:summary", text: `Worker summary for ${task.id}`, evidenceIds: [] as string[] },
          ],
          authorRuntimeId: "author-runtime",
          contract: resolution.contract,
          contractRef: resolution.ref,
          validationScope: scope,
        };
      },
      workspace: {
        create: async () => {
          mkdirSync(join(workspaceRoot, "src"), { recursive: true });
          writeFileSync(join(workspaceRoot, "src", "value.mjs"), "export const value = 2;\n");
          return { path: workspaceRoot };
        },
        cleanup: async () => rmSync(workspaceRoot, { recursive: true, force: true }),
      },
      depth: {
        run: async () => {
          throw new Error("No high-tier depth runner in this harness.");
        },
      },
      clock,
    });
    const result = await review.review({ runId, taskId: "T1" });
    const record = projectionOf(scheduler, runId).delivery?.reviews["T1"];
    return {
      status: result.status,
      findings: (record?.findings ?? []).map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        category: finding.category,
        claim: finding.claim,
      })),
      satisfied: record?.satisfied,
      reviewer,
    };
  } finally {
    sessions.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("IV-1 thin scope yields a real blocking finding through the existing finding tool", async () => {
  const { status, findings, satisfied, reviewer } = await iv1ReviewCase(thinScope(), "thin");
  assert.equal(status, "reviewed");
  assert.deepEqual(findings, [
    {
      id: "f-scope-1",
      severity: "blocking",
      category: "missing_coverage",
      claim: "Impacted areas were not run and notRun lacks a concrete justification.",
    },
  ]);
  assert.equal(satisfied, false);
  const seen = reviewer.requests.filter((request) => request.pass !== "obligations");
  assert.ok(seen.length >= 2, "findings and verdict passes ran");
  for (const request of seen) {
    assert.ok(hasEmptyTestsRun(request.text), `${request.pass} sees the thin scope`);
  }
  for (const request of reviewer.requests.filter((candidate) => candidate.pass === "obligations")) {
    assert.ok(!request.text.includes("testsRun"), "obligations stays blind to the scope");
  }
});

test("IV-1 adequate scope yields no fabricated finding", async () => {
  const { status, findings, satisfied, reviewer } = await iv1ReviewCase(iv1Scope(), "adequate");
  assert.equal(status, "reviewed");
  assert.deepEqual(findings, [], "the kernel invents no scope finding");
  assert.equal(satisfied, true);
  const seen = reviewer.requests.filter((request) => request.pass !== "obligations");
  assert.ok(seen.length >= 2, "findings and verdict passes ran");
  for (const request of seen) {
    assert.ok(
      request.text.includes("node --test test/value.test.mjs"),
      `${request.pass} sees the adequate scope`
    );
  }
});
