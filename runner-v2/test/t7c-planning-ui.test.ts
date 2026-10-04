import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
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
import { currentExplicitStartIdentity, type SchedulerProjection } from "../src/scheduler-store.js";
import { computeArtifactDigest, type ApprovedSourceManifest } from "../src/source-manifest.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { validateSourceAmendmentRequest, type ExplicitStartRequestV1, type PlanningReadinessSnapshot, type PlanningExportDocument } from "../src/planning-controls.js";
import { seedBoundCoverageAndReady, seedDurableSourceReads } from "./support/planning-seed.js";
import { buildFixtureHostCapabilities } from "./fixtures/planning-source-fixture.js";
import { buildAssignmentClaim } from "../src/task-resource-claims.js";

function sourceBytes(text: string): Uint8Array { return new Uint8Array(Buffer.from(text, "utf8")); }
function sourceInput(text: string, sections?: ApprovedSourceInputV1["sections"]): ApprovedSourceInputV1 { return { version: 1, approval: "approved_spec", bytesBase64: Buffer.from(text).toString("base64"), mediaType: "text/plain", encoding: "utf-8", ...(sections !== undefined ? { sections } : {}) }; }

const T7C_RUN = "run_t7c_product_journey";
const T7C_CLOCK = "2026-10-02T00:00:00.000Z";
const T7C_SOURCE = "SECTION s1: MANDATORY. The value module must export the value 2.\r\nSECTION s2: OPERATIONAL. Keep the change to src/value.mjs only; caf\u00e9 stays byte-exact.\r\n";
const T7C_LOW_CONTENT = "export const value = 2;\n";
const T7C_VALUE_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value', () => assert.equal(value, 2));\n";

function t7cJourneySections(): [{ id: string; startByte: number; endByte: number }, { id: string; startByte: number; endByte: number }] {
  const firstEnd = Buffer.byteLength(`${T7C_SOURCE.split("\n")[0]!}\n`, "utf8");
  return [
    { id: "s1", startByte: 0, endByte: firstEnd },
    { id: "s2", startByte: firstEnd, endByte: Buffer.byteLength(T7C_SOURCE, "utf8") },
  ];
}

