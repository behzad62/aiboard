import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ControlServer } from "../src/control-server.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import { buildExecutionPlanRevision, type ExecutionPlanPhase, type ExecutionTaskContract, type SourceRequirement } from "../src/planning-contracts.js";
import { NativeBuildFactory as FixtureNativeBuildFactory, captureGitBaseline, runGit } from "./support/git-fixture.js";
import { buildApprovedSourceManifest, validateApprovedSourceInput, type ApprovedSourceInputV1 } from "../src/native-planning-provisioner.js";
import { currentExplicitStartIdentity, rebuildSchedulerProjection, reduceSchedulerEvent, testIntegrityBoundaryIsCurrent, type SchedulerProjection } from "../src/scheduler-store.js";
import { computeArtifactDigest } from "../src/source-manifest.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { runnerRunStateSegment } from "../src/run-state-identity.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";

function sourceBytes(text: string): Uint8Array { return new Uint8Array(Buffer.from(text, "utf8")); }
function sourceInput(text: string, sections?: ApprovedSourceInputV1["sections"]): ApprovedSourceInputV1 { return { version: 1, approval: "approved_spec", bytesBase64: Buffer.from(text).toString("base64"), mediaType: "text/plain", encoding: "utf-8", ...(sections !== undefined ? { sections } : {}) }; }

const E1_RUN = "run_e1_product_journey";
const E1_CLOCK = "2026-10-02T00:00:00.000Z";
const E1_SOURCE = "SECTION s1: MANDATORY. The value module must export the value 2.\r\nSECTION s2: OPERATIONAL. Maintain the value behavior and its tests; caf\u00e9 stays byte-exact.\r\n";
const E1_LOW_CONTENT = "export const value = 2;\n";
const E1_VALUE_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value', () => assert.equal(value, 2)); test('witness', () => assert.ok(value >= 0));\n";

function e1JourneySections(): [{ id: string; startByte: number; endByte: number }, { id: string; startByte: number; endByte: number }] {
  const firstEnd = Buffer.byteLength(`${E1_SOURCE.split("\n")[0]!}\n`, "utf8");
  return [
    { id: "s1", startByte: 0, endByte: firstEnd },
    { id: "s2", startByte: firstEnd, endByte: Buffer.byteLength(E1_SOURCE, "utf8") },
  ];
}

