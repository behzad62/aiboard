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
import { buildExecutionPlanRevision, validateExecutionTaskContract, type ExecutionPlanPhase, type ExecutionTaskContract, type SourceRequirement, type CoverageReview } from "../src/planning-contracts.js";
import { NativeBuildFactory as FixtureNativeBuildFactory, captureGitBaseline, runGit } from "./support/git-fixture.js";
import { buildApprovedSourceManifest, validateApprovedSourceInput, type ApprovedSourceInputV1 } from "../src/native-planning-provisioner.js";
import { currentExplicitStartIdentity, type SchedulerProjection } from "../src/scheduler-store.js";
import { computeArtifactDigest, type ApprovedSourceManifest } from "../src/source-manifest.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { validateSourceAmendmentRequest, type ExplicitStartRequestV1, type PlanningReadinessSnapshot, type PlanningExportDocument } from "../src/planning-controls.js";
import { seedBoundCoverageAndReady, seedDurableSourceReads } from "./support/planning-seed.js";
import { buildFixtureHostCapabilities } from "./fixtures/planning-source-fixture.js";
import { buildPlanningReferenceExport } from "../src/planning-export.js";
import { buildPlanningExportDocument } from "../src/planning-controls.js";
import { verifyHandoffSnapshotDigest } from "../src/handoff-snapshot.js";

function sourceBytes(text: string): Uint8Array { return new Uint8Array(Buffer.from(text, "utf8")); }
function sourceInput(text: string, sections?: ApprovedSourceInputV1["sections"]): ApprovedSourceInputV1 { return { version: 1, approval: "approved_spec", bytesBase64: Buffer.from(text).toString("base64"), mediaType: "text/plain", encoding: "utf-8", ...(sections !== undefined ? { sections } : {}) }; }

const T7D_RUN = "run_t7d_product_journey";
const T7D_CLOCK = "2026-10-02T00:00:00.000Z";
const T7D_SOURCE = "SECTION s1: MANDATORY. The value module must export the value 2.\r\nSECTION s2: OPERATIONAL. Keep the change to src/value.mjs only; caf\u00e9 stays byte-exact.\r\n";
const T7D_LOW_CONTENT = "export const value = 2;\n";
const T7D_VALUE_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value', () => assert.equal(value, 2));\n";

function t7dJourneySections(): [{ id: string; startByte: number; endByte: number }, { id: string; startByte: number; endByte: number }] {
  const firstEnd = Buffer.byteLength(`${T7D_SOURCE.split("\n")[0]!}\n`, "utf8");
  return [
    { id: "s1", startByte: 0, endByte: firstEnd },
    { id: "s2", startByte: firstEnd, endByte: Buffer.byteLength(T7D_SOURCE, "utf8") },
  ];
}

function t7dJourneyScenario(runId: string, includeSecond = false) {
  const bytes = sourceBytes(T7D_SOURCE);
  const validated = validateApprovedSourceInput(sourceInput(T7D_SOURCE, [...t7dJourneySections()]));
  const manifest = buildApprovedSourceManifest({
    runId,
    validated,
    artifactDigest: computeArtifactDigest(bytes),
    approvedBy: "local-user",
    createdAt: T7D_CLOCK,
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
    requiredBase: "accepted plan revision revision_t7d",
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
    revisionId: "revision_t7d",
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: T7D_CLOCK,
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

function t7dToolResults(request: AgentModelRequest): Array<{ toolName?: string; isError?: boolean }> {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => message.content as { toolName?: string; isError?: boolean });
}
function t7dToolFailed(request: AgentModelRequest, toolName: string): boolean {
  return t7dToolResults(request).some((result) => result.toolName === toolName && result.isError === true);
}
function t7dFailureDetail(request: AgentModelRequest, toolName: string): string {
  const failed = request.messages
    .filter((message) => message.role === "tool")
    .reverse()
    .find((message) => (message.content as { toolName?: string }).toolName === toolName && (message.content as { isError?: boolean }).isError === true);
  return JSON.stringify(failed?.content).slice(0, 1500);
}
function t7dReadText(request: AgentModelRequest, path: string): string | undefined {
  for (const message of request.messages) {
    if (message.role !== "tool") continue;
    const content = message.content as { toolName?: string; content?: Array<{ type: string; value?: unknown; text?: string }> };
    if (content.toolName !== "fs.read") continue;
    const meta = content.content?.find((item) => item.type === "json")?.value as { path?: string } | undefined;
    if (meta?.path !== path) continue;
    const text = content.content?.find((item) => item.type === "text")?.text;
    if (typeof text === "string") return text;
  }
  return undefined;
}
class T7dJourneyArchitect implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private calls = 0;
  constructor(
    private readonly projection: () => SchedulerProjection,
    private readonly scenario: ReturnType<typeof t7dJourneyScenario>,
  ) {}
  private call(name: string, args: unknown): ModelTurn {
    this.calls += 1;
    return journeyCall(name, args, `t7d-arch-${this.calls}`);
  }
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const projection = this.projection();
    const planning = projection.planning;
    if (projection.planningTriageDecision === undefined) {
      return this.call("record_triage", { decision: "build", rationale: "T7d product: change request with an approved source." });
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
      return this.call("request_coverage_review", { reviewId: "coverage_t7d" });
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
    throw new Error(`T7d journey script exhausted at T1 ${task.status}.`);
  }
}

class T7dJourneyWorker implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    if (t7dToolFailed(request, "submit_task")) {
      throw new Error(`T7d fixture: submit_task refused: ${t7dFailureDetail(request, "submit_task")}`);
    }
    if (t7dToolFailed(request, "run_evidence_command")) {
      throw new Error(`T7d fixture: run_evidence_command failed: ${t7dFailureDetail(request, "run_evidence_command")}`);
    }
    if (t7dToolFailed(request, "fs.write")) {
      throw new Error(`T7d fixture: fs.write failed: ${t7dFailureDetail(request, "fs.write")}`);
    }
    const toolCount = request.messages.filter((message) => message.role === "tool").length;
    if (toolCount === 0) return journeyCall("fs.write", { path: "src/value.mjs", content: T7D_LOW_CONTENT, createDirectories: true }, "write-1");
    if (toolCount === 1) return journeyCall("run_evidence_command", { label: "tests", command: process.execPath, args: ["--test"] }, "evidence-1");
    const record = journeyLastToolValue(request)!;
    const fact = record.fact as { stdoutArtifactHash: string; exitCode: number | null; timedOut?: boolean; cancelled?: boolean };
    assert.equal(fact.exitCode, 0, `the evidence test run must genuinely succeed before the worker claims it passes: ${JSON.stringify(record).slice(0, 1500)}`);
    assert.equal(fact.timedOut ?? false, false, "the evidence test run must not time out");
    assert.equal(fact.cancelled ?? false, false, "the evidence test run must not be cancelled");
    assert.ok(typeof record.id === "string" && record.id.length > 0, "the evidence test run records an evidence id");
    return journeyCall("submit_task", {
      summary: "Added src/value.mjs exporting value = 2; node --test passes.",
      readiness: "ready_for_architect_review",
      unresolvedConcerns: [],
      criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [fact.stdoutArtifactHash] }],
      validationScope: { changed: ["src/value.mjs"], verified: ["src/value.mjs exports value = 2"], testsRun: [{ command: "node --test", counts: { selected: 1, passed: 1, failed: 0, skipped: 0 } }], notRun: [] },
    }, "submit-1");
  }
}