function t7cJourneyScenario(runId: string, includeSecond = false) {
  const bytes = sourceBytes(T7C_SOURCE);
  const validated = validateApprovedSourceInput(sourceInput(T7C_SOURCE, [...t7cJourneySections()]));
  const manifest = buildApprovedSourceManifest({
    runId,
    validated,
    artifactDigest: computeArtifactDigest(bytes),
    approvedBy: "local-user",
    createdAt: T7C_CLOCK,
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
    requiredBase: "accepted plan revision revision_t7c",
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
  if (includeSecond) {
    requirements[0] = { ...requirements[0]!, contributingTaskIds: ["T1", "T2"] };
    phases[0] = { ...phases[0]!, contributingTaskIds: ["T1", "T2"] };
    tasks.push({ ...tasks[0]!, id: "T2", outcome: { user: "Create the independent other module.", system: "The other module exists." }, writableSurfaces: ["src/other.mjs"], scope: { includes: ["src/other.mjs"], excludes: ["test/value.test.mjs"] }, outputs: ["src/other.mjs"] });
  }
  const revision = buildExecutionPlanRevision({
    revisionId: "revision_t7c",
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: T7C_CLOCK,
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

class T7cJourneyArchitect implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private calls = 0;
  constructor(
    private readonly projection: () => SchedulerProjection,
    private readonly scenario: ReturnType<typeof t7cJourneyScenario>,
  ) {}
  private call(name: string, args: unknown): ModelTurn {
    this.calls += 1;
    return journeyCall(name, args, `t7c-arch-${this.calls}`);
  }
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const projection = this.projection();
    const planning = projection.planning;
    if (projection.planningTriageDecision === undefined) {
      return this.call("record_triage", { decision: "build", rationale: "T7c product: change request with an approved source." });
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
      return this.call("request_coverage_review", { reviewId: "coverage_t7c" });
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
    throw new Error(`T7c journey script exhausted at T1 ${task.status}.`);
  }
}

class T7cJourneyWorker implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const toolCount = request.messages.filter((message) => message.role === "tool").length;
    if (toolCount === 0) return journeyCall("fs.write", { path: "src/value.mjs", content: T7C_LOW_CONTENT, createDirectories: true }, "write-1");
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

class T7cJourneyReviewer implements AgentModel {
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

function t7cProvider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

test("T7c product: unseeded opt-in provisioning plans, covers, builds, and accepts through the real factory", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PlanningRecordView } = await import(pathToFileURL(join(process.cwd(), "components/NativePlanningPanel.tsx")).href);
  const { displayedPlanStart } = await import(pathToFileURL(join(process.cwd(), "lib/client/native-planning-view.ts")).href);
  const { startNativeReadyPlan, getNativeContextManifests, getNativePlanningSchedule } = await import(pathToFileURL(join(process.cwd(), "lib/client/runner-v2.ts")).href);
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7c-journey-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "t7c-journey-fixture", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(project, "test", "value.test.mjs"), T7C_VALUE_TEST);
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: T7C_RUN });
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
  });
  const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")), { clock: () => T7C_CLOCK });
  let server: ControlServer | undefined;
  let factory: FixtureNativeBuildFactory | undefined;
  let manager: NativeBuildManager | undefined;
  let runtime: { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection } | undefined;
  try {
    const worker = new T7cJourneyWorker();
    const reviewer = new T7cJourneyReviewer();
    const architect = new T7cJourneyArchitect(() => runtime!.projection(), t7cJourneyScenario(T7C_RUN));
    factory = new FixtureNativeBuildFactory({
      projectRoot: project,
      stateDirectory: state,
      providerConfigs: {
        load: () => [t7cProvider("arch:architect", 1), t7cProvider("work:worker", 2), t7cProvider("rev:reviewer", 3)],
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
    server = new ControlServer({ supervisor, token: "t7c-control-token",
      builds: manager, buildProvisioner: manager,
      checkGit: async () => ({ available: true, version: "fixture-git", code: "git_ready", reason: null }),
      bootstrapRun: async () => ({ baselineRevision: baseline.revision, baselineRef: baseline.ref }),
    });
    const address = await server.start(0);
    const body = { runId: T7C_RUN, projectPath: project, permissionProfile: "full",
      idempotencyKey: "t7c-journey", build: {
        projectId: "t7c-journey-fixture", objective: "Deliver the value module.",
        architectRuntimeId: "arch:architect", workerRuntimeIds: ["work:worker"], verifierRuntimeIds: ["rev:reviewer"],
        alwaysRequireIndependentVerifier: false, maxConcurrency: 1, runPolicy: "finish", budgetLimits: {},
        planningPolicy: { version: 1 }, specCopy: false, handoffFiles: "export_only", answerReview: true,
      } };
    const create = () => fetch(`${address.url}/v2/runs`, { method: "POST",
      headers: { Authorization: "Bearer t7c-control-token", "Content-Type": "application/json" },
      body: JSON.stringify(body) });
    const created = await create();
    assert.equal(created.status, 201, await created.text());
    const originalEvents = manager.events(T7C_RUN);
    const savedSpec = manager.listSpecs()[0]!;
    assert.equal(savedSpec.specCopy, false); assert.equal(savedSpec.handoffFiles, "export_only"); assert.equal(savedSpec.answerReview, true);
    assert.equal(originalEvents.filter((event) => event.type === "answer.review_opted_in").length, 1);
    assert.deepEqual(originalEvents.find((event) => event.type === "answer.review_opted_in")!.actor, { role: "user", id: "local-user" });
    const changed = await fetch(`${address.url}/v2/runs`, { method: "POST", headers: { Authorization: "Bearer t7c-control-token", "Content-Type": "application/json" }, body: JSON.stringify({ ...body, build: { ...body.build, answerReview: false } }) });
    assert.equal(changed.status, 409, "same creation with changed answer-review choice refuses");
    assert.deepEqual(manager.events(T7C_RUN), originalEvents);
    const retry = await create();
    assert.equal(retry.status, 201, await retry.text());
    assert.deepEqual(manager.events(T7C_RUN), originalEvents, "HTTP retry reuses exact saved approval and policy");
    // The first three scheduler events are the T7c prefix, before factory consumers.
    let events = manager.events(T7C_RUN);
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
    const control = (path: string, input?: unknown, token = "t7c-control-token") => fetch(`${address.url}/v2/runs/${T7C_RUN}/build/${path}`, { method: input === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
    const approve = { approvedSource: sourceInput(T7C_SOURCE, [...t7cJourneySections()]), idempotencyKey: "approve-source" };
    const denied = await control("source", approve, "wrong-token");
    assert.equal(denied.status, 401);
    const approved = await control("source", approve);
    assert.equal(approved.status, 200, await approved.text());
    events = manager.events(T7C_RUN);
    const afterApprove = [...events];
    assert.equal((await control("source", approve)).status, 200);
    assert.deepEqual(manager.events(T7C_RUN), afterApprove);
    const saved = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
    try { assert.equal(saved.get(T7C_RUN).approvedSource, undefined, "initial saved spec is immutable and source-free"); } finally { saved.close(); }
    // The kernel registered the explicitly approved source immutably.
    const registered = events.find((event) => event.type === "planning.source_registered")!;
    assert.ok(registered, "the approved source is registered");
    assert.deepEqual(registered.actor, { role: "user", id: "local-user" });
    const manifest = (registered.payload as { manifest: ApprovedSourceManifest }).manifest;
    const expectedDigest = createHash("sha256").update(T7C_SOURCE, "utf8").digest("hex");
    assert.equal(manifest.artifactDigest, expectedDigest);
    assert.equal(manifest.byteLength, Buffer.byteLength(T7C_SOURCE, "utf8"));
    assert.equal(manifest.authority, "user:local-user");
    const storedBytes = await new ArtifactStore(join(state, "artifacts")).get(expectedDigest);
    assert.deepEqual(Buffer.from(storedBytes).toString("utf8"), T7C_SOURCE);
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
    const beforePreview = manager.events(T7C_RUN);
    const readyResponse = await control("planning-readiness");
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as PlanningReadinessSnapshot;
    assert.equal(ready.status, "ready_start_required");
    const exportedResponse = await control("planning-export");
    assert.equal(exportedResponse.status, 200);
    const exported = await exportedResponse.json() as PlanningExportDocument;
    assert.equal(exported.snapshot.digestValid, true);
    assert.ok(exported.snapshot.text.includes("REQ-1"));
    assert.deepEqual(manager.events(T7C_RUN), beforePreview);
    assert.equal(worker.requests.length, 0);
    const start = displayedPlanStart(ready, "start-current");
    const beforeRender = manager.events(T7C_RUN);
    const packs = await getNativeContextManifests({ url: address.url, token: "t7c-control-token" }, T7C_RUN);
    const schedule = await getNativePlanningSchedule({ url: address.url, token: "t7c-control-token" }, T7C_RUN);
    assert.ok(schedule); assert.equal(schedule.lastSequence, runtime!.projection().lastSequence);
    assert.equal((await control("planning-schedule", undefined, "wrong-token")).status, 401);
    const html = renderToStaticMarkup(React.createElement(PlanningRecordView, { projection: runtime!.projection(), readiness: ready, manifests: packs, usage: manager.usage(T7C_RUN), schedule }));
    assert.match(html, /Plan ready — delivery incomplete/);
    assert.match(html, /Requirements: 0 accepted \/ 1 applicable/);
    assert.match(html, /REQ-1/); assert.match(html, /Phase incomplete/); assert.match(html, /distinct_model/);
    assert.match(html, /coverage:derive/); assert.match(html, /coverage:verdict/); assert.match(html, /estimated tokens/);
    assert.ok(packs.length > 0); assert.deepEqual(manager.events(T7C_RUN), beforeRender, "GET + rendering do not authorize or dispatch");
    assert.equal(worker.requests.length, 0);
    assert.equal(runtime!.projection().specCopy, false); assert.equal(runtime!.projection().handoffFiles, "export_only");
    assert.equal((await control("plan-start", { ...start, planDigest: "f".repeat(64) })).status, 409);
    assert.equal((await control("plan-start", { ...start, ownerChoice: "preview" })).status, 400);
    assert.equal((await control("plan-start", start, "wrong-token")).status, 401);
    assert.deepEqual(manager.events(T7C_RUN), beforePreview);
    const awaitingStart = await runtime!.step();
    assert.equal(awaitingStart.action, "plan_start_required");
    assert.equal(worker.requests.length, 0);
    await startNativeReadyPlan({ url: address.url, token: "t7c-control-token" }, T7C_RUN, start);
    const afterStart = manager.events(T7C_RUN);
    assert.equal((await control("plan-start", start)).status, 200);
    assert.deepEqual(manager.events(T7C_RUN), afterStart);
    assert.equal(worker.requests.length, 0, "authorizing does not itself dispatch");
    const accepted = await stepUntil(
      "task acceptance",
      () => manager!.events(T7C_RUN).some((event) => event.type === "task.acceptance_recorded"),
    );
    events = manager.events(T7C_RUN);
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
    assert.equal(delivered, T7C_LOW_CONTENT);
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
    const acceptedHtml = renderToStaticMarkup(React.createElement(PlanningRecordView, { projection: accepted, readiness: manager.planningReadiness(T7C_RUN), manifests: manager.contextManifests(T7C_RUN), usage: manager.usage(T7C_RUN) }));
    assert.match(acceptedHtml, /Current delivery review/); assert.match(acceptedHtml, /Boundary/); assert.match(acceptedHtml, /selection rung/);
    assert.doesNotMatch(acceptedHtml, /Delivery complete/, "one accepted task is not program completion");
    assert.equal(events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0, "export_only never writes a stop snapshot");
  } finally {
    await server?.close();
    supervisor.close();
    await manager?.close().catch(() => undefined);
    await factory?.close().catch(() => undefined);
    await executionHost?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});



function controlFixture(label: string, architectDriver?: import("../src/build-runtime.js").ArchitectRuntimeDriver) {
  const root = mkdtempSync(join(tmpdir(), `aiboard-t7c-${label}-`));
  let clocks = 0;
  const clock = () => new Date(Date.parse(T7C_CLOCK) + ++clocks * 1000).toISOString();
  mkdirSync(join(root, "artifacts"), { recursive: true });
  const artifacts = new ArtifactStore(join(root, "artifacts"), { clock });
  let store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { artifacts });
  let workers = 0, allocations = 0;
  const constructRuntime = () => new BuildRuntime({ runId: "run_t7c_controls", initialObjective: "Deliver the value module.", specCreatedAt: T7C_CLOCK,
    planningPolicy: { version: 1 }, store, artifacts, clock, maxConcurrency: 1,
    architectDriver: architectDriver ?? { run: async () => { throw new Error("unexpected model effect"); } },
    workerDriver: { run: async () => { workers++; return { type: "paused", reason: "test-stop" }; } },
    integrationDriver: { integrate: async () => { throw new Error("unexpected integration effect"); } },
    workspaceFor: async () => { allocations++; return root; },
  });
  let runtime = constructRuntime();
  const append = (type: import("../src/scheduler-store.js").SchedulerEventType, key: string, payload: Record<string, unknown>, role: "architect" | "runner" | "user" = "architect", id = role === "user" ? "local-user" : "architect_1") => store.append({ runId: "run_t7c_controls", type, idempotencyKey: key, actor: { role, id }, occurredAt: T7C_CLOCK, payload });
  const approve = () => runtime.registerPlanningSource({ approvedSource: sourceInput(T7C_SOURCE, [...t7cJourneySections()]), idempotencyKey: "initial-owner-source" });
  const seedReady = async (includeSecond = false) => {
    await approve();
    append("request.triaged", "triage", { decision: "build", rationale: "The fixture is a change request." });
    const scenario = t7cJourneyScenario("run_t7c_controls", includeSecond);
    append("planning.ledger_persisted", "ledger", { id: "ledger", requirements: scenario.requirements, phases: scenario.phases, nonNormativeSections: [] });
    seedDurableSourceReads(store, "run_t7c_controls", scenario.manifest, T7C_CLOCK);
    append("planning.plan_drafted", "draft", { revision: scenario.revision, expectedRevisionId: null, expectedDigest: null });
    const review: CoverageReview = { id: "coverage-cheap", runId: "run_t7c_controls", reviewerRuntimeId: "rev:reviewer", independence: "distinct_model", sourceReadManifestId: scenario.manifest.manifestId,
      planRevisionId: scenario.revision.revisionId, planRevisionDigest: scenario.revision.digest,
      derivedObligations: [{ id: "obl", requirementId: "REQ-1", description: "Export value 2.", recordedBeforePlanOrDiffProvided: true, recordedAt: T7C_CLOCK }],
      obligationVerdicts: [{ obligationId: "obl", verdict: "covered", severity: "advisory", rationale: "T1 covers the source.", evidenceRefs: ["ledger:REQ-1"] }], findings: [], recordedAt: T7C_CLOCK };
    seedBoundCoverageAndReady(store, "run_t7c_controls", { revision: scenario.revision, manifest: scenario.manifest, review, hostCapabilities: buildFixtureHostCapabilities(), occurredAt: T7C_CLOCK });
    return scenario;
  };
  const start = (): ExplicitStartRequestV1 => ({ version: 1, ...currentExplicitStartIdentity(runtime.projection())!, ownerChoice: "execute", idempotencyKey: "execute-owner" });
  const amendment = (overrides: Record<string, unknown> = {}) => validateSourceAmendmentRequest({ ...sourceInput(T7C_SOURCE.replace("value 2", "value 3"), [...t7cJourneySections()]), predecessorManifestId: runtime.projection().planning!.source.currentManifestId,
    predecessorArtifactDigest: runtime.projection().planning!.source.artifactDigest, amendmentId: "amend-1", rationale: "The owner changes the approved specification.", impact: { addsSectionIds: [], retiresSectionIds: [], addsRequirementIds: [], retiresRequirementIds: [] }, idempotencyKey: "owner-amendment", ...overrides });
  const evidence = () => ({ events: store.readRun("run_t7c_controls"), files: readdirSync(join(root, "artifacts"), { recursive: true }), clocks, workers, allocations });
  return { root, artifacts, get store() { return store; }, get runtime() { return runtime; }, append, approve, seedReady, start, amendment, evidence,
    reopen: () => { store.close(); store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { artifacts }); runtime = constructRuntime(); },
    cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("T7c view proof: a ready plan renders incomplete delivery with the real recorded requirement denominator", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PlanningRecordView } = await import(pathToFileURL(join(process.cwd(), "components/NativePlanningPanel.tsx")).href);
  const f = controlFixture("view-proof");
  try {
    await f.seedReady();
    const before = f.evidence();
    const projection = f.runtime.projection();
    const schedule = f.runtime.planningSchedule();
    const html = renderToStaticMarkup(React.createElement(PlanningRecordView, { projection, schedule, readiness: f.runtime.planningReadiness() }));
    assert.match(html, /Plan ready — delivery incomplete/);
    assert.doesNotMatch(html, /Delivery complete/);
    assert.match(html, /0 accepted \/ 1 applicable/);
    assert.match(html, /Requirement incomplete/); assert.match(html, /REQ-1-ac1/);
    assert.match(html, /Current coverage review/); assert.match(html, /explicit owner start/);
    assert.match(html, /worker admission blocked/); assert.doesNotMatch(html, /next eligible worker candidate/);
    assert.deepEqual(f.evidence(), before, "render + schedule/readiness observation has no effects");
    await f.runtime.authorizeExplicitPlanStart(f.start());
    const started = f.runtime.planningSchedule();
    assert.equal(started.tasks.find((task) => task.taskId === "T1")?.eligible, true);
  } finally { f.cleanup(); }
});

test("T7c review consent: opt-out survives SQLite reopen, exact retry has no effects and unavailable review clears", async () => {
  const f = controlFixture("review-consent");
  try {
    await f.runtime.setAnswerReview(true, "owner-review-on");
    const before = f.evidence();
    await f.runtime.setAnswerReview(true, "owner-review-on"); assert.deepEqual(f.evidence(), before);
    await assert.rejects(f.runtime.setAnswerReview(false, "owner-review-on"), /idempotency conflict/);
    assert.deepEqual(f.evidence(), before);
    f.append("request.triaged", "answer-triage", { decision: "answer", rationale: "Only an explanation is requested." });
    f.append("request.answered", "answer", { answerText: "The cache key omits the lockfile.", addressedParts: ["Why the cache is stale"] });
    const gated = await f.runtime.step();
    assert.equal(gated.action, "answer_reviewer_unavailable");
    assert.equal(f.runtime.projection().status, "paused");
    await f.runtime.setAnswerReview(false, "owner-review-off");
    assert.equal(f.runtime.projection().status, "running");
    assert.equal(f.runtime.projection().answerReviewUnavailable, undefined);
    assert.equal(f.runtime.projection().answerReviewOptIn, undefined);
    const after = f.evidence(); await f.runtime.setAnswerReview(false, "owner-review-off"); assert.deepEqual(f.evidence(), after);
    f.reopen();
    assert.equal(f.runtime.projection().answerReviewOptIn, undefined);
    assert.equal(f.runtime.projection().requestAnswer?.answerText, "The cache key omits the lockfile.");
    assert.equal(f.evidence().workers, 0); assert.equal(f.evidence().allocations, 0);
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { PlanningRecordView } = await import(pathToFileURL(join(process.cwd(), "components/NativePlanningPanel.tsx")).href);
    const html = renderToStaticMarkup(React.createElement(PlanningRecordView, { projection: f.runtime.projection() }));
    assert.match(html, /Answered request/); assert.match(html, /cache key omits the lockfile/); assert.match(html, /Why the cache is stale/);
    assert.doesNotMatch(html, /Delivery complete/);
  } finally { f.cleanup(); }
});

test("T7c UI options: fresh planning is opt-in; approved defaults and locked-run uncertainty are explicit", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BuildRunPolicyControl } = await import(pathToFileURL(join(process.cwd(), "components/BuildRunPolicyControl.tsx")).href);
  const value = { runPolicy: "finish", skillMode: "balanced", budgetUsd: 0, timeLimitMinutes: 0, alwaysRequireIndependentVerifier: false };
  const fresh = renderToStaticMarkup(React.createElement(BuildRunPolicyControl, { value, onChange: () => undefined }));
  assert.match(fresh, /aria-checked="false"[^>]*id="build-evidence-planning"/);
  assert.doesNotMatch(fresh, /id="build-spec-copy"/);
  const optedIn = renderToStaticMarkup(React.createElement(BuildRunPolicyControl, { value: { ...value, evidenceGatedPlanning: true }, onChange: () => undefined }));
  assert.match(optedIn, /aria-checked="true"[^>]*id="build-spec-copy"/);
  assert.match(optedIn, /value="commit" selected=""/);
  const locked = renderToStaticMarkup(React.createElement(BuildRunPolicyControl, { value, onChange: () => undefined, planningOptionsLocked: true }));
  assert.doesNotMatch(locked, /id="build-evidence-planning"/);
  assert.match(locked, /recorded planning options/);
});

