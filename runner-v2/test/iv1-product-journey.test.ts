import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureGitBaseline, runGit } from "./support/git-fixture.js";
import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ControlServer } from "../src/control-server.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import { buildExecutionPlanRevision, type ExecutionPlanPhase, type SourceRequirement } from "../src/planning-contracts.js";
import { NativeBuildFactory } from "../src/native-build-factory.js";
import { buildApprovedSourceManifest, validateApprovedSourceInput, type ApprovedSourceInputV1 } from "../src/native-planning-provisioner.js";
import { currentExplicitStartIdentity, type SchedulerProjection } from "../src/scheduler-store.js";
import { computeArtifactDigest } from "../src/source-manifest.js";

/**
 * IV-1 product journey (CD-23): an authentic unseeded authenticated
 * NativeBuildFactory -> BuildRuntime.step journey over real SQLite/Git
 * proving the durable validationScope end to end. The scripted worker
 * submits with a scope report; the trusted scheduler stores it; the
 * independent reviewer sees it beside the task validation rationales and
 * records a clean result for the adequate scope; the Architect sees the
 * same durable scope and confirms. Only the model transport is scripted;
 * Git, SQLite, the scheduler, sessions, artifacts and evidence are real.
 */
const IV1_RUN = "run_iv1_product_scope";
const IV1_TOKEN = "v2token";
const IV1_CLOCK = "2026-10-05T00:00:00.000Z";
const IV1_SOURCE = "SECTION s1: MANDATORY. The value module must export the value 2 with an upper-bound guard capped at 9.\r\nSECTION s2: OPERATIONAL. Maintain the value behavior and its tests.\r\n";
const IV1_VALUE_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value, capped } from '../src/value.mjs'; test('value criterion', () => assert.equal(value, 2)); test('guard criterion', () => assert.equal(capped, 2));\n";
const IV1_VALUE = "export const value = 2;\nexport const capped = Math.min(value, 9);\n";
const IV1_EXTRA = "export const extra = 42;\n";
const IV1_SCOPE_COMMAND = "node --test test/value.test.mjs";
const IV1_SCOPE = {
  changed: ["src/value.mjs", "src/extra.mjs"],
  verified: ["value exports 2", "guard caps at 9"],
  testsRun: [{ command: IV1_SCOPE_COMMAND, counts: { selected: 2, passed: 2, failed: 0, skipped: 0 } }],
  notRun: [{ what: "full suite", why: "narrow change with no shared contract touched" }],
};

function iv1SourceBytes(text: string): Uint8Array { return new Uint8Array(Buffer.from(text, "utf8")); }

function iv1SourceInput(text: string): ApprovedSourceInputV1 {
  const firstEnd = Buffer.byteLength(`${text.split("\n")[0]!}\n`, "utf8");
  return {
    version: 1, approval: "approved_spec", bytesBase64: Buffer.from(text).toString("base64"),
    mediaType: "text/plain", encoding: "utf-8",
    sections: [
      { id: "s1", startByte: 0, endByte: firstEnd },
      { id: "s2", startByte: firstEnd, endByte: Buffer.byteLength(text, "utf8") },
    ],
  };
}

