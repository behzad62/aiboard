import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { runnerRunStateSegment } from "../src/run-state-identity.js";
import { BuildRuntime } from "../src/build-runtime.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ControlServer } from "../src/control-server.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import { buildExecutionPlanRevision, type ExecutionPlanPhase, type ExecutionTaskContract, type SourceRequirement, type CoverageReview } from "../src/planning-contracts.js";
import { NativeBuildFactory as FixtureNativeBuildFactory, captureGitBaseline, runGit } from "./support/git-fixture.js";
import { buildApprovedSourceManifest, validateApprovedSourceInput, type ApprovedSourceInputV1 } from "../src/native-planning-provisioner.js";
import { rebuildSchedulerProjection, reduceSchedulerEvent, currentExplicitStartIdentity, explicitStartBlocked, type SchedulerProjection } from "../src/scheduler-store.js";
import { computeArtifactDigest, type ApprovedSourceManifest } from "../src/source-manifest.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { buildPlanningExportDocument, projectPlanningReadiness, validateExplicitStartRequest, resolveSelectionAnswerSequence, validateSourceAmendmentRequest, PLANNING_EXPORT_MAX_BYTES, type ExplicitStartRequestV1, type PlanningReadinessSnapshot, type PlanningExportDocument } from "../src/planning-controls.js";
import { seedBoundCoverageAndReady, seedDurableSourceReads } from "./support/planning-seed.js";
import { buildFixtureHostCapabilities } from "./fixtures/planning-source-fixture.js";
import { registerNativePlanningSource, amendNativePlanningSource, getNativePlanningReadiness, startNativeReadyPlan, exportNativePlanning, selectNativeArchitectHandoff, selectNativeVerifierRuntime } from "../../lib/client/runner-v2.js";

function sourceBytes(text: string): Uint8Array { return new Uint8Array(Buffer.from(text, "utf8")); }
function sourceInput(text: string, sections?: ApprovedSourceInputV1["sections"]): ApprovedSourceInputV1 { return { version: 1, approval: "approved_spec", bytesBase64: Buffer.from(text).toString("base64"), mediaType: "text/plain", encoding: "utf-8", ...(sections !== undefined ? { sections } : {}) }; }

const T7B_RUN = "run_t7b_product_journey";
const T7B_CLOCK = "2026-10-02T00:00:00.000Z";
const T7B_SOURCE = "SECTION s1: MANDATORY. The value module must export the value 2.\r\nSECTION s2: OPERATIONAL. Keep the change to src/value.mjs only; caf\u00e9 stays byte-exact.\r\n";
const T7B_LOW_CONTENT = "export const value = 2;\n";
const T7B_VALUE_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value', () => assert.equal(value, 2));\n";

function t7bJourneySections(): [{ id: string; startByte: number; endByte: number }, { id: string; startByte: number; endByte: number }] {
  const firstEnd = Buffer.byteLength(`${T7B_SOURCE.split("\n")[0]!}\n`, "utf8");
  return [
    { id: "s1", startByte: 0, endByte: firstEnd },
    { id: "s2", startByte: firstEnd, endByte: Buffer.byteLength(T7B_SOURCE, "utf8") },
  ];
}

function t7bJourneyScenario(runId: string) {
  const bytes = sourceBytes(T7B_SOURCE);
  const validated = validateApprovedSourceInput(sourceInput(T7B_SOURCE, [...t7bJourneySections()]));
  const manifest = buildApprovedSourceManifest({
    runId,
    validated,
    artifactDigest: computeArtifactDigest(bytes),
    approvedBy: "local-user",
    createdAt: T7B_CLOCK,
  });
  const requirements: SourceRequirement[] = [{
    id: "REQ-1",
    reference: { sourceId: manifest.sourceId, sectionIds: ["s1", "s2"] },
    purpose: "Export the value 2.",
    observableOutcome: "The value module exports 2.",
    obligationKind: "mandatory",
    applicability: { status: "applicable" },
    accountablePhaseId: "P1",
    contributingTaskIds: ["T1"],
    acceptanceConditions: [{ id: "REQ-1-ac1", description: "value is 2.", responsibleGateId: "P1-exit", requiredEvidenceKinds: ["command"] }],
  }];
  const phases: ExecutionPlanPhase[] = [{
    id: "P1",
    purpose: "Deliver the value module.",
    requirementIds: ["REQ-1"],
    scope: { includes: ["src/value.mjs"], excludes: ["docs/project/STATE.md"] },
    entryConditions: ["Plan ready."],
    contributingTaskIds: ["T1"],
    exitCriteria: ["The value module is accepted."],
    requiredCombinedValidation: ["tests"],
    exitUnlocks: ["final verification"],
  }];
  const tasks: ExecutionTaskContract[] = [{
    id: "T1",
    lineage: [],
    accountablePhaseId: "P1",
    requirementIds: ["REQ-1"],
    outcome: { user: "Create src/value.mjs exporting value = 2.", system: "The value module exports 2." },
    scope: { includes: ["src/value.mjs"], excludes: ["test/value.test.mjs"] },
    writableSurfaces: ["src/value.mjs"],
    forbiddenSurfaces: ["test/value.test.mjs"],
    dependencies: [],
    requiredBase: "accepted plan revision revision_t7b",
    inputs: ["accepted plan revision"],
    outputs: ["src/value.mjs"],
    steps: ["Write the module.", "Run the tests."],
    acceptance: { criteria: [{ id: "c1", text: "src/value.mjs exports value = 2 and the tests pass." }], definitionOfDone: "Tests pass." },
    validation: { targetedRationale: "The value test.", affectedScopeRationale: "The module only." },
    negativeProofApplicability: { applicable: false, rationale: "A new module has no prior-incorrect case." },
    reviewCriteria: ["Independent review confirms the value."],
    integrationChecks: ["Post-integration tests."],
    cleanup: { cleanup: "None.", recovery: "Retry.", rollback: "Revert." },
    requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-1" }],
  }];
  const revision = buildExecutionPlanRevision({
    revisionId: "revision_t7b",
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: T7B_CLOCK,
  });
  return { manifest, requirements, phases, revision };
}

const journeyCall = (name: string, args: unknown, id: string): ModelTurn => ({
  blocks: [{ type: "tool_call", callId: id, name, arguments: args }],
  stopReason: "tool_calls",
  usage: { inputTokens: 8, outputTokens: 4 },
});

