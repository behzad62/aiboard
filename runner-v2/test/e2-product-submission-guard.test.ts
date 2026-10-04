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
import { currentExplicitStartIdentity, rebuildSchedulerProjection, reduceSchedulerEvent, type SchedulerProjection } from "../src/scheduler-store.js";
import { computeArtifactDigest } from "../src/source-manifest.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { runnerRunStateSegment } from "../src/run-state-identity.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { validateSubmissionScopeRecord } from "../src/submission-scope-capture.js";

function sourceBytes(text: string): Uint8Array { return new Uint8Array(Buffer.from(text, "utf8")); }
function sourceInput(text: string, sections?: ApprovedSourceInputV1["sections"]): ApprovedSourceInputV1 { return { version: 1, approval: "approved_spec", bytesBase64: Buffer.from(text).toString("base64"), mediaType: "text/plain", encoding: "utf-8", ...(sections !== undefined ? { sections } : {}) }; }

const E2_RUN = "run_e2_product_journey";
const E2_CLOCK = "2026-10-02T00:00:00.000Z";
const E2_SOURCE = "SECTION s1: MANDATORY. The value module must export the value 2.\r\nSECTION s2: OPERATIONAL. Maintain the value behavior and its tests; caf\u00e9 stays byte-exact.\r\n";
const E2_LOW_CONTENT = "export const value = 2;\n";
const E2_VALUE_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value', () => assert.equal(value, 2)); test('witness', () => assert.ok(value >= 0));\n";

function e2JourneySections(): [{ id: string; startByte: number; endByte: number }, { id: string; startByte: number; endByte: number }] {
  const firstEnd = Buffer.byteLength(`${E2_SOURCE.split("\n")[0]!}\n`, "utf8");
  return [
    { id: "s1", startByte: 0, endByte: firstEnd },
    { id: "s2", startByte: firstEnd, endByte: Buffer.byteLength(E2_SOURCE, "utf8") },
  ];
}

function e2JourneyScenario(runId: string, includeSecond = false) {
  const bytes = sourceBytes(E2_SOURCE);
  const validated = validateApprovedSourceInput(sourceInput(E2_SOURCE, [...e2JourneySections()]));
  const manifest = buildApprovedSourceManifest({
    runId,
    validated,
    artifactDigest: computeArtifactDigest(bytes),
    approvedBy: "local-user",
    createdAt: E2_CLOCK,
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
    requiredBase: "accepted plan revision revision_e2",
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
    revisionId: "revision_e2",
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: E2_CLOCK,
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

class E2JourneyArchitect implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private calls = 0;
  constructor(
    private readonly projection: () => SchedulerProjection,
    private readonly scenario: ReturnType<typeof e2JourneyScenario>,
    private readonly mode: JourneyMode,
  ) {}
  private call(name: string, args: unknown): ModelTurn {
    this.calls += 1;
    return journeyCall(name, args, `e2-arch-${this.calls}`);
  }
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const projection = this.projection();
    const planning = projection.planning;
    if (projection.planningTriageDecision === undefined) {
      return this.call("record_triage", { decision: "build", rationale: "E2 product: change request with an approved source." });
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
      return this.call("request_coverage_review", { reviewId: "coverage_e2" });
    }
    const task = projection.tasks.T1!;
    if (task.status === "submitted" || task.status === "architect_review") {
      const links = task.criterionEvidenceLinks ?? [];
      return this.call("review_task", {
        taskId: "T1",
        decision: "approved",
        summary: "Architect explicitly reconciles mechanical scope findings against the current plan.",
        ...(this.mode === "scope_reconciled" ? { findingDispositions: (projection.delivery?.reviews.T1?.runnerScope?.findings ?? []).map((finding) => ({ findingId: finding.id, resolution: "plan_reconciled", rationale: "The current plan intentionally includes the additional product output.", planRevisionId: projection.planning!.plan!.currentRevisionId, planDigest: projection.planning!.plan!.currentDigest })) } : {}),
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        criterionVerdicts: [{ criterionId: "c1", verdict: "satisfied", rationale: "Tests pass.", evidenceIds: links.map((link) => link.evidenceId), artifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))] }],
      });
    }
    if (task.status === "approved") return this.call("request_integration", { taskId: "T1" });
    throw new Error(`E2 journey script exhausted at T1 ${task.status}.`);
  }
}