test("T7c stale schedule: a different sequence or plan identity never publishes eligibility", async () => {
  const { currentPlanningSchedule } = await import(pathToFileURL(join(process.cwd(), "lib/client/native-planning-view.ts")).href);
  const f = controlFixture("stale-schedule");
  try {
    await f.seedReady(); const projection = f.runtime.projection(); const schedule = f.runtime.planningSchedule();
    assert.equal(currentPlanningSchedule(projection, schedule), schedule);
    for (const changed of [{ ...schedule, runId: "other-run" }, { ...schedule, lastSequence: schedule.lastSequence - 1 }, { ...schedule, planDigest: "f".repeat(64) }, { ...schedule, sourceArtifactDigest: "e".repeat(64) }]) assert.equal(currentPlanningSchedule(projection, changed), undefined);
  } finally { f.cleanup(); }
});

test("T7c provenance: source amendments remain inspectable and legacy runs invent no planning coverage", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PlanningRecordView } = await import(pathToFileURL(join(process.cwd(), "components/NativePlanningPanel.tsx")).href);
  const f = controlFixture("source-provenance");
  try {
    await f.seedReady(); const initial = f.runtime.projection(); const prior = initial.planning!.source.currentManifestId;
    await f.runtime.amendPlanningSource(f.amendment());
    const projection = f.runtime.projection(); const before = f.evidence();
    const html = renderToStaticMarkup(React.createElement(PlanningRecordView, { projection }));
    assert.match(html, /Historical source/); assert.match(html, /Current source/); assert.match(html, /authorized by user:local-user/);
    assert.ok(html.includes(prior)); assert.match(html, /Recorded impact/); assert.match(html, /amend-1/);
    assert.doesNotMatch(html, /Delivery complete/); assert.deepEqual(f.evidence(), before);
    const legacy = renderToStaticMarkup(React.createElement(PlanningRecordView, { projection: { ...initial, planningPolicyVersion: undefined, planning: undefined } }));
    assert.match(legacy, /Planning coverage was not recorded/); assert.doesNotMatch(legacy, /Requirements:|Delivery complete|Requirement accepted/);
  } finally { f.cleanup(); }
});

