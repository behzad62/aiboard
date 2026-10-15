import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
import { currentExplicitStartIdentity, rebuildSchedulerProjection, testIntegrityBoundaryIsCurrent, type SchedulerProjection } from "../src/scheduler-store.js";
import { computeArtifactDigest } from "../src/source-manifest.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { runnerRunStateSegment } from "../src/run-state-identity.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";

// V3 (AR-R26) product journey: an unseeded authenticated
// NativeBuildFactory -> BuildRuntime.step -> real SQLite/Git run over a
// non-package.json C# xunit project. Only model transports are scripted;
// Git is the real finite owned-temp fixture adapter. The initial revision
// carries one passing and one failing test (a completed failing baseline
// establishes real TRX counts); the worker fixes the source only, and the
// boundary accepts on this run's own TRX report. pytest, cmake, maven,
// gradle, cargo, and go are not executed here: pytest is not installed on
// this host, no C compiler is available for cmake builds, and mvn, gradle,
// cargo, and go are absent from PATH. Those limits are reported honestly
// and the full language/platform matrix stays a T8 obligation.

function sourceBytes(text: string): Uint8Array { return new Uint8Array(Buffer.from(text, "utf8")); }
function sourceInput(text: string, sections?: ApprovedSourceInputV1["sections"]): ApprovedSourceInputV1 { return { version: 1, approval: "approved_spec", bytesBase64: Buffer.from(text).toString("base64"), mediaType: "text/plain", encoding: "utf-8", ...(sections !== undefined ? { sections } : {}) }; }

const V3_RUN = "run_v3_product_journey";
const V3_CLOCK = "2026-10-02T00:00:00.000Z";
const V3_SOURCE = "SECTION s1: MANDATORY. The Calc class must expose Value 2.\r\nSECTION s2: OPERATIONAL. Maintain the Calc behavior and its tests; caf\u00e9 stays byte-exact.\r\n";
const V3_BROKEN_CALC = "public static class Calc\n{\n    public static int Value => 1;\n}\n";
const V3_FIXED_CALC = "public static class Calc\n{\n    public static int Value => 2;\n}\n";
const V3_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.9.0" />
    <PackageReference Include="xunit" Version="2.9.3" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
</Project>
`;
const V3_TESTS = `using Xunit;

public sealed class CalcTests
{
    [Fact]
    public void ValueIsTwo() => Assert.Equal(2, Calc.Value);