function journeyLastToolValue(request: AgentModelRequest): Record<string, unknown> | undefined {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === "tool");
  const content = (message?.content as { content?: Array<{ type: string; value?: unknown }> } | undefined)?.content;
  return content?.find((item) => item.type === "json")?.value as Record<string, unknown> | undefined;
}

class T7bJourneyArchitect implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private calls = 0;
  constructor(
    private readonly projection: () => SchedulerProjection,
    private readonly scenario: ReturnType<typeof t7bJourneyScenario>,
  ) {}
  private call(name: string, args: unknown): ModelTurn {
    this.calls += 1;
    return journeyCall(name, args, `t7b-arch-${this.calls}`);
  }
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const projection = this.projection();
    const planning = projection.planning;
    if (projection.planningTriageDecision === undefined) {
      return this.call("record_triage", { decision: "build", rationale: "T7b product: change request with an approved source." });
    }
    const manifestId = planning?.source.currentManifestId;
    assert.ok(manifestId, "the approved source is registered before planning reads");
    const reads = planning?.sourceReadIndex[manifestId] ?? {};
    const sections = this.scenario.manifest.sections;
    if (sections.some((section) => reads[section.id] !== section.digest)) {
      const pending = sections.find((section) => reads[section.id] !== section.digest)!;
      const seen = this.requests.length;
      if (seen <= 2) return this.call("read_planning_source_section", {});
      return this.call("read_planning_source_section", { sectionId: pending.id });
    }
    if (!planning?.ledger) {
      return this.call("persist_planning_ledger", {
        id: "ledger-1",
        requirements: this.scenario.requirements,
        phases: this.scenario.phases,
        nonNormativeSections: [],
      });
    }
    if (!planning?.plan) {
      const { digest: _digest, runId: _run, createdAt: _created, ...rest } =
        this.scenario.revision as unknown as Record<string, unknown>;
      void _digest;
      void _run;
      void _created;
      return this.call("draft_planning_plan", { revision: rest });
    }
    if (Object.keys(planning?.coverageRequests ?? {}).length === 0) {
      return this.call("request_coverage_review", { reviewId: "coverage_t7b" });
    }
    const task = projection.tasks.T1!;
    if (task.status === "submitted" || task.status === "architect_review") {
      const links = task.criterionEvidenceLinks ?? [];
      return this.call("review_task", {
        taskId: "T1",
        decision: "approved",
        summary: "The deliverable review is satisfied and the evidence passes.",
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        criterionVerdicts: [{ criterionId: "c1", verdict: "satisfied", rationale: "Tests pass.", evidenceIds: links.map((link) => link.evidenceId), artifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))] }],
      });
    }
    if (task.status === "approved") return this.call("request_integration", { taskId: "T1" });
    throw new Error(`T7b journey script exhausted at T1 ${task.status}.`);
  }
}

class T7bJourneyWorker implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const toolCount = request.messages.filter((message) => message.role === "tool").length;
    if (toolCount === 0) return journeyCall("fs.write", { path: "src/value.mjs", content: T7B_LOW_CONTENT, createDirectories: true }, "write-1");
    if (toolCount === 1) return journeyCall("run_evidence_command", { label: "tests", command: process.execPath, args: ["--test"] }, "evidence-1");
    const record = journeyLastToolValue(request)!;
    const fact = record.fact as { stdoutArtifactHash: string };
    return journeyCall("submit_task", {
      summary: "Added src/value.mjs exporting value = 2; node --test passes.",
      readiness: "ready_for_architect_review",
      unresolvedConcerns: [],
      criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [fact.stdoutArtifactHash] }],
    }, "submit-1");
  }
}

class T7bJourneyReviewer implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const tools = new Set(request.tools.map((tool) => tool.name));
    const seen = request.messages.filter((message) => message.role === "tool").length;
    // Independent coverage, blind first: obligations before any plan view.
    if (tools.has("record_coverage_obligations")) {
      return journeyCall("record_coverage_obligations", {
        obligations: [{ id: "obl-REQ-1", description: "Export the value 2.", requirementId: "REQ-1" }],
        sectionCoverage: [
          { sectionId: "s1", obligationIds: ["obl-REQ-1"] },
          { sectionId: "s2", obligationIds: ["obl-REQ-1"] },
        ],
      }, `obl-${seen}`);
    }
    if (tools.has("submit_coverage_verdict")) {
      return journeyCall("submit_coverage_verdict", {
        obligationVerdicts: [{ obligationId: "obl-REQ-1", verdict: "covered", severity: "advisory", rationale: "T1 covers it.", evidenceRefs: ["ledger:REQ-1"] }],
        findings: [],
      }, `verdict-${seen}`);
    }
    const system = request.messages.find((message) => message.role === "system");
    const pass = system?.id ?? "";
    if (pass === "delivery-obligations-system") {
      return journeyCall("record_deliverable_obligations", { obligations: [{ id: "o1", description: "value must be 2." }] }, `obl-${seen}`);
    }
    if (pass === "delivery-findings-system") {
      if (seen === 0) return journeyCall("fs.read", { path: "src/value.mjs" }, "read-1");
      return journeyCall("record_deliverable_findings", { findings: [] }, `findings-${seen}`);
    }
    if (request.tools.some((tool) => tool.name === "record_verification_expectations")) {
      return journeyCall("record_verification_expectations", {
        expectations: [{
          taskId: "T1",
          criterionId: "c1",
          expectedBehaviors: ["src/value.mjs exports value = 2."],
          edgeCases: ["A new module has no prior-incorrect case."],
          regressionSurfaces: ["src/value.mjs"],
          requiredTests: ["The value test passes."],
        }],
      }, `verifier-expectations-${seen}`);
    }
    if (request.tools.some((tool) => tool.name === "submit_verifier_verdict")) {
      if (seen === 0) {
        return journeyCall("run_evidence_command", { label: "verifier-tests", command: process.execPath, args: ["--test"] }, "verifier-evidence-1");
      }
      const record = journeyLastToolValue(request);
      const evidenceId = (record as { id?: unknown } | undefined)?.id;
      assert.ok(typeof evidenceId === "string" && evidenceId.length > 0, "the verifier test run records evidence");
      return journeyCall("submit_verifier_verdict", {
        criterionVerdicts: [{
          taskId: "T1",
          criterionId: "c1",
          verdict: "satisfied",
          rationale: "The module exports 2 and the cited verifier test run passed.",
          evidenceIds: [evidenceId],
        }],
      }, "verifier-verdict-1");
    }
    const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
    const claimIds = [...new Set([...text.matchAll(/"id": "(claim:[^"]+)"/g)].map((match) => match[1]!))];
    return journeyCall("submit_deliverable_verdict", {
      summary: "The module exports 2 and the cited test run passed.",
      satisfied: true,
      claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Confirmed in the checkout." })),
    }, `verdict-${seen}`);
  }
}

