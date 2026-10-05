import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { nodeJunitOutcome } from "../src/delivery-execution.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ControlServer } from "../src/control-server.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import { buildExecutionPlanRevision, type ExecutionPlanPhase, type ExecutionTaskContract, type SourceRequirement } from "../src/planning-contracts.js";
import { NativeBuildFactory } from "../src/native-build-factory.js";
import { captureGitBaseline, runGit } from "./support/git-fixture.js";
import { buildApprovedSourceManifest, validateApprovedSourceInput, type ApprovedSourceInputV1 } from "../src/native-planning-provisioner.js";
import { currentExplicitStartIdentity, rebuildSchedulerProjection, type SchedulerProjection } from "../src/scheduler-store.js";
import { computeArtifactDigest } from "../src/source-manifest.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { runnerRunStateSegment } from "../src/run-state-identity.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";

function v2JourneyEnvironment() {
  const ambient = {...snapshotNativeBuildAmbientEnvironment()};
  delete ambient.NODE_TEST_CONTEXT;
  return Object.freeze(ambient);
}

function sourceBytes(text: string): Uint8Array { return new Uint8Array(Buffer.from(text, "utf8")); }
function sourceInput(text: string, sections?: ApprovedSourceInputV1["sections"]): ApprovedSourceInputV1 { return { version: 1, approval: "approved_spec", bytesBase64: Buffer.from(text).toString("base64"), mediaType: "text/plain", encoding: "utf-8", ...(sections !== undefined ? { sections } : {}) }; }

const V2_RUN = "run_v2_product_journey";
const V2_CLOCK = "2026-10-02T00:00:00.000Z";
const V2_SOURCE = "SECTION s1: MANDATORY. The value module must export the value 2.\r\nSECTION s2: OPERATIONAL. Maintain the value behavior and its tests; caf\u00e9 stays byte-exact.\r\n";
const V2_VALUE_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value criterion', () => assert.equal(value, 2));\n";

function v2JourneySections(): [{ id: string; startByte: number; endByte: number }, { id: string; startByte: number; endByte: number }] {
  const firstEnd = Buffer.byteLength(`${V2_SOURCE.split("\n")[0]!}\n`, "utf8");
  return [
    { id: "s1", startByte: 0, endByte: firstEnd },
    { id: "s2", startByte: firstEnd, endByte: Buffer.byteLength(V2_SOURCE, "utf8") },
  ];
}

function v2JourneyScenario(runId: string, includeSecond = false) {
  const bytes = sourceBytes(V2_SOURCE);
  const validated = validateApprovedSourceInput(sourceInput(V2_SOURCE, [...v2JourneySections()]));
  const manifest = buildApprovedSourceManifest({
    runId,
    validated,
    artifactDigest: computeArtifactDigest(bytes),
    approvedBy: "local-user",
    createdAt: V2_CLOCK,
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
    scope: { includes: ["src/value.mjs", "src/notes.txt", "test/value.test.mjs", "package.json"], excludes: ["docs/project/STATE.md"] },
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
    scope: { includes: ["src/value.mjs", "src/notes.txt", "test/value.test.mjs", "package.json"], excludes: [] },
    writableSurfaces: ["src/value.mjs", "src/notes.txt", "test/value.test.mjs", "package.json"],
    forbiddenSurfaces: ["docs/project/STATE.md"],
    dependencies: [],
    requiredBase: "accepted plan revision revision_v2",
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
    revisionId: "revision_v2",
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: V2_CLOCK,
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

class V2JourneyArchitect implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private calls = 0;
  constructor(
    private readonly projection: () => SchedulerProjection,
    private readonly scenario: ReturnType<typeof v2JourneyScenario>,
    private readonly mode: JourneyMode,
  ) {}
  private call(name: string, args: unknown): ModelTurn {
    this.calls += 1;
    return journeyCall(name, args, `v2-arch-${this.calls}`);
  }
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const projection = this.projection();
    const planning = projection.planning;
    if (projection.planningTriageDecision === undefined) {
      return this.call("record_triage", { decision: "build", rationale: "V2 product: change request with an approved source." });
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
      return this.call("request_coverage_review", { reviewId: "coverage_v2" });
    }
    const task = projection.tasks.T1!;
    if (task.status === "submitted" || task.status === "architect_review") {
      assert.match(JSON.stringify(request.messages), /taken before later edits/, "actual Architect receives stale evidence links");
      const links = task.criterionEvidenceLinks ?? [];
      return this.call("review_task", {
        taskId: "T1",
        decision: "approved",
        summary: "Architect explicitly reconciles mechanical scope findings against the current plan.",
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        criterionVerdicts: [{ criterionId: "c1", verdict: "satisfied", rationale: "Tests pass.", evidenceIds: links.map((link) => link.evidenceId), artifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))] }],
      });
    }
    if (task.status === "approved") return this.call("request_integration", { taskId: "T1" });
    throw new Error(`V2 journey script exhausted at T1 ${task.status}.`);
  }
}