test("T7c pass usage: recorded tokens and estimated pack sizes stay distinct; ambiguous and missing attribution stays unavailable", async () => {
  const { planningPassRows } = await import(pathToFileURL(join(process.cwd(), "lib/client/native-planning-view.ts")).href);
  const manifest = { manifestId: "manifest-1", runId: "run-1", sessionId: "session-1", actor: { role: "verifier", id: "reviewer" }, role: "verifier", purpose: "coverage:verdict", limits: { maxBytes: 1000, maxEstimatedTokens: 1000 }, packDigest: "a".repeat(64), byteLength: 400, estimatedTokens: 100, sections: [], omissions: [], recordedAt: T7C_CLOCK };
  const reservation = { reservationId: "call-1", kind: "model", attribution: { runtimeId: "reviewer", providerId: "provider", modelId: "model", role: "verifier", sessionId: "session-1" }, estimate: { inputTokens: 100 }, actual: { inputTokens: 8, outputTokens: 4, estimatedCostMicros: 12 }, tokenSources: { inputTokens: "reported", outputTokens: "reported" }, costBasis: { kind: "api_estimate" }, status: "settled", windowIndex: 0 };
  const usage = { scopeId: "run-1", reservations: { "call-1": reservation }, activeSegments: {}, effective: { modelCalls: 1, toolCalls: 0, inputTokens: 8, outputTokens: 4, estimatedCostMicros: 12, activeMs: 0, artifactBytes: 0 }, lastSequence: 1 };
  const row = planningPassRows([manifest], usage)[0];
  assert.equal(row.attributed, true); assert.equal(row.inputTokens, 8); assert.equal(row.outputTokens, 4); assert.equal(row.costMicros, 12); assert.equal(row.tokenQuality, "reported");
  assert.equal(row.manifest.estimatedTokens, 100);
  const ambiguous = planningPassRows([manifest, { ...manifest, manifestId: "manifest-2", purpose: "coverage:derive" }], usage);
  assert.equal(ambiguous[0].attributed, false); assert.equal(ambiguous[0].inputTokens, undefined);
  const absent = planningPassRows([manifest], { ...usage, reservations: { "call-1": { ...reservation, actual: { estimatedCostMicros: 12 } } } });
  assert.equal(absent[0].attributed, false); assert.equal(absent[0].inputTokens, undefined);
  const account = planningPassRows([manifest], { ...usage, reservations: { "call-1": { ...reservation, costBasis: { kind: "account_not_metered" } } } });
  assert.equal(account[0].attributed, true); assert.equal(account[0].costMicros, undefined);
});