function e1JourneyScenario(runId: string, includeSecond = false) {
  const bytes = sourceBytes(E1_SOURCE);
  const validated = validateApprovedSourceInput(sourceInput(E1_SOURCE, [...e1JourneySections()]));
  const manifest = buildApprovedSourceManifest({
    runId,
    validated,
    artifactDigest: computeArtifactDigest(bytes),
    approvedBy: "local-user",
    createdAt: E1_CLOCK,
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
    scope: { includes: ["src/value.mjs", "test/value.test.mjs", "package.json"], excludes: ["docs/project/STATE.md"] },
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
    scope: { includes: ["src/value.mjs", "test/value.test.mjs", "package.json"], excludes: [] },
    writableSurfaces: ["src/value.mjs", "test/value.test.mjs", "package.json"],
    forbiddenSurfaces: ["docs/project/STATE.md"],
    dependencies: [],
    requiredBase: "accepted plan revision revision_e1",
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
    revisionId: "revision_e1",
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: E1_CLOCK,
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

class E1JourneyArchitect implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private calls = 0;
  constructor(
    private readonly projection: () => SchedulerProjection,
    private readonly scenario: ReturnType<typeof e1JourneyScenario>,
    private readonly mode: JourneyMode,
  ) {}
  private call(name: string, args: unknown): ModelTurn {
    this.calls += 1;
    return journeyCall(name, args, `e1-arch-${this.calls}`);
  }
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const projection = this.projection();
    const planning = projection.planning;
    if (projection.planningTriageDecision === undefined) {
      return this.call("record_triage", { decision: "build", rationale: "E1 product: change request with an approved source." });
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
      return this.call("request_coverage_review", { reviewId: "coverage_e1" });
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
    if (task.status === "integrated" && this.mode === "architect_reason") {
      const boundary = projection.delivery!.boundaries.T1!.at(-1)!;
      if (!projection.testIntegrity!.exceptions["architect-reason-1"]) return this.call("record_test_integrity_reason", { id: "architect-reason-1", taskId: "T1", reason: "Current ready plan explicitly accepts this smaller suite for the changed value behavior.", allowedChanges: ["suite_shrank"], minimumExecuted: 1 });
      return this.call("resolve_delivery_boundary_failure", { taskId: "T1", boundaryId: boundary.boundaryId, resolution: "recheck", rationale: "Recheck the exact candidate after its current-plan test change reason." });
    }
    throw new Error(`E1 journey script exhausted at T1 ${task.status}.`);
  }
}

type JourneyMode = "unchanged" | "narrowed_script" | "deleted_test" | "reviewed_consolidation" | "bootstrap" | "architect_reason";
const journeyPackage = (mode: JourneyMode) => JSON.stringify({ name: "e1-journey", version: "1.0.0", type: "module", scripts: { test: mode === "narrowed_script" ? "node --test --test-name-pattern=value" : "node --test" } }, null, 2);
const journeyChangedTests = (mode: JourneyMode) => "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value', () => { assert.equal(value, 2);" + (mode === "reviewed_consolidation" ? " assert.ok(value >= 0);" : "") + " });\n";
class E1JourneyWorker implements AgentModel {
  constructor(private readonly mode: JourneyMode) {}
  readonly requests: AgentModelRequest[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const toolCount = request.messages.filter((message) => message.role === "tool").length;
    if (toolCount === 0) return journeyCall("fs.read", { path: "src/value.mjs" }, "read-module");
    if (toolCount === 1) return journeyCall("fs.write", { path: "src/value.mjs", content: E1_LOW_CONTENT, expectedSha256: journeyLastToolValue(request)!.sha256 }, "write-module");
    if (this.mode === "bootstrap") {
      if (toolCount === 2) return journeyCall("fs.write", { path: "package.json", content: journeyPackage("unchanged") }, "bootstrap-package");
      if (toolCount === 3) return journeyCall("fs.write", { path: "test/value.test.mjs", content: E1_VALUE_TEST, createDirectories: true }, "bootstrap-tests");
    } else if (this.mode !== "unchanged") {
      const path = this.mode === "narrowed_script" ? "package.json" : "test/value.test.mjs";
      if (toolCount === 2) return journeyCall("fs.read", { path }, "read-test-controls");
      if (toolCount === 3) return journeyCall("fs.write", { path, expectedSha256: journeyLastToolValue(request)!.sha256, content: this.mode === "narrowed_script" ? journeyPackage(this.mode) : journeyChangedTests(this.mode) }, "change-tests");
    }
    if (toolCount === (this.mode === "unchanged" ? 2 : 4)) return journeyCall("run_evidence_command", { label: "tests", command: process.execPath, args: ["--test"] }, "evidence-1");
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

class E1JourneyReviewer implements AgentModel {
  constructor(private readonly mode: JourneyMode) {}
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
      if (seen === 1 && this.mode === "reviewed_consolidation") return journeyCall("fs.read", { path: "test/value.test.mjs" }, "read-tests-1");
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
    let testConsolidation: Record<string, unknown> | undefined;
    if (this.mode === "reviewed_consolidation") {
      const marker = "Runner test-integrity baseline and candidate fingerprints (observational; no automatic exception):\n";
      const start = text.indexOf(marker);
      assert.ok(start >= 0, "independent review receives runner-bound fingerprints");
      const reference = JSON.parse(text.slice(start + marker.length).split("\nIf tests")[0]!) as Record<string, unknown>;
      testConsolidation = { id: "consolidation-1", disposition: "merged", affectedTestIds: ["witness"], behaviorProof: "test/value.test.mjs: value now asserts both value equality and nonnegative witness", reason: "Witness behavior remains explicitly asserted in the merged value test.", planRevisionId: reference.planRevisionId, planDigest: reference.planDigest, baselinePinDigest: reference.baselinePinDigest, candidatePinDigest: reference.candidatePinDigest, allowedChanges: ["suite_shrank"], minimumExecuted: 1 };
    }
    return journeyCall("submit_deliverable_verdict", {
      ...(testConsolidation ? { testConsolidation } : {}),
      summary: "The module exports 2 and the cited test run passed.",
      satisfied: true,
      claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Confirmed in the checkout." })),
    }, `verdict-${seen}`);
  }
}

function e1Provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}


describe("E1 product journey", { concurrency: 2 }, () => {
for (const mode of ["unchanged", "narrowed_script", "deleted_test", "reviewed_consolidation", "bootstrap", "architect_reason"] as const) {
  test(`E1 product: real factory test integrity ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "aiboard-e1-journey-"));
    const project = join(root, "project"); const state = join(root, "state");
    mkdirSync(join(project, "test"), { recursive: true }); mkdirSync(join(project, "src"), { recursive: true }); mkdirSync(state, { recursive: true });
    if (mode !== "bootstrap") {
      writeFileSync(join(project, "package.json"), journeyPackage("unchanged"));
      writeFileSync(join(project, "test/value.test.mjs"), E1_VALUE_TEST);
    }
    writeFileSync(join(project, "src/value.mjs"), "export const value = 1;\n");
    const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: E1_RUN });
    const executionHost = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
    const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")), { clock: () => E1_CLOCK });
    let server: ControlServer | undefined; let factory: FixtureNativeBuildFactory | undefined; let manager: NativeBuildManager | undefined;
    let runtime: { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection } | undefined;
    try {
      const worker = new E1JourneyWorker(mode); const reviewer = new E1JourneyReviewer(mode);
      const architect = new E1JourneyArchitect(() => runtime!.projection(), e1JourneyScenario(E1_RUN), mode);
      factory = new FixtureNativeBuildFactory({ projectRoot: project, stateDirectory: state,
        providerConfigs: { load: () => [e1Provider("arch:architect", 1), e1Provider("work:worker", 2), e1Provider("rev:reviewer", 3)], save: () => undefined, close: () => undefined }, executionHost, baselineFor: () => baseline.revision,
        providerModelFactory: (config) => config.runtimeId === "arch:architect" ? architect : config.runtimeId === "work:worker" ? worker : reviewer });
      manager = new NativeBuildManager({ specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")), createRuntime: (spec) => factory!.create(spec).then((handle) => { runtime = handle.runtime as typeof runtime; return handle; }), prepareSpec: (spec, options) => factory!.prepareSpec(spec, options) });
      server = new ControlServer({ supervisor, token: "e1-control-token", builds: manager, buildProvisioner: manager, checkGit: async () => ({ available: true, version: "fixture-git", code: "git_ready", reason: null }), bootstrapRun: async () => ({ baselineRevision: baseline.revision, baselineRef: baseline.ref }) });
      const address = await server.start(0);
      const body = { runId: E1_RUN, projectPath: project, permissionProfile: "full", idempotencyKey: "e1-journey", build: { projectId: "e1-journey-fixture", objective: "Deliver the value module.", architectRuntimeId: "arch:architect", workerRuntimeIds: ["work:worker"], verifierRuntimeIds: ["rev:reviewer"], alwaysRequireIndependentVerifier: false, maxConcurrency: 1, runPolicy: "finish", budgetLimits: {}, planningPolicy: { version: 1 }, specCopy: false, handoffFiles: "export_only" } };
      const create = () => fetch(`${address.url}/v2/runs`, { method: "POST", headers: { Authorization: "Bearer e1-control-token", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const created = await create(); assert.equal(created.status, 201, await created.text());
      const original = manager.events(E1_RUN);
      const retry = await create(); assert.equal(retry.status, 201, await retry.text()); assert.deepEqual(manager.events(E1_RUN), original, "fresh prefix retries exactly");
      assert.equal(original[1]!.payload.testIntegrityPolicyVersion, 1);
      assert.equal(runtime!.projection().testIntegrity!.initialRevision, baseline.revision);
      const control = (path: string, input: unknown) => fetch(`${address.url}/v2/runs/${E1_RUN}/build/${path}`, { method: "POST", headers: { Authorization: "Bearer e1-control-token", "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const approve = await control("source", { approvedSource: sourceInput(E1_SOURCE, [...e1JourneySections()]), idempotencyKey: "approve-source" }); assert.equal(approve.status, 200, await approve.text());
      const stepUntil = async (label: string, done: (p: SchedulerProjection) => boolean) => {
        for (let step = 0; step < 200; step++) { const p = runtime!.projection(); if (done(p)) return p; if (p.status === "paused" || p.status === "failed") throw new Error(`${label}: ${p.status} ${JSON.stringify(p.pauseReason)}`); await runtime!.step(); }
        throw new Error(`${label}: not reached`);
      };
      await stepUntil("ready", (p) => p.planning?.readiness === "ready"); assert.equal(worker.requests.length, 0);
      const start = await control("plan-start", { ...currentExplicitStartIdentity(runtime!.projection()), version: 1, ownerChoice: "execute", idempotencyKey: "explicit-start" }); assert.equal(start.status, 200, await start.text());
      const p = await stepUntil("boundary", (p) => !!p.delivery?.boundaries.T1?.length);
      const boundary = p.delivery!.boundaries.T1!.at(-1)!;
      const initial = manager.events(E1_RUN).find((event) => event.type === "delivery.test_integrity_baseline_recorded")!;
      assert.ok(initial);
      const initialBaseline = p.testIntegrity!.baseline!;
      if (mode === "bootstrap") { assert.equal(initialBaseline.kind, "no_configured_test_suite"); assert.ok(!("executed" in initialBaseline)); assert.ok(!("report" in initialBaseline)); }
      else { assert.ok(initialBaseline.kind === "executed_report"); assert.equal(initialBaseline.executed, 2); assert.deepEqual(initialBaseline.report.counts, { selected: 2, passed: 1, failed: 1, skipped: 0 }); }
      const raw = boundary.checks.find((check) => check.checkId === "tests")!; const guard = boundary.checks.find((check) => check.checkId === "test_integrity")!;
      assert.equal(boundary.testIntegrity!.baselineRevision, baseline.revision);
      const green = mode === "unchanged" || mode === "reviewed_consolidation" || mode === "bootstrap";
      if (mode === "narrowed_script") { assert.equal(raw.outcome, "unknown"); assert.equal(raw.report!.runner, "not_run"); assert.match(guard.reason!, /command|configuration/i); }
      else { assert.equal(raw.outcome, "passed"); assert.equal(raw.report!.counts!.passed, (mode === "unchanged" || mode === "bootstrap") ? 2 : 1); }
      assert.equal(guard.outcome, green ? "passed" : "failed"); assert.equal(boundary.passed, green);
      if (mode === "deleted_test" || mode === "architect_reason") assert.match(guard.reason!, /2→1/);
      assert.equal(p.testIntegrity!.baseline!.pin.revision, baseline.revision, "unaccepted candidate cannot promote trusted baseline");
      assert.equal(!!p.delivery!.reviews.T1!.testConsolidation, mode === "reviewed_consolidation");
      if (green) {
        assert.equal(testIntegrityBoundaryIsCurrent(p, boundary), true);
        const stale: SchedulerProjection = { ...p, planning: { ...p.planning!, plan: { ...p.planning!.plan!, currentRevisionId: "foreign-plan" } } };
        assert.equal(testIntegrityBoundaryIsCurrent(stale, boundary), false);
        assert.throws(() => reduceSchedulerEvent(stale, { runId: E1_RUN, eventId: "forged-accept", sequence: stale.lastSequence + 1, type: "task.acceptance_recorded", occurredAt: E1_CLOCK, actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "forged-accept", payload: { taskId: "T1", reviewId: p.delivery!.reviews.T1!.reviewId, boundaryId: boundary.boundaryId } }), /acceptance|boundary|review/i);
        const accepted = await stepUntil("accepted", (p) => !!p.delivery?.taskAcceptances.T1);
        assert.equal(accepted.testIntegrity!.baseline!.pin.revision, accepted.integrationRevision);
        const acceptedBaseline = accepted.testIntegrity!.baseline!; assert.ok(acceptedBaseline.kind === "executed_report");
        assert.equal(acceptedBaseline.executed, (mode === "unchanged" || mode === "bootstrap") ? 2 : 1);
        assert.equal(accepted.testIntegrity!.baseline!.acceptedTaskId, "T1");
      } else {
        assert.equal(p.delivery!.taskAcceptances.T1, undefined);
        if (mode === "architect_reason") {
          const reasonEvent = { runId: E1_RUN, eventId: "forged-reason", sequence: p.lastSequence + 1, type: "delivery.test_integrity_exception_recorded" as const, occurredAt: E1_CLOCK, actor: { role: "architect" as const, id: "foreign" }, idempotencyKey: "forged-reason", payload: { id: "foreign-reason", taskId: "T1", reason: "Override", allowedChanges: ["suite_shrank"], minimumExecuted: 1 } };
          assert.throws(() => reduceSchedulerEvent(p, reasonEvent), /bound Architect/);
          const stalePlan: SchedulerProjection = { ...p, planning: { ...p.planning!, plan: { ...p.planning!.plan!, currentDigest: "f".repeat(64) } } };
          assert.throws(() => reduceSchedulerEvent(stalePlan, { ...reasonEvent, actor: { role: "architect", id: p.testIntegrity!.architectActorId! } }), /current failed identity-bound boundary and plan/);
          const checked = manager.events(E1_RUN).findLast((event) => event.type === "delivery.boundary_checked")!;
          const beforeChecked = rebuildSchedulerProjection(manager.events(E1_RUN).filter((event) => event.sequence < checked.sequence));
          assert.throws(() => reduceSchedulerEvent(beforeChecked, { ...checked, payload: { ...checked.payload, passed: true, checks: boundary.checks.map((check) => check.checkId === "test_integrity" ? { ...check, outcome: "passed", exitCode: 0 } : check) } }), /outcome must match kernel recomputation/);
          const accepted = await stepUntil("Architect exact reason and acceptance", (p) => !!p.delivery?.taskAcceptances.T1);
          assert.equal(accepted.delivery!.boundaries.T1!.length, 2);
          assert.equal(accepted.delivery!.boundaries.T1!.at(-1)!.checks.find((check) => check.checkId === "test_integrity")!.outcome, "passed");
          assert.equal(accepted.testIntegrity!.exceptions["architect-reason-1"]!.planDigest, accepted.delivery!.boundaries.T1!.at(-1)!.testIntegrity!.planDigest);
          assert.equal(accepted.delivery!.boundaries.T1!.at(-1)!.testIntegrity!.exceptionId, "architect-reason-1");
          assert.equal(accepted.testIntegrity!.baseline!.acceptedTaskId, "T1");
        }
      }
      const events = manager.events(E1_RUN); const replay = rebuildSchedulerProjection(events);
      assert.deepEqual(replay.testIntegrity, runtime!.projection().testIntegrity, "durable replay preserves exact trusted denominator and authority");
      const runRoot = join(state, "builds", runnerRunStateSegment(E1_RUN));
      const reopenedEvidence = new SqliteEvidenceStore(join(runRoot, "evidence.sqlite"), { readOnly: true });
      const reopened = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"), { readOnly: true, evidenceStore: reopenedEvidence, artifacts: new ArtifactStore(join(state, "artifacts")) });
      try { assert.deepEqual(reopened.readRun(E1_RUN), events, "SQLite reopen revalidates every exact baseline/boundary authority and artifact"); }
      finally { reopened.close(); reopenedEvidence.close(); }
      assert.ok(reviewer.requests.some((request) => JSON.stringify(request).includes("Runner test-integrity baseline")));
      assert.equal((await runGit({ cwd: project, args: ["rev-parse", "HEAD"] })).stdout.trim(), baseline.revision, "owner checkout remains unchanged");
    } catch (error) {
      const worktrees = (await runGit({ cwd: project, args: ["worktree", "list", "--porcelain"] })).stdout;
      const deltas = [];
      for (const match of worktrees.matchAll(/^HEAD ([a-f0-9]+)$/gm)) deltas.push({ revision: match[1], diff: (await runGit({ cwd: project, args: ["diff", "--binary", baseline.revision, match[1]!, "--"] })).stdout });
      writeFileSync(join(tmpdir(), `codex-e1-fixture-debug-${mode}.json`), JSON.stringify({ mode, root, worktrees, deltas, projection: runtime?.projection(), events: manager?.events(E1_RUN).slice(-20) }, null, 2));
      throw error;
    } finally { await server?.close(); supervisor.close(); await manager?.close(); await factory?.close(); await executionHost.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
});