type JourneyMode = "cited" | "uncited" | "survivor";
const V2_REPORT = ".aiboard-report-v2-fixture.xml";
const V2_TEST_ARGS = ["--test", "--test-reporter=junit", `--test-reporter-destination=${V2_REPORT}`, "test/value.test.mjs"];
const journeyPackage = () => JSON.stringify({ name: "v2-journey", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2);
class V2JourneyWorker implements AgentModel {
  constructor(private readonly mode: JourneyMode) {}
  private evidence: Record<string, unknown> | undefined;
  reportWitness?: {bytes: Buffer; cwd: string; mtimeNs: bigint; changedMtimeNs?: bigint};
  readonly requests: AgentModelRequest[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const count = request.messages.filter((message) => message.role === "tool").length;
    if (count === 0) return journeyCall("fs.read", { path: "src/value.mjs" }, "read-module");
    if (count === 1) return journeyCall("fs.write", { path: "src/value.mjs", content: "export const value = 2;\r\nexport const branch = (x) => x > 0;\r\n", expectedSha256: journeyLastToolValue(request)!.sha256 }, "write-module");
    if (count === 2) return journeyCall("fs.read", { path: "test/value.test.mjs" }, "read-test");
    if (count === 3) return journeyCall("fs.write", { path: "test/value.test.mjs", content: V2_VALUE_TEST, expectedSha256: journeyLastToolValue(request)!.sha256 }, "write-test");
    if (count === 4) return journeyCall("fs.read", { path: "src/notes.txt" }, "read-notes");
    if (count === 5) {
      return journeyCall("fs.patch", { path: "src/notes.txt", search: "before", replace: "after", expectedSha256: journeyLastToolValue(request)!.sha256 }, "patch-notes");

    }
    if (count === 6) return journeyCall("run_evidence_command", { label: "tests", command: process.execPath, args: V2_TEST_ARGS }, "evidence-1");
    if (count === 7) { assert.ok(journeyLastToolValue(request)?.fact, JSON.stringify(request.messages.filter((message) => message.role === "tool").at(-1))); const fact = journeyLastToolValue(request)!.fact as {cwd:string}; const reportPath = join(fact.cwd,V2_REPORT); this.reportWitness = {bytes:readFileSync(reportPath),cwd:fact.cwd,mtimeNs:statSync(reportPath,{bigint:true}).mtimeNs}; assert.deepEqual(nodeJunitOutcome(this.reportWitness.bytes.toString("utf8"),fact.cwd,false),{status:"passed",counts:{selected:1,passed:1,failed:0,skipped:0},failingTestIds:[]}); return journeyCall("run_evidence_command", {label: "tests reused", command: process.execPath, args: V2_TEST_ARGS}, "evidence-2"); }
    if (count === 8) { assert.ok(journeyLastToolValue(request)?.fact, JSON.stringify(request.messages.filter((message) => message.role === "tool").at(-1))); this.evidence = journeyLastToolValue(request)!; assert.deepEqual(readFileSync(join(this.reportWitness!.cwd,V2_REPORT)),this.reportWitness!.bytes); assert.equal(statSync(join(this.reportWitness!.cwd,V2_REPORT),{bigint:true}).mtimeNs,this.reportWitness!.mtimeNs); return journeyCall("run_evidence_command", {label: "changed argv", command: process.execPath, args: ["--test", "--test-name-pattern=value", "--test-reporter=junit", `--test-reporter-destination=${V2_REPORT}`, "test/value.test.mjs"]}, "evidence-3"); }
    if (count === 9) {this.reportWitness!.changedMtimeNs = statSync(join(this.reportWitness!.cwd,V2_REPORT),{bigint:true}).mtimeNs; assert.notEqual(this.reportWitness!.changedMtimeNs,this.reportWitness!.mtimeNs); return journeyCall("fs.read", {path:"src/notes.txt"}, "post-command-read");}
    if (count === 10) return journeyCall("fs.patch", {path:"src/notes.txt", search:"after", replace:"later", expectedSha256:journeyLastToolValue(request)!.sha256}, "post-command-edit");
    const record = this.evidence!;
    const fact = record.fact as { stdoutArtifactHash: string };
    return journeyCall("submit_task", { summary: "Product value and real tests pass.", readiness: "ready_for_architect_review", unresolvedConcerns: [], criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [fact.stdoutArtifactHash] }] }, "submit-1");
  }
}