    [Fact]
    public void ValueIsNonNegative() => Assert.True(Calc.Value >= 0);
}
`;

function v3JourneySections(): [{ id: string; startByte: number; endByte: number }, { id: string; startByte: number; endByte: number }] {
  const firstEnd = Buffer.byteLength(`${V3_SOURCE.split("\n")[0]!}\n`, "utf8");
  return [
    { id: "s1", startByte: 0, endByte: firstEnd },
    { id: "s2", startByte: firstEnd, endByte: Buffer.byteLength(V3_SOURCE, "utf8") },
  ];
}

function v3JourneyScenario(runId: string) {
  const bytes = sourceBytes(V3_SOURCE);
  const validated = validateApprovedSourceInput(sourceInput(V3_SOURCE, [...v3JourneySections()]));
  const manifest = buildApprovedSourceManifest({
    runId,
    validated,
    artifactDigest: computeArtifactDigest(bytes),
    approvedBy: "local-user",
    createdAt: V3_CLOCK,
  });
  const requirements: SourceRequirement[] = [{
    id: "REQ-1",
    reference: { sourceId: manifest.sourceId, sectionIds: ["s1", "s2"] },
    purpose: "Expose Calc Value 2.",
    observableOutcome: "The Calc class exposes Value 2.",
    obligationKind: "mandatory",
    applicability: { status: "applicable" },
    accountablePhaseId: "P1",
    contributingTaskIds: ["T1"],
    acceptanceConditions: [{ id: "REQ-1-ac1", description: "Value is 2.", responsibleGateId: "P1-exit", requiredEvidenceKinds: ["command"] }],
  }];
  const phases: ExecutionPlanPhase[] = [{
    id: "P1",
    purpose: "Deliver the Calc fix.",
    requirementIds: ["REQ-1"],
    scope: { includes: ["Calc.cs", "Calc.Tests.cs", "Calc.Tests.csproj"], excludes: ["docs/project/STATE.md"] },
    entryConditions: ["Plan ready."],
    contributingTaskIds: ["T1"],
    exitCriteria: ["The Calc behavior is accepted."],
    requiredCombinedValidation: ["tests"],
    exitUnlocks: ["final verification"],
  }];
  const tasks: ExecutionTaskContract[] = [{
    id: "T1",
    lineage: [],
    accountablePhaseId: "P1",
    requirementIds: ["REQ-1"],
    outcome: { user: "Fix Calc.cs so Value is 2.", system: "Calc exposes Value 2." },
    scope: { includes: ["Calc.cs", "Calc.Tests.cs", "Calc.Tests.csproj"], excludes: [] },
    writableSurfaces: ["Calc.cs"],
    forbiddenSurfaces: ["docs/project/STATE.md"],
    dependencies: [],
    requiredBase: "accepted plan revision revision_v3",
    inputs: ["accepted plan revision"],
    outputs: ["Calc.cs"],
    steps: ["Fix the value.", "Run the tests."],
    acceptance: { criteria: [{ id: "c1", text: "Calc exposes Value 2 and dotnet test passes." }], definitionOfDone: "Tests pass." },
    validation: { targetedRationale: "The Calc tests.", affectedScopeRationale: "The value only." },
    negativeProofApplicability: { applicable: false, rationale: "A value fix has no prior-incorrect case." },
    reviewCriteria: ["Independent review confirms the value."],
    integrationChecks: ["Post-integration tests."],
    cleanup: { cleanup: "None.", recovery: "Retry.", rollback: "Revert." },
    requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-1" }],
  }];
  const revision = buildExecutionPlanRevision({
    revisionId: "revision_v3",
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: V3_CLOCK,
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

/** Bounded total preview of the last tool message: never throws, never masks a refusal. */
function journeyToolPreview(request: AgentModelRequest | undefined, max = 2000): string {
  if (!request) return "no-requests";
  try {
    const tools = request.messages.filter((message) => message.role === "tool");
    const text = JSON.stringify(tools.at(-1)?.content ?? null);
    return (typeof text === "string" ? text : "unserializable-tool-content").slice(0, max);
  } catch {
    return "unserializable-tool-content";
  }
}

class V3JourneyArchitect implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private calls = 0;
  constructor(
    private readonly projection: () => SchedulerProjection,
    private readonly scenario: ReturnType<typeof v3JourneyScenario>,
  ) {}
  private call(name: string, args: unknown): ModelTurn {
    this.calls += 1;
    return journeyCall(name, args, `v3-arch-${this.calls}`);
  }
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const projection = this.projection();
    const planning = projection.planning;
    if (projection.planningTriageDecision === undefined) {
      return this.call("record_triage", { decision: "build", rationale: "V3 product: change request with an approved source." });
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
      return this.call("request_coverage_review", { reviewId: "coverage_v3" });
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
    throw new Error(`V3 journey script exhausted at T1 ${task.status}.`);
  }
}

class V3JourneyWorker implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const toolCount = request.messages.filter((message) => message.role === "tool").length;
    if (toolCount === 0) return journeyCall("fs.read", { path: "Calc.cs" }, "read-module");
    if (toolCount === 1) {
      // A refused fs.read carries no sha256: assert the shape before
      // dereferencing so the refusal stays visible instead of crashing.
      const seen = journeyLastToolValue(request) as { sha256?: unknown } | undefined;
      assert.ok(typeof seen?.sha256 === "string" && seen.sha256.length > 0, `V3 journey read has no usable digest: ${journeyToolPreview(request, 500)}`);
      return journeyCall("fs.write", { path: "Calc.cs", content: V3_FIXED_CALC, expectedSha256: seen.sha256 }, "write-module");
    }
    if (toolCount === 2) return journeyCall("run_evidence_command", { label: "tests", command: "dotnet", args: ["test", "--disable-build-servers"] }, "evidence-1");
    // A refused run_evidence_command or submit_task carries no fact: assert
    // the shape before dereferencing so the refusal stays visible.
    const record = journeyLastToolValue(request) as { id?: unknown; fact?: { stdoutArtifactHash?: unknown } } | undefined;
    const fact = record?.fact;
    assert.ok(
      typeof record?.id === "string" && fact && typeof fact.stdoutArtifactHash === "string",
      `V3 journey evidence has no usable fact: ${journeyToolPreview(request, 500)}`,
    );
    return journeyCall("submit_task", {
      summary: "Fixed Calc.cs to expose Value 2; dotnet test passes.",
      readiness: "ready_for_architect_review",
      unresolvedConcerns: [],
      criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [fact.stdoutArtifactHash] }],
      validationScope: {
        changed: ["Calc.cs"],
        verified: ["Calc exposes Value 2"],
        testsRun: [{ command: "dotnet test --disable-build-servers", counts: { selected: 2, passed: 2, failed: 0, skipped: 0 } }],
        notRun: [{ what: "full language matrix", why: "this journey covers the .NET/TRX fixture only; other language fixtures are outside the selected journey" }],
      },
    }, "submit-1");
  }
}

class V3JourneyReviewer implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const tools = new Set(request.tools.map((tool) => tool.name));
    const seen = request.messages.filter((message) => message.role === "tool").length;
    if (tools.has("record_coverage_obligations")) {
      return journeyCall("record_coverage_obligations", {
        obligations: [{ id: "obl-REQ-1", description: "Expose Calc Value 2.", requirementId: "REQ-1" }],
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
      return journeyCall("record_deliverable_obligations", { obligations: [{ id: "o1", description: "Value must be 2." }] }, `obl-${seen}`);
    }
    if (pass === "delivery-findings-system") {
      if (seen === 0) return journeyCall("fs.read", { path: "Calc.cs" }, "read-1");
      return journeyCall("record_deliverable_findings", { findings: [] }, `findings-${seen}`);
    }
    if (request.tools.some((tool) => tool.name === "record_verification_expectations")) {
      return journeyCall("record_verification_expectations", {
        expectations: [{
          taskId: "T1",
          criterionId: "c1",
          expectedBehaviors: ["Calc exposes Value 2."],
          edgeCases: ["A value fix has no prior-incorrect case."],
          regressionSurfaces: ["Calc.cs"],
          requiredTests: ["The Calc tests pass."],
        }],
      }, `verifier-expectations-${seen}`);
    }
    if (request.tools.some((tool) => tool.name === "submit_verifier_verdict")) {
      if (seen === 0) {
        return journeyCall("run_evidence_command", { label: "verifier-tests", command: "dotnet", args: ["test", "--disable-build-servers"] }, "verifier-evidence-1");
      }
      const record = journeyLastToolValue(request);
      const evidenceId = (record as { id?: unknown } | undefined)?.id;
      assert.ok(typeof evidenceId === "string" && evidenceId.length > 0, "the verifier test run records evidence");
      return journeyCall("submit_verifier_verdict", {
        criterionVerdicts: [{
          taskId: "T1",
          criterionId: "c1",
          verdict: "satisfied",
          rationale: "Calc exposes 2 and the cited verifier test run passed.",
          evidenceIds: [evidenceId],
        }],
      }, "verifier-verdict-1");
    }
    // The E5 review-evidence guard only honors a verified claim whose
    // citation was actually read in this review session. Read the cited
    // source first, then verify with that read cited in the rationale.
    if (request.tools.some((tool) => tool.name === "submit_deliverable_verdict") && !request.messages.some((message) => message.role === "tool" && typeof message.content === "object" && !Array.isArray(message.content) && message.content.callId === "cite-read-1" && message.content.isError === false)) {
      return journeyCall("fs.read", { path: "Calc.cs", startLine: 3, endLine: 3 }, "cite-read-1");
    }
    const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
    const claimIds = [...new Set([...text.matchAll(/"id"\s*:\s*"(claim:[^"]+)"/g)].map((match) => match[1]!))];
    return journeyCall("submit_deliverable_verdict", {
      summary: "Calc exposes 2 and the cited test run passed.",
      satisfied: true,
      claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Read Calc.cs in this session (cite-read-1) and confirmed Value 2 on line 3; the cited verifier test run passed.", citations: [{ path: "Calc.cs", line: 3 }] })),
    }, `verdict-${seen}`);
  }
}

function v3Provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

test("V3 product: real factory dotnet journey with TRX pass and fail counts", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-v3-journey-"));
  const project = join(root, "project"); const state = join(root, "state");
  mkdirSync(project, { recursive: true }); mkdirSync(state, { recursive: true });
  writeFileSync(join(project, ".gitignore"), "bin/\nobj/\nTestResults/\n.aiboard-report-*\n.vs/\n");
  writeFileSync(join(project, "Calc.Tests.csproj"), V3_CSPROJ);
  writeFileSync(join(project, "Calc.Tests.cs"), V3_TESTS);
  writeFileSync(join(project, "Calc.cs"), V3_BROKEN_CALC);
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: V3_RUN });
  const executionHost = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")), { clock: () => V3_CLOCK });
  let server: ControlServer | undefined; let factory: FixtureNativeBuildFactory | undefined; let manager: NativeBuildManager | undefined;
  let runtime: { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection } | undefined;
  const worker = new V3JourneyWorker(); const reviewer = new V3JourneyReviewer();
  const architect = new V3JourneyArchitect(() => runtime!.projection(), v3JourneyScenario(V3_RUN));
  try {
    factory = new FixtureNativeBuildFactory({ projectRoot: project, stateDirectory: state,
      providerConfigs: { load: () => [v3Provider("arch:architect", 1), v3Provider("work:worker", 2), v3Provider("rev:reviewer", 3)], save: () => undefined, close: () => undefined }, executionHost, baselineFor: () => baseline.revision,
      providerModelFactory: (config) => config.runtimeId === "arch:architect" ? architect : config.runtimeId === "work:worker" ? worker : reviewer });
    manager = new NativeBuildManager({ specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")), createRuntime: (spec) => factory!.create(spec).then((handle) => { runtime = handle.runtime as typeof runtime; return handle; }), prepareSpec: (spec, options) => factory!.prepareSpec(spec, options) });
    server = new ControlServer({ supervisor, token: "v3-control-token", builds: manager, buildProvisioner: manager, checkGit: async () => ({ available: true, version: "fixture-git", code: "git_ready", reason: null }), bootstrapRun: async () => ({ baselineRevision: baseline.revision, baselineRef: baseline.ref }) });
    const address = await server.start(0);
    const body = { runId: V3_RUN, projectPath: project, permissionProfile: "full", idempotencyKey: "v3-journey", build: { projectId: "v3-journey-fixture", objective: "Fix Calc Value.", architectRuntimeId: "arch:architect", workerRuntimeIds: ["work:worker"], verifierRuntimeIds: ["rev:reviewer"], alwaysRequireIndependentVerifier: false, maxConcurrency: 1, runPolicy: "finish", budgetLimits: {}, planningPolicy: { version: 1 }, specCopy: false, handoffFiles: "export_only" } };
    const create = () => fetch(`${address.url}/v2/runs`, { method: "POST", headers: { Authorization: "Bearer v3-control-token", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const created = await create(); assert.equal(created.status, 201, await created.text());
    const original = manager.events(V3_RUN);
    const retry = await create(); assert.equal(retry.status, 201, await retry.text()); assert.deepEqual(manager.events(V3_RUN), original, "fresh prefix retries exactly");
    assert.equal(original[1]!.payload.testIntegrityPolicyVersion, 1);
    assert.equal(runtime!.projection().testIntegrity!.initialRevision, baseline.revision);
    const control = (path: string, input: unknown) => fetch(`${address.url}/v2/runs/${V3_RUN}/build/${path}`, { method: "POST", headers: { Authorization: "Bearer v3-control-token", "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const approve = await control("source", { approvedSource: sourceInput(V3_SOURCE, [...v3JourneySections()]), idempotencyKey: "approve-source" }); assert.equal(approve.status, 200, await approve.text());
    const stepUntil = async (label: string, done: (p: SchedulerProjection) => boolean) => {
      for (let step = 0; step < 200; step++) { const p = runtime!.projection(); if (done(p)) return p; if (p.status === "paused" || p.status === "failed") throw new Error(`${label}: ${p.status} ${JSON.stringify(p.pauseReason)}`); await runtime!.step(); }
      throw new Error(`${label}: not reached`);
    };
    await stepUntil("ready", (p) => p.planning?.readiness === "ready"); assert.equal(worker.requests.length, 0);
    const start = await control("plan-start", { ...currentExplicitStartIdentity(runtime!.projection()), version: 1, ownerChoice: "execute", idempotencyKey: "explicit-start" }); assert.equal(start.status, 200, await start.text());
    const p = await stepUntil("boundary", (p) => !!p.delivery?.boundaries.T1?.length);
    const boundary = p.delivery!.boundaries.T1!.at(-1)!;
    const initialBaseline = p.testIntegrity!.baseline!;
    assert.ok(initialBaseline.kind === "executed_report", "the failing dotnet baseline establishes real counts");
    assert.equal(initialBaseline.executed, 2);
    assert.deepEqual(initialBaseline.report.counts, { selected: 2, passed: 1, failed: 1, skipped: 0 });
    assert.equal(initialBaseline.report.runner, "dotnet test");
    assert.equal(initialBaseline.report.format, "trx");
    const raw = boundary.checks.find((check) => check.checkId === "tests")!;
    const guard = boundary.checks.find((check) => check.checkId === "test_integrity")!;
    assert.equal(raw.outcome, "passed", JSON.stringify(raw));
    assert.equal(raw.report!.runner, "dotnet test");
    assert.equal(raw.report!.format, "trx");
    assert.deepEqual(raw.report!.counts, { selected: 2, passed: 2, failed: 0, skipped: 0 });
    assert.match(raw.report!.artifactHash ?? "", /^[a-f0-9]{64}$/, "this run's TRX is captured immutably");
    assert.equal(raw.exitCode, 0);
    assert.equal(guard.outcome, "passed", guard.reason ?? "guard");
    assert.equal(boundary.passed, true);
    assert.equal(p.testIntegrity!.baseline!.pin.revision, baseline.revision, "unaccepted candidate cannot promote trusted baseline");
    assert.equal(testIntegrityBoundaryIsCurrent(p, boundary), true);
    const accepted = await stepUntil("accepted", (p) => !!p.delivery?.taskAcceptances.T1);
    assert.equal(accepted.testIntegrity!.baseline!.pin.revision, accepted.integrationRevision, "acceptance promotes the trusted baseline");
    const acceptedBaseline = accepted.testIntegrity!.baseline!;
    assert.ok(acceptedBaseline.kind === "executed_report");
    assert.equal(acceptedBaseline.executed, 2);
    assert.equal(accepted.testIntegrity!.baseline!.acceptedTaskId, "T1");
    const events = manager.events(V3_RUN); const replay = rebuildSchedulerProjection(events);
    assert.deepEqual(replay.testIntegrity, runtime!.projection().testIntegrity, "durable replay preserves exact trusted denominator and authority");
    const runRoot = join(state, "builds", runnerRunStateSegment(V3_RUN));
    const reopenedEvidence = new SqliteEvidenceStore(join(runRoot, "evidence.sqlite"), { readOnly: true });
    const reopened = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"), { readOnly: true, evidenceStore: reopenedEvidence, artifacts: new ArtifactStore(join(state, "artifacts")) });
    try { assert.deepEqual(reopened.readRun(V3_RUN), events, "SQLite reopen revalidates every exact baseline/boundary authority and artifact"); }
    finally { reopened.close(); reopenedEvidence.close(); }
    assert.ok(reviewer.requests.some((request) => JSON.stringify(request).includes("Runner test-integrity baseline")));
    assert.equal((await runGit({ cwd: project, args: ["rev-parse", "HEAD"] })).stdout.trim(), baseline.revision, "owner checkout remains unchanged");
  } catch (error) {
    try {
      const worktrees = (await runGit({ cwd: project, args: ["worktree", "list", "--porcelain"] })).stdout;
      let tail: unknown = "manager-unavailable";
      try { tail = manager?.events(V3_RUN).slice(-20); } catch { /* original error wins */ }
      let projection: unknown = "runtime-unavailable";
      try { projection = runtime?.projection(); } catch { /* original error wins */ }
      // Total bounded diagnostics: every preview tolerates absent messages
      // and unserializable content, so a refusal or an empty history is
      // captured instead of throwing and dropping all diagnostics.
      const lastToolText = journeyToolPreview(worker.requests.at(-1), 3000);
      const workerShapes = worker.requests.map((request) => request.messages.filter((message) => message.role === "tool").length);
      const reviewerShapes = reviewer.requests.map((request) => ({ tools: request.tools.map((tool) => tool.name), toolMsgs: request.messages.filter((message) => message.role === "tool").length }));
      const lastReviewerText = journeyToolPreview(reviewer.requests.at(-1), 2000);
      writeFileSync(join(tmpdir(), "codex-v3-fixture-debug.json"), JSON.stringify({ root, worktrees, projection, events: tail, workerShapes, lastToolText, reviewerShapes, lastReviewerText, architectCalls: architect.requests.length }, null, 2));
    } catch { /* debug never masks the original failure */ }
    throw error;
  } finally { await server?.close(); supervisor.close(); await manager?.close(); await factory?.close(); await executionHost.close(); rmSync(root, { recursive: true, force: true }); }
});

test("V3 reviewer fixture reads citations independently in each verdict session", async () => {
  const reviewer = new V3JourneyReviewer();
  const request = (messages: AgentModelRequest["messages"]): AgentModelRequest => ({ messages, tools: [{ name: "submit_deliverable_verdict", description: "verdict", inputSchema: {} }], model: "fixture" } as unknown as AgentModelRequest);
  const fresh = request([{ id: "delivery-verdict-system", role: "system", content: "fixture" }]);
  const first = await reviewer.complete(fresh); assert.equal((first.blocks[0] as { name?: string }).name, "fs.read");
  const read = { id: "cite-read-1-result", role: "tool" as const, content: { callId: "cite-read-1", toolName: "fs.read", isError: false, content: [{ type: "json" as const, value: { path: "Calc.cs", content: "public static int Value => 2;" } }] } };
  const verdict = await reviewer.complete(request([...fresh.messages, read])); assert.equal((verdict.blocks[0] as { name?: string }).name, "submit_deliverable_verdict");
  const nextSession = await reviewer.complete(fresh); assert.equal((nextSession.blocks[0] as { name?: string }).name, "fs.read", "a new verdict session cannot borrow the previous read");
});