function t7bProvider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

test("T7b product: unseeded opt-in provisioning plans, covers, builds, and accepts through the real factory", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7b-journey-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "t7b-journey-fixture", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(project, "test", "value.test.mjs"), T7B_VALUE_TEST);
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: T7B_RUN });
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
  });
  const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")), { clock: () => T7B_CLOCK });
  let server: ControlServer | undefined;
  let factory: FixtureNativeBuildFactory | undefined;
  let manager: NativeBuildManager | undefined;
  let runtime: { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection } | undefined;
  try {
    const worker = new T7bJourneyWorker();
    const reviewer = new T7bJourneyReviewer();
    const architect = new T7bJourneyArchitect(() => runtime!.projection(), t7bJourneyScenario(T7B_RUN));
    factory = new FixtureNativeBuildFactory({
      projectRoot: project,
      stateDirectory: state,
      providerConfigs: {
        load: () => [t7bProvider("arch:architect", 1), t7bProvider("work:worker", 2), t7bProvider("rev:reviewer", 3)],
        save: () => undefined,
        close: () => undefined,
      },
      executionHost,
      baselineFor: () => baseline.revision,
      providerModelFactory: (config) => {
        if (config.runtimeId === "arch:architect") return architect;
        if (config.runtimeId === "work:worker") return worker;
        return reviewer;
      },
    });
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: (spec) => factory!.create(spec).then((handle) => {
        runtime = handle.runtime as typeof runtime;
        return handle;
      }),
      prepareSpec: (spec, options) => factory!.prepareSpec(spec, options),
    });
    // The actual authenticated production route forwards owner input into
    // the real manager, saved spec, factory, scheduler and model transports.
    server = new ControlServer({ supervisor, token: "t7b-control-token",
      builds: manager, buildProvisioner: manager,
      checkGit: async () => ({ available: true, version: "fixture-git", code: "git_ready", reason: null }),
      bootstrapRun: async () => ({ baselineRevision: baseline.revision, baselineRef: baseline.ref }),
    });
    const address = await server.start(0);
    const body = { runId: T7B_RUN, projectPath: project, permissionProfile: "full",
      idempotencyKey: "t7b-journey", build: {
        projectId: "t7b-journey-fixture", objective: "Deliver the value module.",
        architectRuntimeId: "arch:architect", workerRuntimeIds: ["work:worker"], verifierRuntimeIds: ["rev:reviewer"],
        alwaysRequireIndependentVerifier: false, maxConcurrency: 1, runPolicy: "finish", budgetLimits: {},
        planningPolicy: { version: 1 },
      } };
    const create = () => fetch(`${address.url}/v2/runs`, { method: "POST",
      headers: { Authorization: "Bearer t7b-control-token", "Content-Type": "application/json" },
      body: JSON.stringify(body) });
    const created = await create();
    assert.equal(created.status, 201, await created.text());
    const originalEvents = manager.events(T7B_RUN);
    const retry = await create();
    assert.equal(retry.status, 201, await retry.text());
    assert.deepEqual(manager.events(T7B_RUN), originalEvents, "HTTP retry reuses exact saved approval and policy");
    // The first three scheduler events are the T7b prefix, before factory consumers.
    let events = manager.events(T7B_RUN);
    assert.deepEqual(events.slice(0, 3).map((event) => event.type), [
      "project_docs.policy_configured",
      "run.initialized",
      "planning.policy_configured",
    ]);
    assert.deepEqual(events.slice(0, 3).map((event) => event.sequence), [1, 2, 3]);
    for (const event of events.slice(0, 3)) {
      assert.deepEqual(event.actor, { role: "runner", id: "build-runtime" });
    }
    assert.deepEqual(events.slice(0, 3).map((event) => event.idempotencyKey), [
      "project-docs-policy",
      "run-initialized",
      "planning-policy",
    ]);
    assert.deepEqual(events[0]!.payload, { version: 2 });
    assert.deepEqual(events[1]!.payload, { objective: "Deliver the value module." });
    assert.deepEqual(events[2]!.payload, { version: 1 });
    assert.ok(!events.some((event) => event.type === "planning.source_registered"));
    const control = (path: string, input?: unknown, token = "t7b-control-token") => fetch(`${address.url}/v2/runs/${T7B_RUN}/build/${path}`, { method: input === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
    const approve = { approvedSource: sourceInput(T7B_SOURCE, [...t7bJourneySections()]), idempotencyKey: "approve-source" };
    const denied = await control("source", approve, "wrong-token");
    assert.equal(denied.status, 401);
    const approved = await control("source", approve);
    assert.equal(approved.status, 200, await approved.text());
    events = manager.events(T7B_RUN);
    const afterApprove = [...events];
    assert.equal((await control("source", approve)).status, 200);
    assert.deepEqual(manager.events(T7B_RUN), afterApprove);
    const saved = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
    try { assert.equal(saved.get(T7B_RUN).approvedSource, undefined, "initial saved spec is immutable and source-free"); } finally { saved.close(); }
    // The kernel registered the explicitly approved source immutably.
    const registered = events.find((event) => event.type === "planning.source_registered")!;
    assert.ok(registered, "the approved source is registered");
    assert.deepEqual(registered.actor, { role: "user", id: "local-user" });
    const manifest = (registered.payload as { manifest: ApprovedSourceManifest }).manifest;
    const expectedDigest = createHash("sha256").update(T7B_SOURCE, "utf8").digest("hex");
    assert.equal(manifest.artifactDigest, expectedDigest);
    assert.equal(manifest.byteLength, Buffer.byteLength(T7B_SOURCE, "utf8"));
    assert.equal(manifest.authority, "user:local-user");
    const storedBytes = await new ArtifactStore(join(state, "artifacts")).get(expectedDigest);
    assert.deepEqual(Buffer.from(storedBytes).toString("utf8"), T7B_SOURCE);
    const stepUntil = async (label: string, done: (projection: SchedulerProjection) => boolean, cap = 200): Promise<SchedulerProjection> => {
      for (let step = 0; step < cap; step += 1) {
        const projection = runtime!.projection();
        if (done(projection)) return projection;
        if (projection.status === "paused" || projection.status === "failed") {
          throw new Error(`${label}: run ${projection.status} unexpectedly (${JSON.stringify(projection.pauseReason)})`);
        }
        await runtime!.step();
      }
      throw new Error(`${label}: not reached within ${cap} steps`);
    };
    await stepUntil("ready plan", (projection) => projection.planning?.readiness === "ready");
    assert.equal(worker.requests.length, 0);
    const beforePreview = manager.events(T7B_RUN);
    const readyResponse = await control("planning-readiness");
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as PlanningReadinessSnapshot;
    assert.equal(ready.status, "ready_start_required");
    const exportedResponse = await control("planning-export");
    assert.equal(exportedResponse.status, 200);
    const exported = await exportedResponse.json() as PlanningExportDocument;
    assert.equal(exported.snapshot.digestValid, true);
    assert.ok(exported.snapshot.text.includes("REQ-1"));
    assert.deepEqual(manager.events(T7B_RUN), beforePreview);
    assert.equal(worker.requests.length, 0);
    const start = { version: 1 as const, planRevisionId: ready.planRevisionId!, planDigest: ready.planDigest!, sourceManifestId: ready.sourceManifestId!, sourceArtifactDigest: ready.sourceArtifactDigest!, planningPolicyVersion: 1 as const, projectDocsPolicyVersion: ready.projectDocsPolicyVersion!, ownerChoice: "execute" as const, idempotencyKey: "start-current" };
    assert.equal((await control("plan-start", { ...start, planDigest: "f".repeat(64) })).status, 409);
    assert.equal((await control("plan-start", { ...start, ownerChoice: "preview" })).status, 400);
    assert.equal((await control("plan-start", start, "wrong-token")).status, 401);
    assert.deepEqual(manager.events(T7B_RUN), beforePreview);
    const awaitingStart = await runtime!.step();
    assert.equal(awaitingStart.action, "plan_start_required");
    assert.equal(worker.requests.length, 0);
    const started = await control("plan-start", start);
    assert.equal(started.status, 200, await started.text());
    const afterStart = manager.events(T7B_RUN);
    assert.equal((await control("plan-start", start)).status, 200);
    assert.deepEqual(manager.events(T7B_RUN), afterStart);
    assert.equal(worker.requests.length, 0, "authorizing does not itself dispatch");
    const accepted = await stepUntil(
      "task acceptance",
      () => manager!.events(T7B_RUN).some((event) => event.type === "task.acceptance_recorded"),
    );
    events = manager.events(T7B_RUN);
    const types = events.map((event) => event.type);
    // Triage is the first actual planning action; reads, ledger, and draft follow.
    const triagedAt = types.indexOf("request.triaged");
    assert.ok(triagedAt >= 0);
    for (const later of ["planning.source_section_read", "planning.ledger_persisted", "planning.plan_drafted"] as const) {
      assert.ok(types.indexOf(later) > triagedAt, `${later} follows triage`);
    }
    // Independent coverage, blind first, then ready on the current revision.
    const obligations = events.find((event) => event.type === "planning.coverage_obligations_recorded")!;
    assert.ok(obligations, "coverage obligations recorded");
    assert.equal((obligations.payload as { sourceManifestId: string }).sourceManifestId, manifest.manifestId);
    const review = accepted.planning?.coverageReview;
    assert.ok(review, "coverage review recorded");
    assert.equal(review!.sourceReadManifestId, manifest.manifestId);
    assert.equal(review!.independence, "distinct_model");
    assert.ok(
      review!.derivedObligations.every((obligation) => obligation.recordedBeforePlanOrDiffProvided),
      "obligations derive blind, before the plan",
    );
    assert.ok(review!.obligationVerdicts.length > 0 && review!.obligationVerdicts.every((verdict) => verdict.verdict === "covered"));
    assert.equal(accepted.planning?.readiness, "ready");
    // The worker really wrote, ran evidence, and submitted after the run started.
    const task = accepted.tasks.T1!;
    assert.ok(task.criterionEvidenceLinks && task.criterionEvidenceLinks.length > 0, "submission cites evidence");
    const integrationDirs = readdirSync(join(state, "integration"));
    assert.equal(integrationDirs.length, 1);
    const delivered = (await runGit({ cwd: join(state, "integration", integrationDirs[0]!), args: ["show", "HEAD:src/value.mjs"] })).stdout;
    assert.equal(delivered, T7B_LOW_CONTENT);
    // Delivery review ran post-integration and the boundary accepted the task.
    assert.ok(types.includes("delivery.review_started"), "delivery review started");
    assert.ok(types.includes("delivery.boundary_checked"), "post-integration boundary checked");
    assert.ok(types.includes("task.acceptance_recorded"), "owned acceptance recorded");
    // Real participants throughout, and the journey stops at owned acceptance.
    assert.ok(architect!.requests.length > 0, "the Architect really planned");
    assert.ok(worker.requests.length > 0, "the worker really built");
    assert.ok(reviewer.requests.length > 0, "the independent reviewer really reviewed");
    assert.equal(types.filter((type) => type.startsWith("final_verification.")).length, 0, "no repeated final verification journey");
    assert.equal(accepted.status, "running", "the run stops at acceptance, it does not complete itself");
  } finally {
    await server?.close();
    supervisor.close();
    await manager?.close().catch(() => undefined);
    await factory?.close().catch(() => undefined);
    await executionHost?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});


function controlFixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `aiboard-t7b-${label}-`));
  let clocks = 0;
  const clock = () => new Date(Date.parse(T7B_CLOCK) + ++clocks * 1000).toISOString();
  mkdirSync(join(root, "artifacts"), { recursive: true });
  const artifacts = new ArtifactStore(join(root, "artifacts"), { clock });
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { artifacts });
  let workers = 0, allocations = 0;
  const runtime = new BuildRuntime({ runId: "run_t7b_controls", initialObjective: "Deliver the value module.", specCreatedAt: T7B_CLOCK,
    planningPolicy: { version: 1 }, store, artifacts, clock, maxConcurrency: 1,
    architectDriver: { run: async () => { throw new Error("unexpected model effect"); } },
    workerDriver: { run: async () => { workers++; return { type: "paused", reason: "test-stop" }; } },
    integrationDriver: { integrate: async () => { throw new Error("unexpected integration effect"); } },
    workspaceFor: async () => { allocations++; return root; },
  });
  const append = (type: import("../src/scheduler-store.js").SchedulerEventType, key: string, payload: Record<string, unknown>, role: "architect" | "runner" | "user" = "architect", id = role === "user" ? "local-user" : "architect_1") => store.append({ runId: "run_t7b_controls", type, idempotencyKey: key, actor: { role, id }, occurredAt: T7B_CLOCK, payload });
  const approve = () => runtime.registerPlanningSource({ approvedSource: sourceInput(T7B_SOURCE, [...t7bJourneySections()]), idempotencyKey: "initial-owner-source" });
  const seedReady = async () => {
    await approve();
    append("request.triaged", "triage", { decision: "build", rationale: "The fixture is a change request." });
    const scenario = t7bJourneyScenario("run_t7b_controls");
    append("planning.ledger_persisted", "ledger", { id: "ledger", requirements: scenario.requirements, phases: scenario.phases, nonNormativeSections: [] });
    seedDurableSourceReads(store, "run_t7b_controls", scenario.manifest, T7B_CLOCK);
    append("planning.plan_drafted", "draft", { revision: scenario.revision, expectedRevisionId: null, expectedDigest: null });
    const review: CoverageReview = { id: "coverage-cheap", runId: "run_t7b_controls", reviewerRuntimeId: "rev:reviewer", independence: "distinct_model", sourceReadManifestId: scenario.manifest.manifestId,
      planRevisionId: scenario.revision.revisionId, planRevisionDigest: scenario.revision.digest,
      derivedObligations: [{ id: "obl", requirementId: "REQ-1", description: "Export value 2.", recordedBeforePlanOrDiffProvided: true, recordedAt: T7B_CLOCK }],
      obligationVerdicts: [{ obligationId: "obl", verdict: "covered", severity: "advisory", rationale: "T1 covers the source.", evidenceRefs: ["ledger:REQ-1"] }], findings: [], recordedAt: T7B_CLOCK };
    seedBoundCoverageAndReady(store, "run_t7b_controls", { revision: scenario.revision, manifest: scenario.manifest, review, hostCapabilities: buildFixtureHostCapabilities(), occurredAt: T7B_CLOCK });
    return scenario;
  };
  const start = (): ExplicitStartRequestV1 => ({ version: 1, ...currentExplicitStartIdentity(runtime.projection())!, ownerChoice: "execute", idempotencyKey: "execute-owner" });
  const amendment = (overrides: Record<string, unknown> = {}) => validateSourceAmendmentRequest({ ...sourceInput(T7B_SOURCE.replace("value 2", "value 3"), [...t7bJourneySections()]), predecessorManifestId: runtime.projection().planning!.source.currentManifestId,
    predecessorArtifactDigest: runtime.projection().planning!.source.artifactDigest, amendmentId: "amend-1", rationale: "The owner changes the approved specification.", impact: { addsSectionIds: [], retiresSectionIds: [], addsRequirementIds: [], retiresRequirementIds: [] }, idempotencyKey: "owner-amendment", ...overrides });
  const evidence = () => ({ events: store.readRun("run_t7b_controls"), files: readdirSync(join(root, "artifacts"), { recursive: true }), clocks, workers, allocations });
  return { root, artifacts, store, runtime, append, approve, seedReady, start, amendment, evidence, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("T7b source control: exact retry has zero clock/artifact/event effects and conflicting body refuses", async () => {
  const f = controlFixture("source-retry");
  try {
    await f.approve(); const before = f.evidence();
    await f.approve(); assert.deepEqual(f.evidence(), before);
    await assert.rejects(f.runtime.registerPlanningSource({ approvedSource: sourceInput("different source"), idempotencyKey: "initial-owner-source" }), /idempotency conflict/);
    assert.deepEqual(f.evidence(), before);
    await assert.rejects(f.runtime.registerPlanningSource({ approvedSource: sourceInput(T7B_SOURCE), idempotencyKey: "new-key" }), /already registered/);
    assert.deepEqual(f.evidence(), before);
    const registered = before.events.find((event) => event.type === "planning.source_registered")!;
    assert.equal(registered.idempotencyKey, "initial-owner-source");
    assert.equal((registered.payload.manifest as ApprovedSourceManifest).authority, "user:local-user");
  } finally { f.cleanup(); }
});

test("T7b amendment: exact retry survives current predecessor advance; every changed semantic field refuses before effects", async () => {
  const f = controlFixture("amend-retry");
  try {
    await f.approve(); const request = f.amendment();
    await f.runtime.amendPlanningSource(request); const before = f.evidence();
    await f.runtime.amendPlanningSource(request); assert.deepEqual(f.evidence(), before);
    for (const changed of [{ ...request, rationale: "different approval rationale" }, { ...request, validated: { ...request.validated, mediaType: "text/markdown" as const } }, { ...request, validated: { ...request.validated, sections: request.validated.sections.map((section) => ({ ...section, title: "different title" })) } }, { ...request, impact: { ...request.impact, addsRequirementIds: ["REQ-NEW"] } }]) {
      await assert.rejects(f.runtime.amendPlanningSource(changed), /idempotency conflict/); assert.deepEqual(f.evidence(), before);
    }
    await assert.rejects(f.runtime.amendPlanningSource({ ...request, idempotencyKey: "other-key" }), /stale/);
    await assert.rejects(f.runtime.amendPlanningSource(f.amendment({ idempotencyKey: "another-key" })), /amendmentId/);
    assert.deepEqual(f.evidence(), before);
  } finally { f.cleanup(); }
});

test("T7b amendment: contradictory or unknown retirement impacts refuse without clock/artifact/event effects", async () => {
  const f = controlFixture("impact");
  try {
    await f.approve(); const before = f.evidence();
    for (const impact of [{ addsSectionIds: ["s1"], retiresSectionIds: [], addsRequirementIds: [], retiresRequirementIds: [] }, { addsSectionIds: [], retiresSectionIds: ["missing"], addsRequirementIds: [], retiresRequirementIds: [] }, { addsSectionIds: [], retiresSectionIds: [], addsRequirementIds: [], retiresRequirementIds: ["missing"] }, { addsSectionIds: [], retiresSectionIds: [], addsRequirementIds: ["REQ-X"], retiresRequirementIds: ["REQ-X"] }]) {
      await assert.rejects(f.runtime.amendPlanningSource(f.amendment({ impact })), /Source amendment refused/); assert.deepEqual(f.evidence(), before);
    }
  } finally { f.cleanup(); }
});

test("T7b start: only canonical affirmative consent and all six current identities authorize", async () => {
  const f = controlFixture("start");
  try {
    await f.seedReady(); const start = f.start(), before = f.evidence();
    for (const ownerChoice of ["", " ", "preview", "refuse", " execute", "execute "]) assert.throws(() => validateExplicitStartRequest({ ...start, ownerChoice }), /ownerChoice/);
    for (const key of ["planRevisionId", "planDigest", "sourceManifestId", "sourceArtifactDigest", "planningPolicyVersion", "projectDocsPolicyVersion"] as const) {
      const changed = { ...start, [key]: key.endsWith("Digest") ? "f".repeat(64) : key.endsWith("Version") ? (start[key] === 1 ? 2 : 1) : "old-identity" };
      await assert.rejects(f.runtime.authorizeExplicitPlanStart(changed as ExplicitStartRequestV1)); assert.deepEqual(f.evidence(), before);
    }
    await f.runtime.authorizeExplicitPlanStart(start);
    const authorized = f.evidence(); await f.runtime.authorizeExplicitPlanStart(start); assert.deepEqual(f.evidence(), authorized);
    assert.equal(f.runtime.projection().planning!.executionAuthorization!.authorizedBy, "user:local-user");
    assert.equal(explicitStartBlocked(f.runtime.projection()), undefined);
    await assert.rejects(f.runtime.authorizeExplicitPlanStart({ ...start, idempotencyKey: "execute-owner", ownerChoice: "preview" } as never));
    assert.deepEqual(f.evidence(), authorized);
  } finally { f.cleanup(); }
});

test("T7b start kernel: foreign owner, wrong policy, worker approval and acceptance injection refuse unchanged", async () => {
  const f = controlFixture("owner-kernel");
  try {
    await f.seedReady(); const { idempotencyKey: _key, ...authorization } = f.start(); void _key; const before = f.evidence();
    const projection = f.runtime.projection();
    for (const [actor, payload] of [[{ role: "user", id: "other-owner" }, { authorization }], [{ role: "worker", id: "worker" }, { authorization }], [{ role: "user", id: "local-user" }, { authorization: { ...authorization, projectDocsPolicyVersion: 1 } }]] as const) {
      assert.throws(() => f.store.append({ runId: projection.runId, type: "planning.execution_authorized", occurredAt: T7B_CLOCK, actor, idempotencyKey: "forged", payload }));
      assert.deepEqual(f.evidence(), before);
    }
    assert.throws(() => f.append("task.acceptance_recorded", "forged-acceptance", { taskId: "T1" }, "user"));
    assert.deepEqual(f.evidence(), before);
  } finally { f.cleanup(); }
});

test("T7b stale-ready negative proof: prior authorization never allocates or dispatches workers after a new ready revision", async () => {
  const f = controlFixture("stale-ready");
  try {
    const scenario = await f.seedReady(); const old = f.start(); await f.runtime.authorizeExplicitPlanStart(old);
    const { digest: _digest, ...base } = scenario.revision; void _digest;
    const revision = buildExecutionPlanRevision({ ...base, revisionId: "revision_t7b_second", planningDecisions: [{ id: "new-choice", description: "The plan changed.", decidedAt: T7B_CLOCK }] });
    f.append("planning.plan_revised", "second-plan", { revision, expectedRevisionId: scenario.revision.revisionId, expectedDigest: scenario.revision.digest });
    const review: CoverageReview = { ...f.runtime.projection().planning!.coverageReview!, id: "coverage-second", planRevisionId: revision.revisionId, planRevisionDigest: revision.digest };
    seedBoundCoverageAndReady(f.store, "run_t7b_controls", { revision, manifest: scenario.manifest, review, hostCapabilities: buildFixtureHostCapabilities(), occurredAt: T7B_CLOCK });
    const before = f.evidence();
    assert.match(explicitStartBlocked(f.runtime.projection())!, /Re-authorize/);
    const result = await f.runtime.step();
    assert.equal(result.action, "plan_start_required");
    assert.equal(f.evidence().workers, 0); assert.equal(f.evidence().allocations, 0);
    assert.equal(f.evidence().events.filter((event) => event.type === "task.transitioned").length, before.events.filter((event) => event.type === "task.transitioned").length);
    const afterPause = f.evidence(); await assert.rejects(f.runtime.authorizeExplicitPlanStart(old), /stale/); assert.deepEqual(f.evidence(), afterPause);
  } finally { f.cleanup(); }
});

test("T7b current source drift refuses explicit start and direct live worker admission", async () => {
  const f = controlFixture("artifact-drift");
  try {
    await f.seedReady(); const start = f.start(); const hash = start.sourceArtifactDigest;
    const record = f.artifacts.verifySync(hash); writeFileSync(record.path, "drifted bytes");
    const before = f.evidence(); await assert.rejects(f.runtime.authorizeExplicitPlanStart(start), /hash mismatch/); assert.deepEqual(f.evidence(), before);
    assert.throws(() => f.append("task.transitioned", "direct-worker", { taskId: "T1", status: "assigned" }, "runner", "task-scheduler"));
    assert.deepEqual(f.evidence(), before);
  } finally { f.cleanup(); }
});

test("T7b source amendment invalidates readiness and refuses the previously approved start", async () => {
  const f = controlFixture("amend-drift");
  try {
    await f.seedReady(); const start = f.start(); await f.runtime.authorizeExplicitPlanStart(start);
    await f.runtime.amendPlanningSource(f.amendment()); const before = f.evidence();
    assert.equal(f.runtime.planningReadiness().status, "not_ready");
    await assert.rejects(f.runtime.authorizeExplicitPlanStart(start), /stale/); assert.deepEqual(f.evidence(), before);
  } finally { f.cleanup(); }
});

test("T7b selection: missing/no-pending/stale answer refuses and exact answer replay never retargets a replacement offer", () => {
  const f = controlFixture("selection");
  try {
    f.append("verifier.policy_configured", "verifier-policy", { mode: "risk_based", candidateRuntimeIds: ["rev:reviewer"], alwaysRequireIndependentVerifier: false }, "runner", "build-runtime");
    for (const type of ["architect", "verifier"] as const) {
      const select = (key: string, sequence?: number) => type === "architect" ? f.runtime.selectArchitectHandoff("rev:reviewer", key, sequence) : f.runtime.selectVerifierRuntime("rev:reviewer", key, sequence);
      const before = f.evidence(); assert.throws(() => select("no-offer", 1)); assert.deepEqual(f.evidence(), before);
      const offer = f.append(type === "architect" ? "architect.handoff_required" : "verifier.selection_required", `${type}-offer1`, { reason: "Owner selects a model.", requiredCapabilities: ["code"], candidateRuntimeIds: ["rev:reviewer"] }, "runner", "build-runtime");
      const offered = f.evidence(); assert.throws(() => select("missing")); assert.deepEqual(f.evidence(), offered);
      select("owner-selection", offer.sequence); const selected = f.evidence(); select("owner-selection", offer.sequence); assert.deepEqual(f.evidence(), selected);
      const replacement = f.append(type === "architect" ? "architect.handoff_required" : "verifier.selection_required", `${type}-offer2`, { reason: "Replacement owner selection.", requiredCapabilities: ["code"], candidateRuntimeIds: ["rev:reviewer"] }, "runner", "build-runtime");
      const replaced = f.evidence(); select("owner-selection", offer.sequence); assert.deepEqual(f.evidence(), replaced, "exact old replay cannot answer the new offer");
      assert.throws(() => select("new-old-answer", offer.sequence), /stale/); assert.deepEqual(f.evidence(), replaced);
      select("owner-selection", replacement.sequence);
      assert.equal(f.runtime.projection().status, "running");
    }
    assert.throws(() => resolveSelectionAnswerSequence({ current: 1, provided: undefined, label: "Selection" }));
  } finally { f.cleanup(); }
});

test("T7b readiness: answer/clarify/triage/legacy/plan-only remain honest about authorization", () => {
  const base = { planningPolicyVersion: 1 as const, projectDocsPolicyVersion: 2, runPolicy: "finish" };
  for (const [decision, status] of [["answer", "planning_not_applicable"], ["clarify", "clarification_required"], [undefined, "triage_pending"], ["build", "source_missing"]] as const) {
    const view = projectPlanningReadiness({ runId: "run", projection: { ...base, planningTriageDecision: decision }, explicitStartAuthorized: true });
    assert.equal(view.status, status); assert.equal(view.explicitStartAuthorized, false);
    if (decision === "answer") assert.deepEqual(view.blockers, []);
  }
  assert.equal(projectPlanningReadiness({ runId: "old", projection: {}, explicitStartAuthorized: true }).status, "not_opted_in");
});

test("T7b export: current amended revision sidecars, credential redaction, size bounds and visible omissions", async () => {
  const f = controlFixture("export");
  try {
    const scenario = await f.seedReady(); const projection = f.runtime.projection();
    const { digest: _digest, ...base } = scenario.revision; void _digest;
    const revision = buildExecutionPlanRevision({ ...base, revisionId: "revision-new", requirements: scenario.requirements.map((entry) => ({ ...entry, id: "REQ-NEW", purpose: "token=must-not-leak", observableOutcome: "password=never-export" })) });
    // Read-only projection fixture: this test inspects export denominators, not ledger acceptance.
    const planning = structuredClone(projection.planning!);
    (planning as { plan: NonNullable<typeof planning.plan> }).plan = { ...planning.plan!, currentRevisionId: revision.revisionId, currentDigest: revision.digest, revisionsById: { ...planning.plan!.revisionsById, [revision.revisionId]: revision } };
    const current = { ...projection, planning };
    const readiness = f.runtime.planningReadiness();
    const exported = buildPlanningExportDocument({ runId: "run", projection: current, readiness: { ...readiness, blockers: Array.from({ length: 100 }, (_, i) => `blocker-${i} token=never-export`), sourceSectionIds: Array(100).fill("s".repeat(1000)) }, exportedAt: T7B_CLOCK });
    assert.deepEqual(exported.requirements.items.map((entry) => entry.id), ["REQ-NEW"]);
    assert.ok(!JSON.stringify(exported).includes("REQ-1\""));
    assert.ok(!JSON.stringify(exported).includes("must-not-leak")); assert.ok(!JSON.stringify(exported).includes("never-export"));
    assert.equal(exported.snapshot.digestValid, true);
    assert.equal(exported.readiness.blocked, true); assert.equal(exported.readiness.blockers.omittedCount, 70);
    assert.ok(Buffer.byteLength(JSON.stringify(exported)) <= PLANNING_EXPORT_MAX_BYTES);
    assert.equal(exported.readiness.sourceSectionIds.omittedCount, 70);
  } finally { f.cleanup(); }
});

test("T7b browser client: explicit option and owner identities travel unchanged without submit-time reads", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport: typeof fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); };
  const connection = { url: "http://127.0.0.1:8787", token: "local-control" };
  const start: ExplicitStartRequestV1 = { version: 1, planRevisionId: "displayed-plan", planDigest: "a".repeat(64), sourceManifestId: "displayed-source", sourceArtifactDigest: "b".repeat(64), planningPolicyVersion: 1, projectDocsPolicyVersion: 2, ownerChoice: "execute", idempotencyKey: "owner-start" };
  const source = { approvedSource: sourceInput("owner-approved"), idempotencyKey: "approve" };
  await registerNativePlanningSource(connection, "run", source, transport);
  await startNativeReadyPlan(connection, "run", start, transport);
  await selectNativeArchitectHandoff(connection, "run", "model", "handoff", transport, undefined, 21);
  await selectNativeVerifierRuntime(connection, "run", "model", "selection", transport, undefined, 25);
  await assert.rejects(selectNativeArchitectHandoff(connection, "run", "model", "handoff", transport));
  assert.equal(calls.length, 4, "answer submission never re-reads current authority");
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), start);
  assert.deepEqual(JSON.parse(calls[2]!.init.body as string), { runtimeId: "model", idempotencyKey: "handoff", requiredSequence: 21 });
  assert.deepEqual(JSON.parse(calls[3]!.init.body as string), { runtimeId: "model", idempotencyKey: "selection", requiredSequence: 25 });
  await getNativePlanningReadiness(connection, "run", transport); await exportNativePlanning(connection, "run", transport);
  const amendment = { ...sourceInput("approved amendment"), predecessorManifestId: "manifest-before", predecessorArtifactDigest: "a".repeat(64), amendmentId: "a1", rationale: "owner rationale", impact: { addsSectionIds: [], retiresSectionIds: [], addsRequirementIds: [], retiresRequirementIds: [] }, idempotencyKey: "amend" };
  await amendNativePlanningSource(connection, "run", amendment, transport);
  assert.deepEqual(JSON.parse(calls.at(-1)!.init.body as string), amendment);
  assert.ok(calls.every((call) => (call.init.headers as Record<string, string>).Authorization === "Bearer local-control"));
});