type JourneyMode = "clean" | "scope_blocked" | "scope_reconciled" | "secret";
const journeyPackage = () => JSON.stringify({ name: "e2-journey", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2);
class E2JourneyWorker implements AgentModel {
  constructor(private readonly mode: JourneyMode) {}
  readonly requests: AgentModelRequest[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const toolCount = request.messages.filter((message) => message.role === "tool").length;
    if (toolCount === 0) return journeyCall("fs.read", { path: "src/value.mjs" }, "read-module");
    if (toolCount === 1) return journeyCall("fs.write", { path: "src/value.mjs", content: E2_LOW_CONTENT, expectedSha256: journeyLastToolValue(request)!.sha256 }, "write-module");
    const additional = this.mode !== "clean";
    if (additional && toolCount === 2) return journeyCall("fs.write", { path: this.mode === "secret" ? "src/settings.mjs" : "outside.txt", content: this.mode === "secret" ? "const api_key = '" + "literal".repeat(5) + "';\n" : "product output\n" }, "additional-output");
    const evidenceTurn = additional ? 3 : 2;
    if (toolCount === evidenceTurn) return journeyCall("run_evidence_command", { label: "tests", command: process.execPath, args: ["--test"] }, "evidence-1");
    if (toolCount > evidenceTurn + 1) return journeyCall("ask_architect", { requestId: "secret-refusal", question: "The redacted submission refusal requires correction.", blocking: true, evidenceSequence: 0 }, "ask-secret");
    const record = journeyLastToolValue(request)!;
    const fact = record.fact as { stdoutArtifactHash: string };
    return journeyCall("submit_task", { summary: "Changed value module; real tests pass.", readiness: "ready_for_architect_review", unresolvedConcerns: [], criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [fact.stdoutArtifactHash] }] }, "submit-1");
  }
}

class E2JourneyReviewer implements AgentModel {
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
      satisfied: this.mode === "clean" || this.mode === "secret",
      claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Confirmed in the checkout." })),
    }, `verdict-${seen}`);
  }
}

function e2Provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