function iv1JourneyScenario(runId: string) {
  const bytes = iv1SourceBytes(IV1_SOURCE);
  const validated = validateApprovedSourceInput(iv1SourceInput(IV1_SOURCE));
  const manifest = buildApprovedSourceManifest({
    runId, validated, artifactDigest: computeArtifactDigest(bytes), approvedBy: "local-user", createdAt: IV1_CLOCK,
  });
  const requirements: SourceRequirement[] = [{
    id: "REQ-1",
    reference: { sourceId: manifest.sourceId, sectionIds: ["s1", "s2"] },
    purpose: "Export the value 2 with a guard.",
    observableOutcome: "The value module exports 2 with an upper-bound guard.",
    obligationKind: "mandatory",
    applicability: { status: "applicable" },
    accountablePhaseId: "P1",
    contributingTaskIds: ["T1"],
    acceptanceConditions: [{ id: "REQ-1-ac1", description: "value is 2 with a guard.", responsibleGateId: "P1-exit", requiredEvidenceKinds: ["command"] }],
  }];
  const phases: ExecutionPlanPhase[] = [{
    id: "P1",
    purpose: "Deliver the value module.",
    requirementIds: ["REQ-1"],
    scope: { includes: ["src/value.mjs", "src/extra.mjs", "test/value.test.mjs", "package.json"], excludes: [] },
    entryConditions: ["Plan ready."],
    contributingTaskIds: ["T1"],
    exitCriteria: ["The value module is accepted."],
    requiredCombinedValidation: ["tests"],
    exitUnlocks: ["final verification"],
  }];
  const revision = buildExecutionPlanRevision({
    revisionId: "revision_iv1",
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks: [{
      id: "T1",
      lineage: [],
      accountablePhaseId: "P1",
      requirementIds: ["REQ-1"],
      outcome: { user: "Create src/value.mjs exporting value = 2 with an upper-bound guard.", system: "The value module exports 2 with a guard." },
      scope: { includes: ["src/value.mjs", "src/extra.mjs", "test/value.test.mjs", "package.json"], excludes: [] },
      writableSurfaces: ["src/value.mjs", "src/extra.mjs", "test/value.test.mjs", "package.json"],
      forbiddenSurfaces: ["infra/**", "docs/plans/**"],
      dependencies: [],
      requiredBase: "accepted plan revision revision_iv1",
      inputs: ["accepted plan revision"],
      outputs: ["src/value.mjs"],
      steps: ["Write the module.", "Run the tests."],
      acceptance: {
        criteria: [
          { id: "c1", text: "src/value.mjs exports value = 2 and the tests pass." },
          { id: "c2", text: "src/value.mjs exports an upper-bound guard capped at 9." },
        ],
        definitionOfDone: "Tests pass.",
      },
      validation: { targetedRationale: "The value test file covers the module.", affectedScopeRationale: "Dependents of the value module are rechecked." },
      negativeProofApplicability: { applicable: false, rationale: "A new module has no prior-incorrect case." },
      reviewCriteria: ["Independent review confirms the value and the guard."],
      integrationChecks: ["Post-integration tests."],
      cleanup: { cleanup: "None.", recovery: "Retry.", rollback: "Revert." },
      requirementCriteriaMap: [
        { taskLocalCriterionId: "c1", requirementId: "REQ-1" },
        { taskLocalCriterionId: "c2", requirementId: "REQ-1" },
      ],
    }],
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: IV1_CLOCK,
  });
  return { manifest, requirements, phases, revision };
}

const iv1Call = (name: string, args: unknown, id: string): ModelTurn => ({
  blocks: [{ type: "tool_call", callId: id, name, arguments: args }],
  stopReason: "tool_calls",
  usage: { inputTokens: 8, outputTokens: 4 },
});

function iv1JourneyEnvironment() {
  const ambient = { ...snapshotNativeBuildAmbientEnvironment() };
  delete ambient.NODE_TEST_CONTEXT;
  return Object.freeze(ambient);
}

function iv1LastToolValue(request: AgentModelRequest): Record<string, unknown> | undefined {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === "tool");
  const content = (message?.content as { content?: Array<{ type: string; value?: unknown }> } | undefined)?.content;
  return content?.find((item) => item.type === "json")?.value as Record<string, unknown> | undefined;
}

function iv1ToolResults(request: AgentModelRequest): Array<{ toolName?: string; isError?: boolean }> {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => message.content as { toolName?: string; isError?: boolean });
}

function iv1HasToolResult(request: AgentModelRequest, toolName: string): boolean {
  return iv1ToolResults(request).some((result) => result.toolName === toolName && result.isError !== true);
}