test("T7c scheduler view: independent unallocated candidates do not invent shared worktree ownership", async () => {
  const f = controlFixture("parallel-view");
  try {
    await f.seedReady(true); await f.runtime.authorizeExplicitPlanStart(f.start());
    const before = f.evidence(); const schedule = f.runtime.planningSchedule();
    assert.deepEqual(schedule.tasks.filter((task) => task.eligible).map((task) => task.taskId).sort(), ["T1", "T2"]);
    assert.deepEqual(schedule.conflicts, []);
    assert.deepEqual(schedule.activeClaims, []); assert.equal(schedule.effectiveMax, 1);
    assert.deepEqual(f.evidence(), before, "advisory candidates allocate and claim nothing");
  } finally { f.cleanup(); }
});

test("T7c scheduler view: an owned assigned restart uses its existing slot and preserves claim identity", async () => {
  const f = controlFixture("restart-view");
  try {
    await f.seedReady(); await f.runtime.authorizeExplicitPlanStart(f.start());
    const claim = buildAssignmentClaim({ packetId: "T1", laneId: "P1", workerOrSessionId: "worker_T1_1", acceptedBaseRevision: "base", branchOrWorktree: f.root, writableSurfaces: [join(f.root, "src/value.mjs")], forbiddenSurfaces: ["test/value.test.mjs"], ownershipGeneration: 1 });
    f.append("planning.assignment_claimed", "assigned-claim", { claim }, "runner", "scheduler");
    f.append("task.transitioned", "task-assigned", { taskId: "T1", status: "assigned", patch: { attempt: 1, assignedWorkerId: "worker_T1_1", workspacePath: f.root } }, "runner", "scheduler");
    f.reopen(); const before = f.evidence(); const schedule = f.runtime.planningSchedule();
    assert.equal(schedule.capacityInUse, 1); assert.equal(schedule.effectiveMax, 1);
    assert.equal(schedule.tasks.find((task) => task.taskId === "T1")?.eligible, true);
    assert.equal(schedule.activeClaims[0]?.id, claim.id); assert.equal(schedule.activeClaims[0]?.ownershipGeneration, 1);
    assert.deepEqual(f.evidence(), before, "read does not reclaim or replace ownership");
  } finally { f.cleanup(); }
});