describe("E2 product journey", { concurrency: 2 }, () => {
  for (const mode of ["clean", "scope_blocked", "scope_reconciled", "secret"] as const) {
    test(`E2 product: real factory submission guard ${mode}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "aiboard-e2-journey-")); const project = join(root, "project"); const state = join(root, "state");
      mkdirSync(join(project, "test"), { recursive: true }); mkdirSync(join(project, "src"), { recursive: true }); mkdirSync(state);
      writeFileSync(join(project, "package.json"), journeyPackage()); writeFileSync(join(project, "test/value.test.mjs"), E2_VALUE_TEST);
      writeFileSync(join(project, "src/value.mjs"), "export const value = 1;\n");
      const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: E2_RUN });
      const executionHost = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
      const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")), { clock: () => E2_CLOCK });
      let server: ControlServer | undefined; let factory: FixtureNativeBuildFactory | undefined; let manager: NativeBuildManager | undefined;
      let runtime: { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection } | undefined;
      try {
        const worker = new E2JourneyWorker(mode); const reviewer = new E2JourneyReviewer(mode);
        const architect = new E2JourneyArchitect(() => runtime!.projection(), e2JourneyScenario(E2_RUN), mode);
        factory = new FixtureNativeBuildFactory({ projectRoot: project, stateDirectory: state,
          providerConfigs: { load: () => [e2Provider("arch:architect", 1), e2Provider("work:worker", 2), e2Provider("rev:reviewer", 3)], save: () => undefined, close: () => undefined }, executionHost, baselineFor: () => baseline.revision,
          providerModelFactory: (config) => config.runtimeId === "arch:architect" ? architect : config.runtimeId === "work:worker" ? worker : reviewer });
        manager = new NativeBuildManager({ specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")), createRuntime: (spec) => factory!.create(spec).then((handle) => { runtime = handle.runtime as typeof runtime; return handle; }), prepareSpec: (spec, options) => factory!.prepareSpec(spec, options) });
        server = new ControlServer({ supervisor, token: "e2-control-token", builds: manager, buildProvisioner: manager, checkGit: async () => ({ available: true, version: "fixture-git", code: "git_ready", reason: null }), bootstrapRun: async () => ({ baselineRevision: baseline.revision, baselineRef: baseline.ref }) });
        const address = await server.start(0);
        const body = { runId: E2_RUN, projectPath: project, permissionProfile: "full", idempotencyKey: "e2-journey", build: { projectId: "e2-journey-fixture", objective: "Deliver the value module.", architectRuntimeId: "arch:architect", workerRuntimeIds: ["work:worker"], verifierRuntimeIds: ["rev:reviewer"], alwaysRequireIndependentVerifier: false, maxConcurrency: 1, runPolicy: "finish", budgetLimits: {}, planningPolicy: { version: 1 }, specCopy: false, handoffFiles: "export_only" } };
        const create = () => fetch(`${address.url}/v2/runs`, { method: "POST", headers: { Authorization: "Bearer e2-control-token", "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const created = await create(); assert.equal(created.status, 201, await created.text());
        const original = manager.events(E2_RUN); const retry = await create(); assert.equal(retry.status, 201, await retry.text()); assert.deepEqual(manager.events(E2_RUN), original);
        assert.equal(original[1]!.payload.submissionScopePolicyVersion, 1);
        const control = (path: string, input: unknown) => fetch(`${address.url}/v2/runs/${E2_RUN}/build/${path}`, { method: "POST", headers: { Authorization: "Bearer e2-control-token", "Content-Type": "application/json" }, body: JSON.stringify(input) });
        const approve = await control("source", { approvedSource: sourceInput(E2_SOURCE, [...e2JourneySections()]), idempotencyKey: "approve-source" }); assert.equal(approve.status, 200, await approve.text());
        const stepUntil = async (label: string, done: (p: SchedulerProjection) => boolean) => {
          for (let step = 0; step < 200; step++) { const p = runtime!.projection(); if (done(p)) return p; if (p.status === "paused" || p.status === "failed") throw new Error(`${label}: ${p.status} ${JSON.stringify(p.pauseReason)}`); await runtime!.step(); }
          throw new Error(`${label}: not reached`);
        };
        await stepUntil("ready", (p) => p.planning?.readiness === "ready"); assert.equal(worker.requests.length, 0);
        const start = await control("plan-start", { ...currentExplicitStartIdentity(runtime!.projection()), version: 1, ownerChoice: "execute", idempotencyKey: "explicit-start" }); assert.equal(start.status, 200, await start.text());
        if (mode === "secret") {
          const p = await stepUntil("secret refusal", (p) => p.tasks.T1?.status === "waiting_guidance");
          assert.equal(p.tasks.T1!.changeSetId, undefined);
          assert.equal(manager.events(E2_RUN).some((event) => event.type === "delivery.review_started"), false);
          assert.equal(reviewer.requests.some((request) => request.tools.some((tool) => tool.name === "record_deliverable_findings")), false);
          const refusals = worker.requests.flatMap((request) => request.messages.filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content))).filter((content) => content.includes("[REDACTED]"));
          assert.ok(refusals.length > 0); assert.ok(refusals.every((content) => !content.includes("literal".repeat(5))));
          assert.equal((await runGit({ cwd: p.tasks.T1!.workspacePath!, args: ["rev-parse", "HEAD"] })).stdout.trim(), baseline.revision);
        } else {
          const p = await stepUntil("durable review", (p) => p.delivery?.reviews.T1?.stage === "completed");
          const scope = p.tasks.T1!.submissionScope!; const review = p.delivery!.reviews.T1!;
          assert.ok(scope); assert.equal(scope.sessionId, p.runtime.workerAssignments["T1:1"]!.sessionId);
          assert.equal(scope.claim.state, "claimed", "capture precedes release");
          assert.ok(Object.values(p.planning!.assignments).some((entry) => entry.claim.id === scope.claim.id && entry.claim.state === "released"));
          assert.deepEqual(review.runnerScope, scope);
          const submissionEvents = manager.events(E2_RUN);
          const submittedIndex = submissionEvents.findIndex((event) => event.type === "task.transitioned" && event.payload.status === "submitted");
          assert.ok(submittedIndex >= 0);
          const submittedEvent = structuredClone(submissionEvents[submittedIndex]!);
          const beforeSubmission = rebuildSchedulerProjection(submissionEvents.slice(0, submittedIndex));
          const inputSnapshot = structuredClone(submittedEvent);
          const immutableEvent = { ...submittedEvent, payload: { ...submittedEvent.payload, patch: Object.freeze({ ...(submittedEvent.payload.patch as object) }) } };
          assert.doesNotThrow(() => reduceSchedulerEvent(beforeSubmission, immutableEvent), "reduction must not mutate the supplied event patch");
          assert.deepEqual(submittedEvent, inputSnapshot);
          for (const actor of [{ role: "worker", id: scope.workerId }, { role: "user", id: "owner" }, { role: "runner", id: "foreign" }] as const) {
            assert.throws(() => reduceSchedulerEvent(beforeSubmission, { ...submittedEvent, actor }), /trusted scheduler actor/);
          }
          const validated = validateSubmissionScopeRecord(beforeSubmission, "T1", scope.changeSetId, scope);
          const scopeSnapshot = structuredClone(scope);
          validated.files.push({ path: "alias.txt", added: true });
          assert.deepEqual(p.tasks.T1!.submissionScope, scopeSnapshot, "validation returns detached metadata");
          for (const mutate of [
            (record: typeof scope) => { record.sessionId = "foreign-session"; },
            (record: typeof scope) => { record.claim = { ...record.claim, ownershipGeneration: record.claim.ownershipGeneration + 1 }; },
            (record: typeof scope) => { record.claim = { ...record.claim, writableSurfaces: ["."] }; },
            (record: typeof scope) => { record.contractRef = { ...record.contractRef, digest: "f".repeat(64) }; },
          ]) {
            const forged = structuredClone(scope); mutate(forged);
            assert.throws(() => validateSubmissionScopeRecord(beforeSubmission, "T1", scope.changeSetId, forged), /exact runner authority/);
          }
          assert.throws(() => validateSubmissionScopeRecord(beforeSubmission, "T1", "changeset_forged", scope), /exact task revision/);
          assert.ok(reviewer.requests.some((request) => JSON.stringify(request).includes("Runner submission scope findings")));
          const recorded = manager.events(E2_RUN).find((event) => event.type === "delivery.findings_recorded")!;
          assert.deepEqual(recorded.payload.findings, [], "reviewer intentionally omits scope facts; kernel retains them");
          if (mode === "clean") { assert.equal(scope.findings.length, 0); assert.equal(review.satisfied, true); }
          else {
            assert.ok(scope.findings.some((finding) => finding.path === "outside.txt" && finding.code === "outside_claim"));
            assert.equal(review.satisfied, false); assert.ok(review.findings!.some((finding) => finding.id === scope.findings[0]!.id));
            const links = p.tasks.T1!.criterionEvidenceLinks!;
            const forged = { runId: E2_RUN, eventId: "forged-scope-disposition", sequence: p.lastSequence + 1, type: "review.decided" as const, occurredAt: E2_CLOCK, actor: { role: "architect" as const, id: "architect_1" }, idempotencyKey: "forged-scope-disposition", payload: { taskId: "T1", decision: "approved", summary: "Approve", evidenceArtifactHashes: links.flatMap((link) => link.artifactHashes), criterionVerdicts: [{ criterionId: "c1", verdict: "satisfied", rationale: "Tests", evidenceIds: links.map((link) => link.evidenceId), artifactHashes: links.flatMap((link) => link.artifactHashes) }], findingDispositions: scope.findings.map((finding) => ({ findingId: finding.id, resolution: "deferred", rationale: "Ignore" })) } };
            assert.throws(() => reduceSchedulerEvent(p, forged), /explicit current-plan reconciliation/);
            assert.throws(() => reduceSchedulerEvent(p, { ...forged, payload: { ...forged.payload, findingDispositions: scope.findings.map((finding) => ({ findingId: finding.id, resolution: "plan_reconciled", rationale: "Stale", planRevisionId: "stale", planDigest: "f".repeat(64) })) } }), /explicit current-plan reconciliation/);
            assert.equal(p.delivery!.taskAcceptances.T1, undefined);
          }
          if (mode === "clean" || mode === "scope_reconciled") {
            const accepted = await stepUntil("accepted", (p) => !!p.delivery?.taskAcceptances.T1);
            if (mode === "scope_reconciled") assert.ok(accepted.delivery!.reviews.T1!.findings!.every((finding) => finding.disposition?.resolution === "plan_reconciled" && finding.disposition.resolvedInRevisionDigest === accepted.planning!.plan!.currentDigest));
          }
        }
        const events = manager.events(E2_RUN); assert.deepEqual(rebuildSchedulerProjection(events), runtime!.projection());
        const runRoot = join(state, "builds", runnerRunStateSegment(E2_RUN)); const evidence = new SqliteEvidenceStore(join(runRoot, "evidence.sqlite"), { readOnly: true });
        const reopened = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"), { readOnly: true, evidenceStore: evidence, artifacts: new ArtifactStore(join(state, "artifacts")) });
        try { assert.deepEqual(reopened.readRun(E2_RUN), events); } finally { reopened.close(); evidence.close(); }
        assert.equal((await runGit({ cwd: project, args: ["rev-parse", "HEAD"] })).stdout.trim(), baseline.revision);
      } catch (error) {
        writeFileSync(join(tmpdir(), `codex-e2-fixture-debug-${mode}.json`), JSON.stringify({ root, projection: runtime?.projection(), events: manager?.events(E2_RUN).slice(-25) }, null, 2)); throw error;
      } finally { await server?.close(); supervisor.close(); await manager?.close(); await factory?.close(); await executionHost.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
});