test("T7b interrupted source/start append: exact retry completes only the missing resume once", async () => {
  for (const kind of ["source", "start"] as const) {
    const f = controlFixture(`interrupted-${kind}`);
    const original = f.store.append.bind(f.store);
    try {
      if (kind === "start") await f.seedReady();
      const request = kind === "start" ? f.start() : undefined;
      f.runtime.pause(kind === "source" ? "planning_source_missing" : "plan_start_required", "control-pause");
      f.store.append = (event) => { if (event.type === "run.resumed") throw new Error("simulated crash before resume append"); return original(event); };
      await assert.rejects(kind === "source" ? f.approve() : f.runtime.authorizeExplicitPlanStart(request!), /simulated crash/);
      f.store.append = original;
      const authority = f.store.readRun("run_t7b_controls").filter((event) => event.type === (kind === "source" ? "planning.source_registered" : "planning.execution_authorized"));
      assert.equal(authority.length, 1); assert.equal(f.runtime.projection().status, "paused");
      await (kind === "source" ? f.approve() : f.runtime.authorizeExplicitPlanStart(request!));
      assert.equal(f.runtime.projection().status, "running");
      assert.deepEqual(f.store.readRun("run_t7b_controls").filter((event) => event.type === authority[0]!.type), authority);
      const after = f.evidence(); await (kind === "source" ? f.approve() : f.runtime.authorizeExplicitPlanStart(request!)); assert.deepEqual(f.evidence(), after);
      assert.equal(after.events.filter((event) => event.type === "run.resumed").length, 1);
    } finally { f.store.append = original; f.cleanup(); }
  }
});