function iv1ReadText(request: AgentModelRequest, path: string): string | undefined {
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

function iv1ToolFailed(request: AgentModelRequest, toolName: string): boolean {
  return iv1ToolResults(request).some((result) => result.toolName === toolName && result.isError === true);
}

function iv1FailureDetail(request: AgentModelRequest, toolName: string): string {
  const failed = request.messages
    .filter((message) => message.role === "tool")
    .reverse()
    .find((message) => (message.content as { toolName?: string }).toolName === toolName && (message.content as { isError?: boolean }).isError === true);
  return JSON.stringify(failed?.content).slice(0, 1500);
}

function iv1RequestText(request: AgentModelRequest): string {
  return request.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
}

class Iv1JourneyReviewer implements AgentModel {
  readonly requests: AgentModelRequest[] = [];

  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const tools = new Set(request.tools.map((tool) => tool.name));
    const seen = request.messages.filter((message) => message.role === "tool").length;
    if (tools.has("record_coverage_obligations")) {
      return iv1Call("record_coverage_obligations", {
        obligations: [{ id: "obl-REQ-1", description: "Export the value 2 with a guard.", requirementId: "REQ-1" }],
        sectionCoverage: [
          { sectionId: "s1", obligationIds: ["obl-REQ-1"] },
          { sectionId: "s2", obligationIds: ["obl-REQ-1"] },
        ],
      }, `obl-${seen}`);
    }
    if (tools.has("submit_coverage_verdict")) {
      return iv1Call("submit_coverage_verdict", {
        obligationVerdicts: [{ obligationId: "obl-REQ-1", verdict: "covered", severity: "advisory", rationale: "T1 covers it.", evidenceRefs: ["ledger:REQ-1"] }],
        findings: [],
      }, `verdict-${seen}`);
    }
    const pass = request.messages.find((message) => message.role === "system")?.id ?? "";
    if (pass === "delivery-obligations-system") {
      return iv1Call("record_deliverable_obligations", { obligations: [{ id: "o1", description: "value must be 2 with a guard." }] }, `obl-${seen}`);
    }
    if (pass === "delivery-findings-system") {
      if (iv1HasToolResult(request, "record_deliverable_findings")) {
        throw new Error("Findings are already durably recorded; the pass is over.");
      }
      if (iv1ToolFailed(request, "record_deliverable_findings")) {
        throw new Error(`IV-1 fixture: record_deliverable_findings refused: ${iv1FailureDetail(request, "record_deliverable_findings")}`);
      }
      if (iv1ToolFailed(request, "fs.read")) {
        throw new Error(`IV-1 fixture: findings fs.read failed: ${iv1FailureDetail(request, "fs.read")}`);
      }
      if (iv1ReadText(request, "src/value.mjs") === undefined) {
        return iv1Call("fs.read", { path: "src/value.mjs" }, `findings-read-${seen}`);
      }
      const text = iv1RequestText(request);
      assert.ok(text.includes(IV1_SCOPE_COMMAND), "the findings context carries the durable scope");
      assert.ok(text.includes("Targeted validation rationale"), "the findings context carries targetedRationale");
      assert.ok(text.includes("Affected-scope validation rationale"), "the findings context carries affectedScopeRationale");
      return iv1Call("record_deliverable_findings", { findings: [] }, `findings-${seen}`);
    }
    if (pass === "delivery-verdict-system") {
      if (iv1ToolFailed(request, "submit_deliverable_verdict")) {
        throw new Error(`IV-1 fixture: submit_deliverable_verdict refused: ${iv1FailureDetail(request, "submit_deliverable_verdict")}`);
      }
      if (iv1ToolFailed(request, "fs.read")) {
        throw new Error(`IV-1 fixture: verdict fs.read failed: ${iv1FailureDetail(request, "fs.read")}`);
      }
      if (iv1ReadText(request, "src/value.mjs") === undefined) {
        return iv1Call("fs.read", { path: "src/value.mjs" }, `verdict-read-${seen}`);
      }
      const text = iv1RequestText(request);
      assert.ok(text.includes(IV1_SCOPE_COMMAND), "the verdict context carries the durable scope");
      const claimIds = [...new Set([...text.matchAll(/"id"\s*:\s*"(claim:[^"]+)"/g)].map((match) => match[1]!))];
      for (const expected of ["claim:c1", "claim:c2", "claim:summary"]) {
        assert.ok(claimIds.includes(expected), `the verdict context names ${expected}`);
      }
      const citation = [{ path: "src/value.mjs", line: 1 }];
      return iv1Call("submit_deliverable_verdict", {
        summary: "Reviewed against the criteria and the adequate scope.",
        satisfied: true,
        claimVerdicts: [
          { claimId: "claim:c1", status: "verified", rationale: "The passing run proves value 2.", citations: citation },
          { claimId: "claim:c2", status: "verified", rationale: "The passing run proves the guard.", citations: citation },
          { claimId: "claim:summary", status: "verified", rationale: "The summary matches the submission.", citations: citation },
        ],
      }, `verdict-${seen}`);
    }
    throw new Error(`Unexpected reviewer system ${pass}.`);
  }
}

class Iv1JourneyWorker implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly projection: () => SchedulerProjection) {}

  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const attempt = this.projection().tasks.T1?.attempt ?? 1;
    if (attempt !== 1) throw new Error(`IV-1 journey accepts on attempt 1, saw attempt ${attempt}.`);
    const tools = request.messages.filter((message) => message.role === "tool").length;
    if (tools === 0) return iv1Call("fs.read", { path: "src/value.mjs" }, "read-module-1");
    if (tools === 1) return iv1Call("fs.write", { path: "src/value.mjs", content: IV1_VALUE, expectedSha256: (iv1LastToolValue(request) as { sha256: string }).sha256 }, "write-module-1");
    if (tools === 2) return iv1Call("fs.write", { path: "src/extra.mjs", content: IV1_EXTRA }, "write-extra-1");
    if (tools === 3) return iv1Call("run_evidence_command", { label: "tests", command: process.execPath, args: ["--test", "test/value.test.mjs"] }, "evidence-1");
    const record = iv1LastToolValue(request) as unknown as { id: string; fact: { stdoutArtifactHash: string } };
    return iv1Call("submit_task", {
      summary: "Product value with guard; real tests pass.",
      readiness: "ready_for_architect_review",
      unresolvedConcerns: [],
      criterionEvidenceLinks: [
        { criterionId: "c1", evidenceId: record.id, artifactHashes: [record.fact.stdoutArtifactHash] },
        { criterionId: "c2", evidenceId: record.id, artifactHashes: [record.fact.stdoutArtifactHash] },
      ],
      validationScope: IV1_SCOPE,
    }, "submit-1");
  }
}