class T7dJourneyReviewer implements AgentModel {
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
      if (t7dToolFailed(request, "fs.read")) {
        throw new Error(`T7d fixture: findings fs.read failed: ${t7dFailureDetail(request, "fs.read")}`);
      }
      if (t7dToolFailed(request, "record_deliverable_findings")) {
        throw new Error(`T7d fixture: record_deliverable_findings refused: ${t7dFailureDetail(request, "record_deliverable_findings")}`);
      }
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
    if (pass === "delivery-verdict-system") {
      if (t7dToolFailed(request, "submit_deliverable_verdict")) {
        throw new Error(`T7d fixture: submit_deliverable_verdict refused: ${t7dFailureDetail(request, "submit_deliverable_verdict")}`);
      }
      if (t7dToolFailed(request, "fs.read")) {
        throw new Error(`T7d fixture: verdict fs.read failed: ${t7dFailureDetail(request, "fs.read")}`);
      }
      const inspected = t7dReadText(request, "src/value.mjs");
      if (inspected === undefined) {
        return journeyCall("fs.read", { path: "src/value.mjs" }, `verdict-read-${seen}`);
      }
      assert.ok(inspected.split("\n")[0]!.includes("export const value = 2;"), "the cited line 1 actually exports value = 2");
      const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
      const survivors = [...new Set([...text.matchAll(/"id"\s*:\s*"(mutation-survivor:[^"]+)"/g)].map((match) => match[1]!))];
      assert.equal(survivors.length, 0, `unexpected mutation survivors on the value line are real gaps and cannot be blanket-released: ${survivors.join(", ")}`);
      const claimIds = [...new Set([...text.matchAll(/"id"\s*:\s*"(claim:[^"]+)"/g)].map((match) => match[1]!))];
      assert.ok(claimIds.includes("claim:c1"), "the verdict context names the criterion claim");
      assert.ok(claimIds.includes("claim:summary"), "the verdict context names the summary claim");
      return journeyCall("submit_deliverable_verdict", {
        summary: "The module exports 2 and the cited test run passed.",
        satisfied: true,
        claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Read src/value.mjs line 1 in this verdict session and confirmed it exports value = 2.", citations: [{ path: "src/value.mjs", line: 1 }] })),
      }, `verdict-${seen}`);
    }
    throw new Error(`Unexpected T7d reviewer system ${pass}.`);
  }
}

function t7dProvider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

test("T7d product: real factory planning and delivery export canonical C1 state, references and copy-ready cards", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PlanningRecordView } = await import(pathToFileURL(join(process.cwd(), "components/NativePlanningPanel.tsx")).href);
  const { displayedPlanStart } = await import(pathToFileURL(join(process.cwd(), "lib/client/native-planning-view.ts")).href);
  const { startNativeReadyPlan, getNativeContextManifests, getNativePlanningSchedule, exportNativePlanning } = await import(pathToFileURL(join(process.cwd(), "lib/client/runner-v2.ts")).href);
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7d-journey-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "t7d-journey-fixture", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(project, "test", "value.test.mjs"), T7D_VALUE_TEST);
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: T7D_RUN });
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
  });
  const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")), { clock: () => T7D_CLOCK });
  let server: ControlServer | undefined;
  let factory: FixtureNativeBuildFactory | undefined;
  let manager: NativeBuildManager | undefined;
  let runtime: { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection } | undefined;
  try {
    const worker = new T7dJourneyWorker();
    const reviewer = new T7dJourneyReviewer();
    const architect = new T7dJourneyArchitect(() => runtime!.projection(), t7dJourneyScenario(T7D_RUN));
    factory = new FixtureNativeBuildFactory({
      projectRoot: project,
      stateDirectory: state,
      providerConfigs: {
        load: () => [t7dProvider("arch:architect", 1), t7dProvider("work:worker", 2), t7dProvider("rev:reviewer", 3)],
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
    server = new ControlServer({ supervisor, token: "t7d-control-token",
      builds: manager, buildProvisioner: manager,
      checkGit: async () => ({ available: true, version: "fixture-git", code: "git_ready", reason: null }),
      bootstrapRun: async () => ({ baselineRevision: baseline.revision, baselineRef: baseline.ref }),
    });
    const address = await server.start(0);
    const body = { runId: T7D_RUN, projectPath: project, permissionProfile: "full",
      idempotencyKey: "t7d-journey", build: {
        projectId: "t7d-journey-fixture", objective: "Deliver the value module.",
        architectRuntimeId: "arch:architect", workerRuntimeIds: ["work:worker"], verifierRuntimeIds: ["rev:reviewer"],
        alwaysRequireIndependentVerifier: false, maxConcurrency: 1, runPolicy: "finish", budgetLimits: {},
        planningPolicy: { version: 1 }, specCopy: false, handoffFiles: "export_only", answerReview: true,
      } };
    const create = () => fetch(`${address.url}/v2/runs`, { method: "POST",
      headers: { Authorization: "Bearer t7d-control-token", "Content-Type": "application/json" },
      body: JSON.stringify(body) });
    const created = await create();
    assert.equal(created.status, 201, await created.text());
    const originalEvents = manager.events(T7D_RUN);
    const savedSpec = manager.listSpecs()[0]!;
    assert.equal(savedSpec.specCopy, false); assert.equal(savedSpec.handoffFiles, "export_only"); assert.equal(savedSpec.answerReview, true);
    assert.equal(originalEvents.filter((event) => event.type === "answer.review_opted_in").length, 1);
    assert.deepEqual(originalEvents.find((event) => event.type === "answer.review_opted_in")!.actor, { role: "user", id: "local-user" });
    const changed = await fetch(`${address.url}/v2/runs`, { method: "POST", headers: { Authorization: "Bearer t7d-control-token", "Content-Type": "application/json" }, body: JSON.stringify({ ...body, build: { ...body.build, answerReview: false } }) });
    assert.equal(changed.status, 409, "same creation with changed answer-review choice refuses");
    assert.deepEqual(manager.events(T7D_RUN), originalEvents);
    const retry = await create();
    assert.equal(retry.status, 201, await retry.text());
    assert.deepEqual(manager.events(T7D_RUN), originalEvents, "HTTP retry reuses exact saved approval and policy");
    // The first three scheduler events are the T7d prefix, before factory consumers.
    let events = manager.events(T7D_RUN);
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
    assert.deepEqual(events[1]!.payload, { testIntegrityPolicyVersion: 1, submissionScopePolicyVersion: 1, reviewIntegrityPolicyVersion: 1, encodingSafetyPolicyVersion: 1, reviewEvidencePolicyVersion: 1, validationScopePolicyVersion: 1, objective: "Deliver the value module." });
    assert.deepEqual(events[2]!.payload, { version: 1 });
    assert.ok(!events.some((event) => event.type === "planning.source_registered"));
    const control = (path: string, input?: unknown, token = "t7d-control-token") => fetch(`${address.url}/v2/runs/${T7D_RUN}/build/${path}`, { method: input === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
    const approve = { approvedSource: sourceInput(T7D_SOURCE, [...t7dJourneySections()]), idempotencyKey: "approve-source" };
    const denied = await control("source", approve, "wrong-token");
    assert.equal(denied.status, 401);
    const approved = await control("source", approve);
    assert.equal(approved.status, 200, await approved.text());
    events = manager.events(T7D_RUN);
    const afterApprove = [...events];
    assert.equal((await control("source", approve)).status, 200);
    assert.deepEqual(manager.events(T7D_RUN), afterApprove);
    const saved = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
    try { assert.equal(saved.get(T7D_RUN).approvedSource, undefined, "initial saved spec is immutable and source-free"); } finally { saved.close(); }
    // The kernel registered the explicitly approved source immutably.
    const registered = events.find((event) => event.type === "planning.source_registered")!;
    assert.ok(registered, "the approved source is registered");
    assert.deepEqual(registered.actor, { role: "user", id: "local-user" });
    const manifest = (registered.payload as { manifest: ApprovedSourceManifest }).manifest;
    const expectedDigest = createHash("sha256").update(T7D_SOURCE, "utf8").digest("hex");
    assert.equal(manifest.artifactDigest, expectedDigest);
    assert.equal(manifest.byteLength, Buffer.byteLength(T7D_SOURCE, "utf8"));
    assert.equal(manifest.authority, "user:local-user");
    const storedBytes = await new ArtifactStore(join(state, "artifacts")).get(expectedDigest);
    assert.deepEqual(Buffer.from(storedBytes).toString("utf8"), T7D_SOURCE);
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
    const beforePreview = manager.events(T7D_RUN);
    const readyResponse = await control("planning-readiness");
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as PlanningReadinessSnapshot;
    assert.equal(ready.status, "ready_start_required");
    const exportedResponse = await control("planning-export");
    assert.equal(exportedResponse.status, 200);
    const exported = await exportedResponse.json() as PlanningExportDocument;
    assert.equal(exported.snapshot.digestValid, true);
    assert.ok(exported.references, "docs-v2 includes the new bounded reference categories");
    assert.deepEqual(exported.references.categories.map((category) => category.id), ["state", "traceability", "source", "phases", "contracts", "ownership", "evidence", "reviews", "policies", "decisions"]);
    assert.equal(exported.references.nativeLaunch.status, "not_applicable");
    const workerCard = exported.references.cards.find((card) => card.kind === "worker");
    assert.ok(workerCard); assert.match(workerCard.text, /No assignment claim recorded/); assert.match(workerCard.text, /never self-accept/);
    assert.ok(exported.references.categories.find((category) => category.id === "contracts")?.items[0]?.text.includes("src/value.mjs"));
    const { PlanningExportView } = await import(pathToFileURL(join(process.cwd(), "components/PlanningExportView.tsx")).href);
    const exportedViaClient = await exportNativePlanning({ url: address.url, token: "t7d-control-token" }, T7D_RUN);
    assert.equal(exportedViaClient.snapshot.text, exported.snapshot.text, "client and server preserve exact C1 text");
    const exportHtml = renderToStaticMarkup(React.createElement(PlanningExportView, { document: exportedViaClient }));
    assert.match(exportHtml, /Download planning export/); assert.match(exportHtml, /Copy-ready reference cards/); assert.match(exportHtml, /Source, requirement, task and evidence traceability/);
    assert.match(exportHtml, /no task is created or dispatched/);

    assert.ok(exported.snapshot.text.includes("REQ-1"));
    assert.deepEqual(manager.events(T7D_RUN), beforePreview);
    assert.equal(worker.requests.length, 0);
    const start = displayedPlanStart(ready, "start-current");
    const beforeRender = manager.events(T7D_RUN);
    const packs = await getNativeContextManifests({ url: address.url, token: "t7d-control-token" }, T7D_RUN);
    const schedule = await getNativePlanningSchedule({ url: address.url, token: "t7d-control-token" }, T7D_RUN);
    assert.ok(schedule); assert.equal(schedule.lastSequence, runtime!.projection().lastSequence);
    assert.equal((await control("planning-schedule", undefined, "wrong-token")).status, 401);
    const html = renderToStaticMarkup(React.createElement(PlanningRecordView, { projection: runtime!.projection(), readiness: ready, manifests: packs, usage: manager.usage(T7D_RUN), schedule }));
    assert.match(html, /Plan ready — delivery incomplete/);
    assert.match(html, /Requirements: 0 accepted \/ 1 applicable/);
    assert.match(html, /REQ-1/); assert.match(html, /Phase incomplete/); assert.match(html, /distinct_model/);
    assert.match(html, /coverage:derive/); assert.match(html, /coverage:verdict/); assert.match(html, /estimated tokens/);
    assert.ok(packs.length > 0); assert.deepEqual(manager.events(T7D_RUN), beforeRender, "GET + rendering do not authorize or dispatch");
    assert.equal(worker.requests.length, 0);
    assert.equal(runtime!.projection().specCopy, false); assert.equal(runtime!.projection().handoffFiles, "export_only");
    assert.equal((await control("plan-start", { ...start, planDigest: "f".repeat(64) })).status, 409);
    assert.equal((await control("plan-start", { ...start, ownerChoice: "preview" })).status, 400);
    assert.equal((await control("plan-start", start, "wrong-token")).status, 401);
    assert.deepEqual(manager.events(T7D_RUN), beforePreview);
    const awaitingStart = await runtime!.step();
    assert.equal(awaitingStart.action, "plan_start_required");
    assert.equal(worker.requests.length, 0);
    await startNativeReadyPlan({ url: address.url, token: "t7d-control-token" }, T7D_RUN, start);
    const afterStart = manager.events(T7D_RUN);
    assert.equal((await control("plan-start", start)).status, 200);
    assert.deepEqual(manager.events(T7D_RUN), afterStart);
    assert.equal(worker.requests.length, 0, "authorizing does not itself dispatch");
    const accepted = await stepUntil(
      "task acceptance",
      () => manager!.events(T7D_RUN).some((event) => event.type === "task.acceptance_recorded"),
    );
    events = manager.events(T7D_RUN);
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
    assert.equal(delivered, T7D_LOW_CONTENT);
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
    const acceptedHtml = renderToStaticMarkup(React.createElement(PlanningRecordView, { projection: accepted, readiness: manager.planningReadiness(T7D_RUN), manifests: manager.contextManifests(T7D_RUN), usage: manager.usage(T7D_RUN) }));
    assert.match(acceptedHtml, /Current delivery review/); assert.match(acceptedHtml, /Boundary/); assert.match(acceptedHtml, /selection rung/);
    assert.doesNotMatch(acceptedHtml, /Delivery complete/, "one accepted task is not program completion");
    const finalExport: PlanningExportDocument = await exportNativePlanning({ url: address.url, token: "t7d-control-token" }, T7D_RUN);
    const evidenceRecord = finalExport.references!.categories.find((category) => category.id === "evidence")!;
    assert.ok(evidenceRecord.items.some((item) => item.text.includes("criterionEvidenceLinks")));
    assert.ok(finalExport.references!.cards.some((card) => card.kind === "worker" && card.text.includes("generation 1")));

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
  const root = mkdtempSync(join(tmpdir(), `aiboard-t7d-${label}-`));
  let clocks = 0;
  const clock = () => new Date(Date.parse(T7D_CLOCK) + ++clocks * 1000).toISOString();
  mkdirSync(join(root, "artifacts"), { recursive: true });
  const artifacts = new ArtifactStore(join(root, "artifacts"), { clock });
  let store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { artifacts });
  let workers = 0, allocations = 0;
  const constructRuntime = () => new BuildRuntime({ runId: "run_t7d_controls", initialObjective: "Deliver the value module.", specCreatedAt: T7D_CLOCK,
    planningPolicy: { version: 1 }, store, artifacts, clock, maxConcurrency: 1,
    architectDriver: architectDriver ?? { run: async () => { throw new Error("unexpected model effect"); } },
    workerDriver: { run: async () => { workers++; return { type: "paused", reason: "test-stop" }; } },
    integrationDriver: { integrate: async () => { throw new Error("unexpected integration effect"); } },
    workspaceFor: async () => { allocations++; return root; },
  });
  let runtime = constructRuntime();
  const append = (type: import("../src/scheduler-store.js").SchedulerEventType, key: string, payload: Record<string, unknown>, role: "architect" | "runner" | "user" = "architect", id = role === "user" ? "local-user" : "architect_1") => store.append({ runId: "run_t7d_controls", type, idempotencyKey: key, actor: { role, id }, occurredAt: T7D_CLOCK, payload });
  const approve = () => runtime.registerPlanningSource({ approvedSource: sourceInput(T7D_SOURCE, [...t7dJourneySections()]), idempotencyKey: "initial-owner-source" });
  const seedReady = async (includeSecond = false) => {
    await approve();
    append("request.triaged", "triage", { decision: "build", rationale: "The fixture is a change request." });
    const scenario = t7dJourneyScenario("run_t7d_controls", includeSecond);
    append("planning.ledger_persisted", "ledger", { id: "ledger", requirements: scenario.requirements, phases: scenario.phases, nonNormativeSections: [] });
    seedDurableSourceReads(store, "run_t7d_controls", scenario.manifest, T7D_CLOCK);
    append("planning.plan_drafted", "draft", { revision: scenario.revision, expectedRevisionId: null, expectedDigest: null });
    const review: CoverageReview = { id: "coverage-cheap", runId: "run_t7d_controls", reviewerRuntimeId: "rev:reviewer", independence: "distinct_model", sourceReadManifestId: scenario.manifest.manifestId,
      planRevisionId: scenario.revision.revisionId, planRevisionDigest: scenario.revision.digest,
      derivedObligations: [{ id: "obl", requirementId: "REQ-1", description: "Export value 2.", recordedBeforePlanOrDiffProvided: true, recordedAt: T7D_CLOCK }],
      obligationVerdicts: [{ obligationId: "obl", verdict: "covered", severity: "advisory", rationale: "T1 covers the source.", evidenceRefs: ["ledger:REQ-1"] }], findings: [], recordedAt: T7D_CLOCK };
    seedBoundCoverageAndReady(store, "run_t7d_controls", { revision: scenario.revision, manifest: scenario.manifest, review, hostCapabilities: buildFixtureHostCapabilities(), occurredAt: T7D_CLOCK });
    return scenario;
  };
  const start = (): ExplicitStartRequestV1 => ({ version: 1, ...currentExplicitStartIdentity(runtime.projection())!, ownerChoice: "execute", idempotencyKey: "execute-owner" });
  const amendment = (overrides: Record<string, unknown> = {}) => validateSourceAmendmentRequest({ ...sourceInput(T7D_SOURCE.replace("value 2", "value 3"), [...t7dJourneySections()]), predecessorManifestId: runtime.projection().planning!.source.currentManifestId,
    predecessorArtifactDigest: runtime.projection().planning!.source.artifactDigest, amendmentId: "amend-1", rationale: "The owner changes the approved specification.", impact: { addsSectionIds: [], retiresSectionIds: [], addsRequirementIds: [], retiresRequirementIds: [] }, idempotencyKey: "owner-amendment", ...overrides });
  const evidence = () => ({ events: store.readRun("run_t7d_controls"), files: readdirSync(join(root, "artifacts"), { recursive: true }), clocks, workers, allocations });
  return { root, artifacts, get store() { return store; }, get runtime() { return runtime; }, append, approve, seedReady, start, amendment, evidence,
    reopen: () => { store.close(); store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { artifacts }); runtime = constructRuntime(); },
    cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("T7d export parity: docs-v2 keeps exact C1 STATE and docs-v1 receives no invented cards", async () => {
  const f = controlFixture("parity");
  try {
    await f.seedReady(); const before = f.evidence(); const projection = f.runtime.projection();
    const input = { runId: projection.runId, projection, readiness: f.runtime.planningReadiness(), exportedAt: T7D_CLOCK };
    const legacy = buildPlanningExportDocument({ ...input, projection: { ...projection, projectDocsPolicyVersion: 1 } });
    const current = buildPlanningExportDocument({ ...input, projection: { ...projection, projectDocsPolicyVersion: 2 } });
    assert.equal(current.snapshot.text, legacy.snapshot.text); assert.equal(verifyHandoffSnapshotDigest(current.snapshot.text), true);
    assert.ok(current.references); assert.equal(legacy.references, undefined);
    assert.deepEqual(f.evidence(), before, "export has no clock/artifact/event/worker/allocation effects");
  } finally { f.cleanup(); }
});

test("T7d redaction proof: nested export references and cards never expose credential leaves or source bodies", async () => {
  const f = controlFixture("redaction");
  try {
    await f.seedReady(); const projection = structuredClone(f.runtime.projection());
    const revision = projection.planning!.plan!.revisionsById[projection.planning!.plan!.currentRevisionId]!;
    const requirement = { ...revision.requirements[0]!, purpose: "api_key=export-secret-731; preserve source", secret: "nested-credential-913" };
    const changed = { ...revision, requirements: [requirement], tasks: [{ ...revision.tasks[0]!, requiredBase: "base authorization=card-secret-452" }] };
    projection.planning = { ...projection.planning!, plan: { ...projection.planning!.plan!, revisionsById: { ...projection.planning!.plan!.revisionsById, [revision.revisionId]: changed } } };
    projection.finalVerification = { history: [], current: {
      generationId: "final-1", taskId: "final-task", targetRevision: "revision-1", planVersion: 1, state: "current",
      executionProfile: { commands: { tests: [{ environment: { CUSTOM_CONFIG: "private-environment-sentinel" } }] } },
      completedChecks: [{ category: "browser", status: "passed", green: true, attempt: 1, evidenceIds: ["evidence-1"],
        facts: [{ console: "private-console-sentinel", pageError: "private-page-error-sentinel" }], issues: ["private-issue-sentinel"] }],
    } as unknown as NonNullable<SchedulerProjection["finalVerification"]>["history"][number] };
    const result = buildPlanningReferenceExport(projection); const text = JSON.stringify(result);
    assert.doesNotMatch(text, /export-secret-731|nested-credential-913|card-secret-452|private-environment-sentinel|private-console-sentinel|private-page-error-sentinel|private-issue-sentinel/);
    assert.match(text, /REDACTED/); assert.doesNotMatch(text, /bytesBase64|BEGIN PRIVATE KEY|messages|environment/);
    assert.ok(result.categories.find((category) => category.id === "source")?.items[0]?.text.includes("artifactDigest"));
  } finally { f.cleanup(); }
});

test("T7d repaired cards: phase and execution lane stay distinct and released claims grant no work", async () => {
  const f = controlFixture("card-ownership");
  try {
    await f.seedReady(); const projection = structuredClone(f.runtime.projection());
    const task = projection.planning!.plan!.revisionsById[projection.planning!.plan!.currentRevisionId]!.tasks[0]!;
    projection.planning = { ...projection.planning!, assignments: { "claim-old": { status: "released", recoveryStatus: "verified", claim: {
      id: "claim-old", packetId: task.id, laneId: "actual-lane", workerOrSessionId: "worker-old", acceptedBaseRevision: "base-old",
      branchOrWorktree: "worktree-old", ownershipGeneration: 3, state: "released", writableSurfaces: [], forbiddenSurfaces: [],
    } } } };
    let result = buildPlanningReferenceExport(projection); let card = result.cards.find((entry) => entry.kind === "worker")!;
    assert.match(card.text, /accountable phase/); assert.match(card.text, /Historical\/non-executable: claim claim-old; lane actual-lane; worktree worktree-old/);
    assert.match(card.text, /Next action: Obtain one verified current exclusive claim/);
    assert.ok(card.reference.selector.endsWith("/tasks/0"));
    assert.equal(card.reference.path, `/v2/runs/${projection.runId}/build`);
    const previous = projection.planning!.assignments["claim-old"]!;
    projection.planning = { ...projection.planning!, assignments: { "claim-old": { ...previous, status: "claimed", claim: { ...previous.claim, state: "claimed" } } } };
    result = buildPlanningReferenceExport(projection); card = result.cards.find((entry) => entry.kind === "worker")!;
    assert.match(card.text, /Claimed; verify recovery/); assert.match(card.text, /Wait for the owner's explicit start/);
  } finally { f.cleanup(); }
});

test("T7d repaired privacy boundary: validator-retained sidecars stay out of every exported record", async () => {
  const f = controlFixture("retained-sidecars");
  try {
    await f.seedReady(); const projection = structuredClone(f.runtime.projection());
    const plan = projection.planning!.plan!; const original = plan.revisionsById[plan.currentRevisionId]!;
    const sidecars = { environment: { CUSTOM_CONFIG: "t7d-unknown-env-private-sentinel" }, messages: [{ role: "user", content: "t7d-unknown-transcript-private-sentinel" }],
      sourceBytes: "t7d-private-source-bytes", nestedExtension: { stdout: "t7d-private-stdout", consoleEvents: ["t7d-private-console"], body: "t7d-private-body" } };
    const task = { ...original.tasks[0]!, ...sidecars };
    assert.equal(validateExecutionTaskContract(task).valid, true, "accepted extension fields are a real export boundary");
    const manifests = Object.fromEntries(Object.entries(projection.planning!.source.manifestsById).map(([key, value]) => [key, { ...value, ...sidecars }]));
    projection.planning = { ...projection.planning!, source: { ...projection.planning!.source, manifestsById: manifests },
      coverageReview: { ...projection.planning!.coverageReview!, ...sidecars },
      plan: { ...plan, revisionsById: { ...plan.revisionsById, [original.revisionId]: { ...original, tasks: [task], requirements: original.requirements.map((value) => ({ ...value, ...sidecars })), phases: original.phases.map((value) => ({ ...value, ...sidecars })) } } } };
    projection.verifierPolicy = { mode: "risk_based", candidateRuntimeIds: ["reviewer-1"], alwaysRequireIndependentVerifier: true, twoPass: true, ...sidecars };
    const exported = buildPlanningExportDocument({ runId: projection.runId, projection, readiness: f.runtime.planningReadiness(), exportedAt: T7D_CLOCK });
    assert.doesNotMatch(JSON.stringify(exported), /t7d-unknown-env-private-sentinel|t7d-unknown-transcript-private-sentinel|t7d-private-source-bytes|t7d-private-stdout|t7d-private-console|t7d-private-body/);
    assert.ok(exported.references!.categories.find((entry) => entry.id === "contracts")!.items[0]!.text.includes(task.steps[0]!));
    assert.equal(exported.references!.categories.find((entry) => entry.id === "contracts")!.items[0]!.omittedSidecarCount, 6);
  } finally { f.cleanup(); }
});

test("T7d repaired limits: joint document budget preserves C1, current source and mandatory resume cards", async () => {
  const f = controlFixture("joint-budget");
  try {
    await f.seedReady(); const projection = structuredClone(f.runtime.projection());
    let planning = projection.planning!; const original = planning.source.manifestsById[planning.source.currentManifestId]!;
    const manifestIds = Array.from({ length: 16 }, (_, index) => `manifest-${index}`);
    planning = { ...planning, source: { ...planning.source, manifestHistoryIds: manifestIds,
      manifestsById: Object.fromEntries(manifestIds.map((id) => [id, { ...original, manifestId: id,
        sections: Array.from({ length: 25 }, (_, index) => ({ ...original.sections[0]!, id: `section-${index}-${"a".repeat(150)}` })) }])),
      currentManifestId: manifestIds.at(-1)! } };
    const revision = planning.plan!.revisionsById[planning.plan!.currentRevisionId]!;
    planning = { ...planning, plan: { ...planning.plan!, revisionsById: { ...planning.plan!.revisionsById, [revision.revisionId]: { ...revision, tasks: Array.from({ length: 75 }, (_, index) => ({ ...revision.tasks[0]!, id: `TASK-${index}`, steps: ["x".repeat(9000)] })) } } } };
    projection.planning = planning;
    const input = { runId: projection.runId, projection, readiness: f.runtime.planningReadiness(), exportedAt: T7D_CLOCK };
    const legacy = buildPlanningExportDocument({ ...input, projection: { ...projection, projectDocsPolicyVersion: 1 } });
    assert.ok(Buffer.byteLength(JSON.stringify(legacy)) > 90 * 1024, "valid legacy display envelope is near the total limit");
    const exported = buildPlanningExportDocument({ ...input, projection: { ...projection, projectDocsPolicyVersion: 2 } });
    assert.ok(Buffer.byteLength(JSON.stringify(exported)) <= 128 * 1024);
    assert.equal(exported.snapshot.text, legacy.snapshot.text);
    assert.equal(exported.sourceManifests.items.length + exported.sourceManifests.omittedCount, 16);
    assert.equal(exported.references!.categories.find((entry) => entry.id === "source")!.items[0]!.id, manifestIds.at(-1));
    projection.planning = { ...planning, readiness: "not_ready" };
    const small = buildPlanningReferenceExport(projection, 12 * 1024);
    assert.ok(small.cards.some((card) => card.kind === "controller")); assert.ok(small.cards.some((card) => card.kind === "resume_planning"));
    assert.equal(small.cards.filter((card) => card.kind === "worker").length + small.omittedCardCount, 75);
    for (const category of small.categories) { assert.equal(category.items.length + category.omittedCount, category.recordCount); assert.equal(category.reference.method, "GET"); }
  } finally { f.cleanup(); }
});

test("T7d repaired policy references: recorded verifier selection, findings, releases and integration remain inspectable", async () => {
  const f = controlFixture("policies");
  try {
    await f.seedReady(); const projection = structuredClone(f.runtime.projection());
    projection.integrationRevision = "integration-recorded";
    projection.verifierPolicy = { mode: "risk_based", candidateRuntimeIds: ["reviewer-1"], alwaysRequireIndependentVerifier: true, twoPass: true };
    projection.verifierSelection = { status: "selected", reason: "recorded selection", requiredCapabilities: [], candidateRuntimeIds: ["reviewer-1"], selectedRuntimeId: "reviewer-1" };
    projection.answerReviewFindings = { ar1: { reviewId: "ar1", answerSequence: 9, findings: [{ id: "finding-1", statement: "recorded finding", severity: "blocking" }], recordedAt: T7D_CLOCK, sequence: 10 } };
    projection.answerReviewReleases = { ar1: { reviewId: "ar1", priorReviewId: "ar0", sequence: 11 } };
    projection.answerReviews = { ar1: { id: "ar1", answerSequence: 9, reviewerRuntimeId: "reviewer-1", independence: "fresh_context", findings: [], summary: "recorded verdict", answerAccurate: true, recordedAt: T7D_CLOCK, sequence: 12 } };
    const result = buildPlanningReferenceExport(projection);
    const policies = result.categories.find((entry) => entry.id === "policies")!;
    for (const id of ["verifierPolicy", "verifierSelection", "integrationRevision"]) assert.ok(policies.items.some((item) => item.id === id && item.reference.selector === `/${id}`));
    const reviews = result.categories.find((entry) => entry.id === "reviews")!;
    for (const selector of ["/answerReviews/ar1", "/answerReviewFindings/ar1", "/answerReviewReleases/ar1"]) assert.ok(reviews.items.some((item) => item.reference.selector === selector));
    assert.equal(reviews.items.length + reviews.omittedCount, reviews.recordCount);
  } finally { f.cleanup(); }
});

test("T7d repaired pointers: canonical keys retain spaces, slashes, tildes and comment text without credential disclosure", async () => {
  const f = controlFixture("literal-pointers");
  try {
    await f.seedReady(); const projection = structuredClone(f.runtime.projection());
    const plan = projection.planning!.plan!; const old = plan.revisionsById[plan.currentRevisionId]!;
    const revisionId = "revision  two/~<!--";
    projection.planning = { ...projection.planning!, plan: { ...plan, currentRevisionId: revisionId,
      revisionsById: { [revisionId]: { ...old, revisionId } } } };
    const result = buildPlanningReferenceExport(projection);
    const card = result.cards.find((entry) => entry.kind === "worker")!;
    const selected = card.reference.selector.split("/").slice(1).reduce<unknown>((value, segment) =>
      (value as Record<string, unknown>)[segment.replace(/~1/g, "/").replace(/~0/g, "~")], projection);
    assert.deepEqual(selected, old.tasks[0]); assert.ok(card.reference.selector.includes("revision  two"));
    const contracts = result.categories.find((entry) => entry.id === "contracts")!;
    assert.equal(contracts.items[0]!.reference.selector, card.reference.selector);
    const sourceId = "source  two/~<!--";
    const source = projection.planning!.source;
    projection.planning = { ...projection.planning!, source: { ...source, currentManifestId: sourceId,
      manifestsById: { [sourceId]: { ...Object.values(source.manifestsById)[0]!, manifestId: sourceId } } } };
    const sourceRecord = buildPlanningReferenceExport(projection).categories.find((entry) => entry.id === "source")!.items[0]!;
    assert.equal((JSON.parse(sourceRecord.text) as { readsReference: { selector: string } }).readsReference.selector, "/planning/sourceReadIndex/source  two~1~0<!--");
    const privateId = "api_key=reference-private-731";
    projection.planning = { ...projection.planning!, plan: { ...plan, currentRevisionId: privateId,
      revisionsById: { [privateId]: { ...old, revisionId: privateId } } } };
    const privateResult = buildPlanningReferenceExport(projection);
    assert.doesNotMatch(JSON.stringify(privateResult), /reference-private-731/);
    assert.match(privateResult.cards.find((entry) => entry.kind === "worker")!.reference.unavailableReason!, /withheld/);
  } finally { f.cleanup(); }
});

test("T7d bounded references: omitted records and text truncation remain visible with exact counts", async () => {
  const f = controlFixture("bounds");
  try {
    await f.seedReady(); const projection = structuredClone(f.runtime.projection());
    const revision = projection.planning!.plan!.revisionsById[projection.planning!.plan!.currentRevisionId]!;
    const tasks = Array.from({ length: 75 }, (_, index) => ({ ...revision.tasks[0]!, id: `TASK-${index}`, steps: ["x".repeat(9000)] }));
    const changed = { ...revision, tasks };
    projection.planning = { ...projection.planning!, plan: { ...projection.planning!.plan!, revisionsById: { ...projection.planning!.plan!.revisionsById, [revision.revisionId]: changed } } };
    const result = buildPlanningReferenceExport(projection); const contracts = result.categories.find((category) => category.id === "contracts")!;
    assert.equal(contracts.recordCount, 75); assert.equal(contracts.items.length + contracts.omittedCount, 75);
    assert.ok(contracts.omittedCount >= 55); assert.ok(contracts.items.some((item) => item.truncated));
    assert.ok(contracts.items.every((item) => item.text.includes("truncated")));
    assert.equal(result.cards.filter((card) => card.kind === "worker").length + result.omittedCardCount, 75);
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 80 * 1024);
  } finally { f.cleanup(); }
});

test("T7d resume card: an unready planning run grants no execution base or assignment", async () => {
  const f = controlFixture("resume-card");
  try {
    await f.approve(); const before = f.evidence(); const result = buildPlanningReferenceExport(f.runtime.projection());
    const card = result.cards.find((card) => card.kind === "resume_planning");
    assert.ok(card); assert.match(card.text, /No implementation code, implementation tests, workloads, migrations or execution workers/);
    assert.match(card.text, /No execution base or worker claim/); assert.equal(result.cards.filter((card) => card.kind === "worker").length, 0);
    assert.deepEqual(f.evidence(), before);
  } finally { f.cleanup(); }
});

test("T7d browser export: copy and download preserve snapshot bytes and never issue a control request", async () => {
  const { chromium } = await import("@playwright/test"); const { build } = await import("esbuild");
  const f = controlFixture("browser-copy"); let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await f.seedReady(); const saved = f.runtime.projection();
    const projection = { ...saved, planning: { ...saved.planning!, readiness: "not_ready" as const }, projectDocsPolicyVersion: 2 as const };
    const document = buildPlanningExportDocument({ runId: projection.runId, projection, readiness: f.runtime.planningReadiness(), exportedAt: T7D_CLOCK });
    const bundle = await build({ bundle: true, write: false, platform: "browser", tsconfig: join(process.cwd(), "tsconfig.json"), stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React from "react"; import {createRoot} from "react-dom/client"; import {PlanningExportView} from "./components/PlanningExportView.tsx";
      window.copied=[]; Object.defineProperty(navigator,"clipboard",{value:{writeText:async text => window.copied.push(text)}});
      window.controls=0; window.fetch=async()=>{window.controls++;throw new Error("unexpected control request")};
      createRoot(document.getElementById("root")).render(<PlanningExportView document={${JSON.stringify(document)}}/>);` } });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto("http://127.0.0.1:9876/fixture"); await page.addScriptTag({ content: bundle.outputFiles![0]!.text });
    const before = f.evidence();
    await page.getByRole("button", { name: "Copy STATE snapshot", exact: true }).click();
    assert.equal(await page.evaluate("window.copied[0]"), document.snapshot.text);
    await page.getByText("Copy-ready reference cards", { exact: true }).click();
    await page.getByRole("button", { name: "Copy worker card T1", exact: true }).click();
    assert.equal(await page.evaluate("window.copied[1]"), document.references!.cards.find((card) => card.kind === "worker")!.text);
    await page.getByRole("button", { name: "Copy controller card", exact: true }).click();
    assert.equal(await page.evaluate("window.copied[2]"), document.references!.cards.find((card) => card.kind === "controller")!.text);
    assert.match(await page.evaluate("window.copied[2]") as string, /Authenticated GET \/v2\/runs\/.*\/build; JSON Pointer \(whole projection\)/);
    await page.getByRole("button", { name: "Copy resume-planning card", exact: true }).click();
    assert.equal(await page.evaluate("window.copied[3]"), document.references!.cards.find((card) => card.kind === "resume_planning")!.text);
    assert.match(await page.evaluate("window.copied[3]") as string, /Authenticated GET \/v2\/runs\/.*\/build; JSON Pointer \/planning\/resume/);
    const pending = page.waitForEvent("download"); await page.getByRole("button", { name: "Download planning export", exact: true }).click();
    const download = await pending; assert.equal(download.suggestedFilename(), "aiboard-planning-export.json");
    const stream = await download.createReadStream(); const bytes: Buffer[] = []; for await (const chunk of stream!) bytes.push(Buffer.from(chunk));
    const downloaded = JSON.parse(Buffer.concat(bytes).toString("utf8")) as PlanningExportDocument;
    assert.equal(downloaded.snapshot.text, document.snapshot.text); assert.deepEqual(downloaded.references, document.references);
    assert.equal(await page.evaluate("window.controls"), 0); assert.deepEqual(f.evidence(), before);
  } finally { await browser?.close(); f.cleanup(); }
});