test("T7b historical terminal HTTP: real factory reader serves readiness/export without inventing coverage or mutating logs", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7b-historical-"));
  const project = join(root, "project"), state = join(root, "state"), runId = "old-terminal";
  mkdirSync(project, { recursive: true }); mkdirSync(state, { recursive: true });
  const specs = new SqliteBuildSpecStore(join(root, "specs.sqlite"));
  const spec: import("../src/build-spec.js").NativeBuildSpec = { version: 2, runId, projectId: "old-project", objective: "Old completed request.", architectRuntimeId: "arch:architect", workerRuntimeIds: ["work:worker"], verifierRuntimeIds: ["rev:reviewer"], alwaysRequireIndependentVerifier: false, maxConcurrency: 1, permissionProfile: "full", runPolicy: "finish", budgetLimits: {}, createdAt: T7B_CLOCK, idempotencyKey: "old-spec" };
  specs.save(spec);
  const schedulerPath = join(state, "builds", runnerRunStateSegment(runId), "scheduler.sqlite");
  const scheduler = new SqliteSchedulerStore(schedulerPath);
  scheduler.append({ runId, type: "run.initialized", occurredAt: T7B_CLOCK, actor: { role: "runner", id: "old-runner" }, idempotencyKey: "init", payload: { objective: spec.objective } });
  const before = scheduler.readRun(runId); scheduler.close();
  const supervisor = new RunSupervisor(new SqliteEventStore(join(root, "events.sqlite")), { clock: () => T7B_CLOCK });
  supervisor.createRun({ runId, projectPath: project, permissionProfile: "full", idempotencyKey: "create" }); const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId }); supervisor.captureBaseline(runId, "baseline", baseline.revision, baseline.ref); supervisor.start(runId, "start"); supervisor.complete(runId, "completed");
  const beforeSupervisor = supervisor.events(runId);
  const factory = new FixtureNativeBuildFactory({ projectRoot: project, stateDirectory: state, providerConfigs: { load: () => [], save: () => undefined, close: () => undefined }, baselineFor: () => "a".repeat(40), providerModelFactory: () => { throw new Error("historical must not load models"); } });
  const manager = new NativeBuildManager({ specs, createRuntime: async () => { throw new Error("must not construct live runtime"); }, shouldRecoverSpec: () => false, terminalStateForHistoricalSpec: () => supervisor.getRun(runId).state as "completed", createHistoricalRuntime: (saved, terminal) => factory.createHistorical(saved, terminal) });
  const server = new ControlServer({ supervisor, token: "historical-control", builds: manager });
  try {
    const report = await manager.recover(); assert.deepEqual(report.failures, []);
    const address = await server.start(0);
    for (const endpoint of ["planning-readiness", "planning-export"]) {
      const response = await fetch(`${address.url}/v2/runs/${runId}/build/${endpoint}`, { headers: { Authorization: "Bearer historical-control" } });
      assert.equal(response.status, 200, await response.clone().text());
      const payload = await response.json() as Record<string, unknown>;
      if (endpoint === "planning-readiness") assert.equal(payload.status, "not_opted_in");
      else { assert.equal((payload.readiness as PlanningReadinessSnapshot).status, "not_opted_in"); assert.equal((payload.snapshot as { digestValid: boolean }).digestValid, true); }
    }
    const reread = new SqliteSchedulerStore(schedulerPath, { readOnly: true });
    try { assert.deepEqual(reread.readRun(runId), before); } finally { reread.close(); }
    assert.deepEqual(supervisor.events(runId), beforeSupervisor);
    assert.equal(manager.projection(runId).planningPolicyVersion, undefined);
    await assert.rejects(manager.registerPlanningSource(runId, { approvedSource: sourceInput("owner"), idempotencyKey: "mutate" }), /read-only/);
  } finally { await server.close(); await manager.close(); await factory.close(); supervisor.close(); rmSync(root, { recursive: true, force: true }); }
});