class Iv1JourneyArchitect implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private calls = 0;
  constructor(
    private readonly projection: () => SchedulerProjection,
    private readonly scenario: ReturnType<typeof iv1JourneyScenario>,
  ) {}
  private next(name: string, args: unknown): ModelTurn {
    this.calls += 1;
    return iv1Call(name, args, `iv1-arch-${this.calls}`);
  }
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const projection = this.projection();
    const planning = projection.planning;
    if (projection.planningTriageDecision === undefined) {
      return this.next("record_triage", { decision: "build", rationale: "IV-1 product: change request with an approved source." });
    }
    const manifestId = planning?.source.currentManifestId;
    assert.ok(manifestId, "the approved source is registered before planning reads");
    const reads = planning?.sourceReadIndex[manifestId] ?? {};
    const sections = this.scenario.manifest.sections;
    if (sections.some((section) => reads[section.id] !== section.digest)) {
      const pending = sections.find((section) => reads[section.id] !== section.digest)!;
      return this.next("read_planning_source_section", this.requests.length <= 2 ? {} : { sectionId: pending.id });
    }
    if (!planning?.ledger) {
      return this.next("persist_planning_ledger", {
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
      return this.next("draft_planning_plan", { revision: rest });
    }
    if (Object.keys(planning?.coverageRequests ?? {}).length === 0) {
      return this.next("request_coverage_review", { reviewId: "coverage_iv1" });
    }
    const task = projection.tasks.T1!;
    if (task.status === "submitted" || task.status === "architect_review") {
      const text = iv1RequestText(request);
      assert.ok(text.includes('"dispositionPrefill"'), "the Architect context carries the runner-owned prefill");
      assert.ok(text.includes(IV1_SCOPE_COMMAND), "the Architect context carries the same durable scope");
      assert.ok(/independent/i.test(text) && /confirm/i.test(text) && /override/i.test(text), "the Architect is told to confirm or override the independent review");
      assert.ok(!text.includes("Use artifact.read with diffArtifactHash"), "no mandatory full-diff reread is instructed");
      if (iv1ToolResults(request).some((result) => result.toolName === "review_task" && result.isError !== true)) {
        throw new Error("IV-1 fixture: review_task already succeeded; the turn should have ended.");
      }
      const links = task.criterionEvidenceLinks ?? [];
      const evidenceIds = [...new Set(links.map((link) => link.evidenceId))];
      const artifactHashes = [...new Set(links.flatMap((link) => link.artifactHashes))];
      return this.next("review_task", {
        taskId: "T1",
        decision: "approved",
        summary: "Confirming the independent review of the adequately scoped submission.",
        evidenceArtifactHashes: artifactHashes,
        criterionVerdicts: [
          { criterionId: "c1", verdict: "satisfied", rationale: "Confirming the independent review.", evidenceIds, artifactHashes },
          { criterionId: "c2", verdict: "satisfied", rationale: "Confirming the independent review.", evidenceIds, artifactHashes },
        ],
      });
    }
    if (task.status === "approved") return this.next("request_integration", { taskId: "T1" });
    throw new Error(`IV-1 journey script exhausted at T1 ${task.status}.`);
  }
}