class V2JourneyReviewer implements AgentModel {
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
        return journeyCall("run_evidence_command", { label: "verifier-tests", command: process.execPath, args: ["--test", "test/value.test.mjs"] }, "verifier-evidence-1");
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
    if (pass === "delivery-verdict-system") assert.match(JSON.stringify(request.messages), /stale: taken before later edits/, "actual reviewer receives stale worker claims");
    if (pass === "delivery-verdict-system" && seen === 0) return journeyCall("fs.read", { path: "src/value.mjs", startLine: 1, endLine: 1 }, "verdict-read");
    if (pass === "delivery-verdict-system" && seen === 1) return journeyCall("fs.read", { path: "src/missing.mjs" }, "failed-read");
    const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
    const claimIds = [...new Set([...text.matchAll(/"id": "(claim:[^"]+)"/g)].map((match) => match[1]!))];
    return journeyCall("submit_deliverable_verdict", {
      summary: "The module exports 2 and the cited test run passed.",
      satisfied: true,
      survivorDispositions: [...text.matchAll(/"id": "(mutation-survivor:[^"]+)"/g)].map((match) => ({ findingId: match[1], disposition: "not_a_real_gap", rationale: "The changed arithmetic branch is deliberately unconstrained by the value-only criterion; this survivor does not weaken that criterion." })),
      claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Confirmed in the checkout.", ...(seen === 2 ? {} : { citations: seen === 3 ? [{ evidenceId: "foreign-evidence" }] : [{ path: "src/value.mjs", line: seen === 4 ? 99 : 1 }] }) })),
    }, `verdict-${seen}`);
  }
}

function v2Provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}