test("T7c browser controls: switched-run responses and file reads are discarded; source approval never retargets", async () => {
  const { chromium } = await import("@playwright/test");
  const { build } = await import("esbuild");
  const f = controlFixture("browser-races");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await f.seedReady(); const initial = f.runtime.projection();
    const bundle = await build({ bundle: true, write: false, platform: "browser", tsconfig: join(process.cwd(), "tsconfig.json"), define: { "process.env.NODE_ENV": '"development"' }, stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React, {useState} from "react"; import {createRoot} from "react-dom/client";
      import {NativePlanningPanel} from "./components/NativePlanningPanel.tsx";
      const fixture = window.fixture = {observations: [], setProjection: undefined, filePending: false, releaseFile: undefined, delayFile: false};
      const originalRead = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function() { if (fixture.delayFile) { fixture.filePending=true; await new Promise(resolve => fixture.releaseFile=resolve); } return originalRead.call(this); };
      function Harness() { const [projection, setProjection] = useState(${JSON.stringify(initial)}); fixture.setProjection=setProjection;
        return <NativePlanningPanel projection={projection} connection={{url: "http://127.0.0.1:9876", token: "fixture-token"}} onProjection={updated => { fixture.observations.push(updated); setProjection(updated); }} />;
      } createRoot(document.getElementById("root")).render(<Harness />);` } });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    let releasePost: (() => void) | undefined;
    let receivedPost!: () => void; const postReceived = new Promise<void>((resolve) => { receivedPost = resolve; });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/fixture") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      if (url.pathname.endsWith("answer-review")) {
        receivedPost(); await new Promise<void>((resolve) => { releasePost = resolve; });
        return route.fulfill({ json: { ...initial, lastSequence: initial.lastSequence + 1, answerReviewOptIn: true } });
      }
      if (url.pathname.endsWith("planning-readiness")) return route.fulfill({ json: f.runtime.planningReadiness() });
      if (url.pathname.endsWith("context-manifests")) return route.fulfill({ json: { manifests: [] } });
      if (url.pathname.endsWith("planning-schedule")) return route.fulfill({ json: { schedule: null } });
      return route.fulfill({ status: 404, json: { error: "unexpected test route" } });
    });
    await page.goto("http://127.0.0.1:9876/fixture"); await page.addScriptTag({ content: bundle.outputFiles![0]!.text });
    await page.getByRole("button", { name: "Request independent answer review", exact: true }).click(); await postReceived;
    await page.evaluate(`window.fixture.setProjection(${JSON.stringify({ ...initial, runId: "run_second" })})`);
    await page.getByRole("button", { name: "Request independent answer review", exact: true }).waitFor({ state: "visible" });
    releasePost!();
    await page.waitForFunction(() => document.querySelector('button') !== null);
    // A subsequent layout commit provides a deterministic barrier after the old response.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.evaluate("window.fixture.observations.length"), 0, "old-run POST cannot replace the new run");
    await page.getByText("Approve a source amendment", { exact: true }).click();
    await page.evaluate("window.fixture.delayFile=true");
    await page.locator('input[type="file"]').setInputFiles({ name: "source.txt", mimeType: "text/plain", buffer: Buffer.from("Old file read must be discarded.") });
    await page.waitForFunction("window.fixture.filePending");
    await page.evaluate(`window.fixture.setProjection(${JSON.stringify({ ...initial, runId: "run_third" })})`);
    await page.evaluate("window.fixture.releaseFile(); window.fixture.delayFile=false");
    await page.getByText("Approve a source amendment", { exact: true }).click();
    assert.equal(await page.getByText("Old file read must be discarded.", { exact: true }).count(), 0);
    await page.locator('input[type="file"]').setInputFiles({ name: "source.md", mimeType: "text/markdown", buffer: Buffer.from("New owner document.") });
    await page.getByText("New owner document.", { exact: true }).waitFor();
    await page.getByLabel("Reason for amendment", { exact: true }).fill("Owner changes specification.");
    await page.getByRole("checkbox", { name: /I approve this exact document/ }).check();
    assert.equal(await page.getByRole("button", { name: "Approve amendment", exact: true }).isEnabled(), true);
    const drifted = structuredClone(initial); drifted.runId = "run_third"; drifted.lastSequence++;
    const oldManifest = drifted.planning!.source.manifestsById[drifted.planning!.source.currentManifestId]!;
    drifted.planning = { ...drifted.planning!, source: { ...drifted.planning!.source, currentManifestId: "source_changed", manifestsById: { ...drifted.planning!.source.manifestsById, source_changed: { ...oldManifest, manifestId: "source_changed", artifactDigest: "f".repeat(64) } } } };
    await page.evaluate(`window.fixture.setProjection(${JSON.stringify(drifted)})`);
    await page.waitForFunction(() => !(document.querySelector('input[type="checkbox"]') as HTMLInputElement)?.checked);
    assert.equal(await page.getByRole("button", { name: "Approve amendment", exact: true }).isEnabled(), false, "changed predecessor requires a fresh explicit approval");
  } finally { await browser?.close(); f.cleanup(); }
});

test("T7c browser configuration: fresh options persist while attached saved policy remains unchanged", async () => {
  const { chromium } = await import("@playwright/test"); const { build } = await import("esbuild");
  // Provider credential fallbacks are lazy, unused external transports here;
  // the configuration journey exercises the real browser store and API.
  const bundle = await build({ bundle: true, write: false, platform: "browser", external: ["node:fs", "node:path"], tsconfig: join(process.cwd(), "tsconfig.json"), stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
    import {createDiscussion, updateDiscussionConfig} from "./lib/client/api";
    import {initStore, getDiscussionById, updateDiscussion} from "./lib/client/store";
    import {explicitNativePlanningOptions} from "./lib/client/native-build-policy";
    void (async () => { await initStore();
    const input={topic:"Explain and improve the value module.", mode:"build", effort:50, modelIds:["openai:model"]};
    const fresh=createDiscussion(input); const defaults=getDiscussionById(fresh.id);
    const opted=createDiscussion({...input, buildEvidenceGatedPlanning:true, buildSpecCopy:false, buildHandoffFiles:"export_only", buildAnswerReview:true});
    const before=getDiscussionById(opted.id);
    updateDiscussion(opted.id,{nativeBuildRequestedAt:null});
    const saved=updateDiscussionConfig(opted.id,{effort:50,modelIds:input.modelIds,buildEvidenceGatedPlanning:false,buildSpecCopy:true,buildHandoffFiles:"commit",buildAnswerReview:false});
    const selected=explicitNativePlanningOptions({planningPolicy:{version:1},specCopy:before.buildSpecCopy,handoffFiles:before.buildHandoffFiles,answerReview:before.buildAnswerReview});
    let refused=false; try { explicitNativePlanningOptions({approvedSource:{version:1,approval:"approved_spec",bytesBase64:"eA==",mediaType:"text/plain",encoding:"utf-8"}}); } catch { refused=true; }
    window.configResult={defaults,before,saved,selected,refused,legacy:explicitNativePlanningOptions({specCopy:false,answerReview:true,handoffFiles:"export_only"})};
    })().catch(error => window.configError=String(error));` } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<body></body>" }));
    await page.goto("http://127.0.0.1:9876/fixture"); await page.addScriptTag({ content: bundle.outputFiles![0]!.text });
    await page.waitForFunction("window.configResult !== undefined || window.configError !== undefined");
    assert.equal(await page.evaluate("window.configError"), undefined);
    type StoredPlanningOptions = { buildEvidenceGatedPlanning?: boolean; buildSpecCopy?: boolean; buildHandoffFiles?: "commit" | "export_only"; buildAnswerReview?: boolean };
    const result = await page.evaluate("window.configResult") as { defaults: StoredPlanningOptions; before: StoredPlanningOptions; saved: StoredPlanningOptions; selected: unknown; refused: boolean; legacy: unknown };
    assert.equal(result.defaults.buildEvidenceGatedPlanning, false); assert.equal(result.defaults.buildSpecCopy, true); assert.equal(result.defaults.buildHandoffFiles, "commit"); assert.equal(result.defaults.buildAnswerReview, false);
    for (const field of ["buildEvidenceGatedPlanning", "buildSpecCopy", "buildHandoffFiles", "buildAnswerReview"] as const) assert.equal(result.saved[field], result.before[field]);
    assert.deepEqual(result.selected, { planningPolicy: { version: 1 }, answerReview: true, specCopy: false, handoffFiles: "export_only" });
    assert.equal(result.refused, true); assert.deepEqual(result.legacy, {});
  } finally { await browser.close(); }
});