function iv1Provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

function iv1LastModelToolError(models: Array<{ requests: AgentModelRequest[] }>): string {
  for (let index = models.length - 1; index >= 0; index--) {
    const requests = models[index]!.requests;
    for (let i = requests.length - 1; i >= 0; i--) {
      const failed = requests[i]!.messages
        .filter((message) => message.role === "tool")
        .reverse()
        .find((message) => (message.content as { isError?: boolean } | undefined)?.isError === true);
      if (failed) return `last failing model tool call: ${JSON.stringify(failed.content).slice(0, 1500)}`;
    }
  }
  return "no failing model tool call recorded";
}

test("IV-1 product: worker scope -> durable submission -> reviewer and Architect see it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-iv1-product-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "iv1-journey", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(project, "test", "value.test.mjs"), IV1_VALUE_TEST);
  writeFileSync(join(project, "src", "value.mjs"), "export const value = 1;\n");
  await runGit({ cwd: project, args: ["init"] });
  await runGit({ cwd: project, args: ["config", "core.autocrlf", "false"] });
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: IV1_RUN });
  const executionHost = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: iv1JourneyEnvironment() });
  const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")), { clock: () => IV1_CLOCK });
  let server: ControlServer | undefined;
  let factory: NativeBuildFactory | undefined;
  let manager: NativeBuildManager | undefined;
  let runtime: { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection } | undefined;
  const workerA = new Iv1JourneyWorker(() => runtime!.projection());
  const reviewer = new Iv1JourneyReviewer();
  const architect = new Iv1JourneyArchitect(() => runtime!.projection(), iv1JourneyScenario(IV1_RUN));
  try {
    factory = new NativeBuildFactory({
      projectRoot: project, stateDirectory: state,
      providerConfigs: { load: () => [iv1Provider("arch:architect", 1), iv1Provider("workA:workerA", 2), iv1Provider("rev:reviewer", 3)], save: () => undefined, close: () => undefined },
      executionHost, baselineFor: () => baseline.revision,
      providerModelFactory: (config) => config.runtimeId === "arch:architect" ? architect : config.runtimeId === "workA:workerA"
        ? { complete: (request) => request.tools.some((tool) => tool.name === "record_coverage_obligations" || tool.name === "submit_coverage_verdict") ? reviewer.complete(request) : workerA.complete(request) }
        : reviewer,
    });
    manager = new NativeBuildManager({ specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")), createRuntime: (spec) => factory!.create(spec).then((handle) => { runtime = handle.runtime as typeof runtime; return handle; }), prepareSpec: (spec, options) => factory!.prepareSpec(spec, options) });
    server = new ControlServer({ supervisor, token: IV1_TOKEN, builds: manager, buildProvisioner: manager, checkGit: async () => ({ available: true, version: "fixture-git", code: "git_ready", reason: null }), bootstrapRun: async () => ({ baselineRevision: baseline.revision, baselineRef: baseline.ref }) });
    const address = await server.start(0);
    const body = { runId: IV1_RUN, projectPath: project, permissionProfile: "full", idempotencyKey: "iv1-journey", build: { projectId: "iv1-fixture", objective: "Deliver the value module with a guard.", architectRuntimeId: "arch:architect", workerRuntimeIds: ["workA:workerA"], verifierRuntimeIds: ["rev:reviewer"], alwaysRequireIndependentVerifier: false, maxConcurrency: 1, runPolicy: "finish", budgetLimits: {}, planningPolicy: { version: 1 }, specCopy: false, handoffFiles: "export_only" } };
    const created = await fetch(`${address.url}/v2/runs`, { method: "POST", headers: { Authorization: `Bearer ${IV1_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(created.status, 201, await created.text());
    const control = (path: string, input: unknown) => fetch(`${address.url}/v2/runs/${IV1_RUN}/build/${path}`, { method: "POST", headers: { Authorization: `Bearer ${IV1_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const approve = await control("source", { approvedSource: { version: 1, approval: "approved_spec", bytesBase64: Buffer.from(IV1_SOURCE).toString("base64"), mediaType: "text/plain", encoding: "utf-8", sections: [{ id: "s1", startByte: 0, endByte: Buffer.byteLength(`${IV1_SOURCE.split("\n")[0]!}\n`, "utf8") }, { id: "s2", startByte: Buffer.byteLength(`${IV1_SOURCE.split("\n")[0]!}\n`, "utf8"), endByte: Buffer.byteLength(IV1_SOURCE, "utf8") }] }, idempotencyKey: "approve-source" });
    assert.equal(approve.status, 200, await approve.text());
    const stepUntil = async (done: (p: SchedulerProjection) => boolean) => {
      for (let step = 0; step < 300; step++) {
        const p = runtime!.projection();
        if (done(p)) return p;
        if (p.status === "paused" || p.status === "failed") {
          throw new Error(`Unexpected ${p.status} ${JSON.stringify({ pause: p.pauseReason, task: p.tasks.T1, recentEvents: manager!.events(IV1_RUN).slice(-12) })}`);
        }
        await runtime!.step();
      }
      throw new Error("IV-1 product scope journey not reached");
    };
    await stepUntil((p) => p.planning?.readiness === "ready");
    const start = await control("plan-start", { ...currentExplicitStartIdentity(runtime!.projection()), version: 1, ownerChoice: "execute", idempotencyKey: "explicit-start" });
    assert.equal(start.status, 200, await start.text());
    const reviewed = await stepUntil((p) => p.delivery?.reviews.T1?.stage === "completed");
    const review = reviewed.delivery!.reviews.T1!;
    assert.equal(review.submissionAttempt, 1);
    assert.equal(review.satisfied, true, "the adequate scope yields no finding");
    assert.deepEqual(review.findings ?? [], []);
    t.diagnostic(`IV-1 review completed satisfied: ${review.reviewId}`);
    const submittedTask = reviewed.tasks.T1!;
    assert.deepEqual(submittedTask.validationScope, IV1_SCOPE, "the durable task carries the submitted scope");
    assert.deepEqual(
      reviewed.submissionHistory?.["T1"]?.[0]?.validationScope,
      IV1_SCOPE,
      "the submission history carries the scope"
    );
    const accepted = await stepUntil((p) => p.delivery?.taskAcceptances?.T1 !== undefined);
    assert.equal(accepted.tasks.T1!.attempt, 1, "the adequate submission accepts on attempt 1");
    assert.ok(accepted.tasks.T1!.integrationRevision, "the submission integrates");
    const decided = manager!.events(IV1_RUN).find((event) => event.type === "review.decided");
    assert.ok(decided, "the Architect records its decision");
    assert.equal((decided!.payload as { decision: string }).decision, "approved");
    const head = (await runGit({ cwd: project, args: ["rev-parse", "HEAD"] })).stdout.trim();
    assert.equal(head, baseline.revision, "the approved-source baseline is intact");
  } catch (error) {
    t.diagnostic(`IV-1 journey failure: ${iv1LastModelToolError([reviewer, workerA, architect])}`);
    throw error;
  } finally {
    await server?.close();
    supervisor.close();
    await manager?.close();
    await factory?.close();
    await executionHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});