test("V2 unseeded authenticated factory SQLite Git exact reuse and changed argv journey", async () => {
      const mode = "cited" as const;
      const root = mkdtempSync(join(tmpdir(), "aiboard-v2-journey-")); const project = join(root, "project"); const state = join(root, "state");
      mkdirSync(join(project, "test"), { recursive: true }); mkdirSync(join(project, "src"), { recursive: true }); mkdirSync(state);
      writeFileSync(join(project, ".gitignore"), `${V2_REPORT}\n`);
      writeFileSync(join(project, "package.json"), journeyPackage()); writeFileSync(join(project, "test/value.test.mjs"), V2_VALUE_TEST);
      writeFileSync(join(project, "src/value.mjs"), "\ufeffexport const value = 1;\r\n");
      writeFileSync(join(project, "src/notes.txt"), "\ufeffbefore\r\nsecond\r\n");
      await runGit({ cwd: project, args: ["init"] }); await runGit({ cwd: project, args: ["config", "core.autocrlf", "false"] });
      const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: V2_RUN });
      const executionHost = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: v2JourneyEnvironment() });
      const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")), { clock: () => V2_CLOCK });
      let server: ControlServer | undefined; let factory: NativeBuildFactory | undefined; let manager: NativeBuildManager | undefined;
      let runtime: { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection } | undefined;
      try {
        const workerA = new V2JourneyWorker(mode); const workerB = new V2JourneyWorker(mode); const reviewer = new V2JourneyReviewer(mode);
        const architect = new V2JourneyArchitect(() => runtime!.projection(), v2JourneyScenario(V2_RUN), mode);
        factory = new NativeBuildFactory({ projectRoot: project, stateDirectory: state,
          providerConfigs: { load: () => [v2Provider("arch:architect", 1), v2Provider("workA:workerA", 2), v2Provider("workB:workerB", 3), v2Provider("rev:reviewer", 4)], save: () => undefined, close: () => undefined }, executionHost, baselineFor: () => baseline.revision,
          providerModelFactory: (config) => config.runtimeId === "arch:architect" ? architect : config.runtimeId === "workA:workerA" ? { complete: (request) => request.tools.some((tool) => tool.name === "record_coverage_obligations" || tool.name === "submit_coverage_verdict") ? reviewer.complete(request) : workerA.complete(request) } : config.runtimeId === "workB:workerB" ? workerB : reviewer });
        manager = new NativeBuildManager({ specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")), createRuntime: (spec) => factory!.create(spec).then((handle) => { runtime = handle.runtime as typeof runtime; return handle; }), prepareSpec: (spec, options) => factory!.prepareSpec(spec, options) });
        server = new ControlServer({ supervisor, token: "v2-token", builds: manager, buildProvisioner: manager, checkGit: async () => ({ available: true, version: "fixture-git", code: "git_ready", reason: null }), bootstrapRun: async () => ({ baselineRevision: baseline.revision, baselineRef: baseline.ref }) });
        const address = await server.start(0);
        const body = { runId: V2_RUN, projectPath: project, permissionProfile: "full", idempotencyKey: "v2-journey", build: { projectId: "v2-fixture", objective: "Deliver the value module.", architectRuntimeId: "arch:architect", workerRuntimeIds: ["workA:workerA", "workB:workerB"], verifierRuntimeIds: ["rev:reviewer", "workA:workerA"], alwaysRequireIndependentVerifier: false, maxConcurrency: 1, runPolicy: "finish", budgetLimits: {}, planningPolicy: { version: 1 }, specCopy: false, handoffFiles: "export_only" } };
        const created = await fetch(`${address.url}/v2/runs`, { method: "POST", headers: { Authorization: "Bearer v2-token", "Content-Type": "application/json" }, body: JSON.stringify(body) }); assert.equal(created.status, 201, await created.text());
        assert.equal(manager.events(V2_RUN)[1]!.payload.encodingSafetyPolicyVersion, 1);
        const control = (path: string, input: unknown) => fetch(`${address.url}/v2/runs/${V2_RUN}/build/${path}`, { method: "POST", headers: { Authorization: "Bearer v2-token", "Content-Type": "application/json" }, body: JSON.stringify(input) });
        const approve = await control("source", { approvedSource: sourceInput(V2_SOURCE, [...v2JourneySections()]), idempotencyKey: "approve-source" }); assert.equal(approve.status, 200, await approve.text());
        const stepUntil = async (done: (p: SchedulerProjection) => boolean) => {
          for (let step = 0; step < 200; step++) { const p = runtime!.projection(); if (done(p)) return p; if (p.status === "paused" || p.status === "failed") throw new Error(`Unexpected ${p.status} ${JSON.stringify(p.pauseReason)} ${JSON.stringify([...workerA.requests, ...workerB.requests].flatMap((request) => request.messages.filter((message) => message.role === "tool")).slice(-5))}`); await runtime!.step(); }
          throw new Error("V2 review not reached");
        };
        await stepUntil((p) => p.planning?.readiness === "ready"); assert.equal(workerA.requests.length, 0);
        const start = await control("plan-start", { ...currentExplicitStartIdentity(runtime!.projection()), version: 1, ownerChoice: "execute", idempotencyKey: "explicit-start" }); assert.equal(start.status, 200, await start.text());
        const p = await stepUntil((p) => p.tasks.T1?.status === "approved");
        const review = p.delivery!.reviews.T1!;
        assert.equal(review.reviewerRuntimeId, "rev:reviewer"); assert.equal(review.independence, "distinct_model");
        assert.ok(review.depth!.inspectionToolCalls >= 1);
        assert.equal(review.satisfied, true);
        assert.ok(review.readCapture!.reads.some((read) => read.path === "src/value.mjs" && read.startLine === 1 && read.endLine === 1));
        assert.ok(review.claimVerdicts!.every((claim) => JSON.stringify(claim.citations) === JSON.stringify([{path:"src/value.mjs",line:1}])));
        const events = manager.events(V2_RUN);
        const link = p.tasks.T1!.criterionEvidenceLinks![0]!;
        assert.equal(link.freshness?.status, "stale");
        assert.equal(link.freshness?.reason, "taken before later edits");
        assert.notEqual(link.freshness?.submittedTreeId, link.freshness?.evidenceTreeId);
        assert.deepEqual(rebuildSchedulerProjection(events), runtime!.projection());
        const runRoot = join(state, "builds", runnerRunStateSegment(V2_RUN));
        const evidence = new SqliteEvidenceStore(join(runRoot,"evidence.sqlite"),{readOnly:true});
        const reopened = new SqliteSchedulerStore(join(runRoot,"scheduler.sqlite"),{readOnly:true,evidenceStore:evidence,artifacts:new ArtifactStore(join(state,"artifacts"))});
        try {
          assert.deepEqual(reopened.readRun(V2_RUN),events);
          const workerRecords = evidence.list({runId:V2_RUN,taskId:"T1"}).filter((row) => row.fact.kind === "command");
          assert.equal(workerRecords.length, 3);
          const original = workerRecords.find((row) => row.fact.kind === "command" && row.fact.label === "tests")!;
          const reused = workerRecords.find((row) => row.fact.kind === "command" && row.fact.label === "tests reused")!;
          const changed = workerRecords.find((row) => row.fact.kind === "command" && row.fact.label === "changed argv")!;
          writeFileSync(join(tmpdir(),"p6-6","codex-v2-writer-product-command-facts.json"),JSON.stringify(workerRecords,null,2));
          assert.equal(reused.fact.kind === "command" && reused.fact.reused_from, original.id);
          assert.equal(changed.fact.kind === "command" && changed.fact.reused_from, undefined);
          if (original.fact.kind === "command" && reused.fact.kind === "command" && changed.fact.kind === "command") {
            assert.equal(reused.fact.executionSnapshot!.process.logicalProcessId, original.fact.executionSnapshot!.process.logicalProcessId);
            assert.notEqual(changed.fact.executionSnapshot!.process.logicalProcessId, original.fact.executionSnapshot!.process.logicalProcessId);
            assert.equal(reused.fact.startedAt, original.fact.startedAt);
            assert.equal(reused.fact.finishedAt, original.fact.finishedAt);
            assert.equal(reused.fact.stdoutArtifactHash, original.fact.stdoutArtifactHash);
          }
          assert.equal(rebuildSchedulerProjection(reopened.readRun(V2_RUN)).evidenceContentPolicyVersion, 1);
          const fact = evidence.getByIds({runId:V2_RUN,taskId:"T1",ids:[link.evidenceId]})[0]!.fact;
          assert.equal(fact.kind,"command");
          if (fact.kind === "command") {
            assert.equal(fact.exitCode,0);
            assert.equal(fact.timedOut,false);
            assert.equal(fact.cancelled,false);
            const witness = workerA.reportWitness ?? workerB.reportWitness; assert.ok(witness);
            const reportStore = new ArtifactStore(join(state,"artifacts")); const reportArtifact = await reportStore.put(witness.bytes,"application/xml","actual worker Node test report");
            assert.deepEqual(await reportStore.get(reportArtifact.hash),witness.bytes);
            const report = witness.bytes.toString("utf8");
            assert.match(report,/tests 1/,"worker command actually executes the one meaningful test");
            assert.match(report,/pass 1/);
            assert.equal(fact.workingTreeIdentity?.status,"known");
            assert.equal(fact.childEnvironmentIdentity?.status,"known");
            assert.equal(fact.childEnvironmentIdentity?.runtime?.version,process.version);
            assert.equal(fact.workingTreeIdentity?.status === "known" && fact.workingTreeIdentity.treeId,link.freshness?.evidenceTreeId);
          }
          assert.match(JSON.stringify(review.claims),/stale: taken before later edits/);
        } finally {reopened.close();evidence.close();}
        assert.equal((await runGit({cwd:project,args:["rev-parse","HEAD"]})).stdout.trim(),baseline.revision);
      } catch(error) {
        writeFileSync(join(tmpdir(),"codex-v2-product-debug.json"),JSON.stringify({root,projection:runtime?.projection(),events:manager?.events(V2_RUN).slice(-25)},null,2)); throw error;
      } finally {await server?.close();supervisor.close();await manager?.close();await factory?.close();await executionHost.close();rmSync(root,{recursive:true,force:true});}
});
