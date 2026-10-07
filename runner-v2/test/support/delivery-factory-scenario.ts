import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { AgentModel, AgentModelRequest, ModelTurn } from "../../src/agent-contracts.js";
import {
  buildExecutionPlanRevision,
  T1A_SEEDED_HOST_PLANNING_CAPABILITIES,
  type CoverageReview,
  type ExecutionPlanPhase,
  type ExecutionTaskContract,
  type SourceRequirement,
} from "../../src/planning-contracts.js";
import type { RunnerProviderConfig } from "../../src/provider-config-store.js";
import {
  buildCompletionReadiness,
  currentExplicitStartIdentity,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerActorRole,
  type SchedulerProjection,
} from "../../src/scheduler-store.js";
import { buildSourceManifest } from "../../src/source-manifest.js";
import type { ValidationScope } from "../../src/validation-scope.js";
import { SqliteSchedulerStore } from "../../src/sqlite-scheduler-store.js";
import { ArtifactStore } from "../../src/artifact-store.js";
import { createExecutionHost } from "../../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../../src/native-build-factory.js";
import { captureGitBaseline, NativeBuildFactory } from "./git-fixture.js";

/**
 * Shared scenario for the NativeBuildFactory delivery suites (split out of
 * native-delivery-factory.test.ts so the report-matrix files can run in
 * parallel processes; each test uses its own temp root, store and host).
 */

/**
 * T6a repair cycle 3 (B9): the delivery flow built THROUGH NativeBuildFactory.
 * A new-policy run with a ready single-task plan is driven by the real pump:
 * a scripted worker really writes a file, runs an evidence command, and
 * submits; the factory's NativeDeliverableReviewRuntime reviews the real diff
 * with real read tools; the Architect approves; the real IntegrationManager
 * integrates; the factory's boundary driver runs the project's test command
 * through FinalVerificationRuntime and the audited executor; the task and
 * phase are accepted. Removing the factory's delivery wiring turns this red.
 */

const RUN_ID = "run-delivery-factory";
const CLOCK = "2026-09-25T00:00:00.000Z";
const SOURCE_TEXT = "SECTION 1: MANDATORY. The value module must export the value 2.";

function scenario() {
  const manifest = buildSourceManifest(Buffer.from(SOURCE_TEXT, "utf-8"), [{ id: "s1", startByte: 0, endByte: Buffer.byteLength(SOURCE_TEXT) }], {
    manifestId: "manifest_value",
    sourceId: "source_value",
    mediaType: "text/plain",
    encoding: "utf-8",
    authority: "owner",
    createdAt: "2026-09-24T00:00:00.000Z",
  });
  const requirements: SourceRequirement[] = [{
    id: "REQ-1",
    reference: { sourceId: manifest.sourceId, sectionIds: ["s1"] },
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
    requiredBase: "accepted plan revision revision_value",
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
    revisionId: "revision_value",
    runId: RUN_ID,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: "2026-09-24T00:00:00.000Z",
  });
  const coverageReview: CoverageReview = {
    id: "coverage_value",
    runId: RUN_ID,
    reviewerRuntimeId: "reviewer:distinct-model",
    independence: "distinct_model",
    sourceReadManifestId: manifest.manifestId,
    planRevisionId: revision.revisionId,
    planRevisionDigest: revision.digest,
    derivedObligations: [{ id: "obl-REQ-1", requirementId: "REQ-1", description: "Export 2.", recordedBeforePlanOrDiffProvided: true, recordedAt: "2026-09-24T00:05:00.000Z" }],
    obligationVerdicts: [{ obligationId: "obl-REQ-1", verdict: "covered", severity: "advisory", rationale: "T1 covers it.", evidenceRefs: ["ledger:REQ-1"] }],
    findings: [],
    recordedAt: "2026-09-24T00:10:00.000Z",
  };
  return { manifest, requirements, phases, revision, coverageReview };
}

function planningEvents(): NewSchedulerEvent[] {
  const { manifest, requirements, phases, revision, coverageReview } = scenario();
  const e = (type: string, key: string, role: SchedulerActorRole, id: string, payload: Record<string, unknown>): NewSchedulerEvent =>
    ({ runId: RUN_ID, type: type as NewSchedulerEvent["type"], occurredAt: CLOCK, actor: { role, id }, idempotencyKey: key, payload });
  return [
    e("project_docs.policy_configured", "project-docs-policy", "runner", "build-runtime", { version: 2 }),
    e("run.initialized", "run-initialized", "runner", "build-runtime", { testIntegrityPolicyVersion: 1, submissionScopePolicyVersion: 1, reviewIntegrityPolicyVersion: 1, encodingSafetyPolicyVersion: 1, reviewEvidencePolicyVersion: 1, validationScopePolicyVersion: 1, objective: "Deliver the value module." }),
    e("planning.policy_configured", "planning-policy", "runner", "build-runtime", { version: 1 }),
    e("planning.source_registered", "source", "user", "owner", { manifest }),
    e("request.triaged", "triage", "architect", "architect", { decision: "build", rationale: "Build the module." }),
    e("planning.ledger_persisted", "ledger", "architect", "architect", { id: "ledger", requirements, phases, nonNormativeSections: [] }),
    ...manifest.sections.map((section) => e("planning.source_section_read", `read:${section.id}`, "architect", "architect", { manifestId: manifest.manifestId, manifestDigest: manifest.artifactDigest, sectionId: section.id, sectionDigest: section.digest, readAt: CLOCK })),
    e("planning.plan_drafted", "plan", "architect", "architect", { revision, expectedRevisionId: null, expectedDigest: null }),
    e("planning.coverage_review_requested", "coverage-request", "architect", "architect", { reviewId: coverageReview.id, planRevisionId: revision.revisionId, planRevisionDigest: revision.digest, sourceManifestId: manifest.manifestId, requestedAt: CLOCK }),
    e("planning.coverage_obligations_recorded", "coverage-obligations", "verifier", "coverage-reviewer", { reviewId: coverageReview.id, sourceManifestId: manifest.manifestId, sourceManifestDigest: manifest.artifactDigest, obligations: coverageReview.derivedObligations, sectionCoverage: manifest.sections.map((section) => ({ sectionId: section.id, obligationIds: ["obl-REQ-1"] })), recordedAt: CLOCK }),
    e("planning.coverage_plan_delivered", "coverage-plan", "runner", "build-runtime", { reviewId: coverageReview.id, planRevisionId: revision.revisionId, planRevisionDigest: revision.digest, sourceManifestId: manifest.manifestId, deliveredAt: CLOCK }),
    e("planning.coverage_review_recorded", "coverage-review", "verifier", "coverage-reviewer", { review: coverageReview }),
    e("planning.plan_ready", "ready", "runner", "build-runtime", { hostCapabilities: T1A_SEEDED_HOST_PLANNING_CAPABILITIES }),
  ];
}

const call = (name: string, args: unknown, id: string): ModelTurn => ({
  blocks: [{ type: "tool_call", callId: id, name, arguments: args }],
  stopReason: "tool_calls",
  usage: { inputTokens: 8, outputTokens: 4 },
});

function lastToolValue(request: AgentModelRequest): Record<string, unknown> | undefined {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === "tool");
  const content = (message?.content as { content?: Array<{ type: string; value?: unknown }> } | undefined)?.content;
  return content?.find((item) => item.type === "json")?.value as Record<string, unknown> | undefined;
}

/**
 * C5: optional observation of the actual AgentModel requests the real
 * worker and reviewer turns receive — transport scripting only; the
 * worker still writes, runs evidence and submits through real tools.
 */
export interface DeliveryFactoryObservation {
  workerRequests?: AgentModelRequest[];
  reviewerRequests?: AgentModelRequest[];
}

/**
 * IV-1: the worker's truthful validation-scope report for this fixture. The
 * worker writes src/value.mjs and runs the whole `node --test` suite (one
 * test, passing); nothing is left unrun. The no-test-files variant
 * (testFile: null) runs zero tests, so it reports no runs and explains the
 * omission instead of claiming a selected=0 run (refused by the parser).
 */
const DELIVERY_VALIDATION_SCOPE: ValidationScope = {
  changed: ["src/value.mjs"],
  verified: ["src/value.mjs exports value = 2"],
  testsRun: [{ command: "node --test", counts: { selected: 1, passed: 1, failed: 0, skipped: 0 } }],
  notRun: [],
};
const DELIVERY_VALIDATION_SCOPE_NO_TESTS: ValidationScope = {
  changed: ["src/value.mjs"],
  verified: [],
  testsRun: [],
  notRun: [{ what: "automated tests", why: "the project has no test files; node --test selected zero tests" }],
};

class WorkerModel implements AgentModel {
  constructor(private readonly content: string, private readonly observe?: DeliveryFactoryObservation, private readonly validationScope: ValidationScope = DELIVERY_VALIDATION_SCOPE) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.observe?.workerRequests?.push(request);
    const toolCount = request.messages.filter((message) => message.role === "tool").length;
    if (toolCount === 0) return call("fs.write", { path: "src/value.mjs", content: this.content, createDirectories: true }, "write-1");
    if (toolCount === 1) return call("run_evidence_command", { label: "tests", command: process.execPath, args: ["--test"] }, "evidence-1");
    const record = lastToolValue(request)!;
    const fact = record.fact as { stdoutArtifactHash: string };
    return call("submit_task", {
      summary: "Added src/value.mjs exporting value = 2; node --test passes.",
      readiness: "ready_for_architect_review",
      unresolvedConcerns: [],
      criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [fact.stdoutArtifactHash] }],
      validationScope: this.validationScope,
    }, "submit-1");
  }
}

class ReviewerModel implements AgentModel {
  readonly passes: string[] = [];
  constructor(private readonly observe?: DeliveryFactoryObservation) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.observe?.reviewerRequests?.push(request);
    const system = request.messages.find((message) => message.role === "system");
    const pass = system?.id ?? "";
    this.passes.push(pass);
    const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
    const tools = request.messages.filter((message) => message.role === "tool").length;
    if (pass === "delivery-obligations-system") {
      return call("record_deliverable_obligations", { obligations: [{ id: "o1", description: "value must be 2." }] }, `obl-${tools}`);
    }
    if (pass === "delivery-findings-system") {
      if (tools === 0) return call("fs.read", { path: "src/value.mjs" }, "read-1");
      return call("record_deliverable_findings", { findings: [] }, `findings-${tools}`);
    }
    // E5: the verdict pass runs in a fresh session, so the citation read
    // must happen here before the verdict is submitted.
    if (tools === 0) return call("fs.read", { path: "src/value.mjs" }, "verdict-read-1");
    const claimIds = [...new Set([...text.matchAll(/"id"\s*:\s*"(claim:[^"]+)"/g)].map((match) => match[1]!))];
    return call("submit_deliverable_verdict", {
      summary: "The module exports 2 and the cited test run passed.",
      satisfied: true,
      survivorDispositions: [...text.matchAll(/"id"\s*:\s*"(mutation-survivor:[^"]+)"/g)].map((match) => ({ findingId: match[1]!, disposition: "not_a_real_gap", rationale: "The changed arithmetic branch is deliberately unconstrained by the value-only criterion; this survivor does not weaken that criterion." })),
      claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Confirmed in the checkout.", citations: [{ path: "src/value.mjs", line: 1 }] })),
    }, `verdict-${tools}`);
  }
}

class ArchitectModel implements AgentModel {
  constructor(private readonly projection: () => SchedulerProjection) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const projection = this.projection();
    const tools = request.messages.filter((message) => message.role === "tool").length;
    const task = projection.tasks.T1!;
    if (task.status === "submitted" || task.status === "architect_review") {
      const links = task.criterionEvidenceLinks ?? [];
      return call("review_task", {
        taskId: "T1",
        decision: "approved",
        summary: "The deliverable review is satisfied and the evidence passes.",
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        criterionVerdicts: [{ criterionId: "c1", verdict: "satisfied", rationale: "Tests pass.", evidenceIds: links.map((link) => link.evidenceId), artifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))] }],
      }, `review-${request.messages.length}-${tools}`);
    }
    if (task.status === "approved") return call("request_integration", { taskId: "T1" }, `integrate-${request.messages.length}-${tools}`);
    throw new Error(`Unexpected Architect turn with T1 ${task.status}.`);
  }
}

function provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

function safeSegment(value: string): string {
  const readable = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
}

export const LOW_CONTENT = "export const value = 2;\n";
export const HIGH_CONTENT = LOW_CONTENT + Array.from({ length: 150 }, (_, index) => `export const filler${index} = ${index} + 1;\n`).join("");

export const BUILD_SCRIPTS = { build: "node -e 0", test: "node --test" };

export const VALUE_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value', () => assert.equal(value, 2));\n";
export const STALE_JUNIT = '<?xml version="1.0"?><testsuites tests="5" failures="0" errors="0" skipped="0"><testsuite name="old" tests="5" failures="0" errors="0" skipped="0"><testcase name="a"/><testcase name="b"/><testcase name="c"/><testcase name="d"/><testcase name="e"/></testsuite></testsuites>\n';

function withPathPrefix(environment: Readonly<Record<string, string>>, prefix: string | undefined): Readonly<Record<string, string>> {
  if (!prefix) return environment;
  // Windows spells the name "Path"; keep whatever spelling the environment uses.
  const name = Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const current = environment[name];
  return { ...environment, [name]: current ? `${prefix}${delimiter}${current}` : prefix };
}

export async function runDeliveryFactoryScenario(
  content: string,
  scripts: Record<string, string> = { test: "node --test" },
  options: { testFile?: string | null; extraFiles?: Record<string, string>; expect?: "accepted" | "not_accepted"; pathPrefix?: string; observe?: DeliveryFactoryObservation } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "aiboard delivery factory "));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "delivery-factory-fixture", version: "1.0.0", type: "module", packageManager: "npm@11.0.0", scripts }, null, 2));
  // null = the project has no test files at all (the test command runs zero tests).
  if (options.testFile !== null) writeFileSync(join(project, "test", "value.test.mjs"), options.testFile ?? VALUE_TEST);
  for (const [path, text] of Object.entries(options.extraFiles ?? {})) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  }
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const lock = spawnSync(process.execPath, [npmCli, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: project, encoding: "utf8" });
  assert.equal(lock.status, 0, lock.stderr);
  const runRoot = join(state, "builds", safeSegment(RUN_ID));
  mkdirSync(runRoot, { recursive: true });
  const seed = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"));
  for (const input of planningEvents()) seed.append(input);
  // T7b: the ready plan waits for its explicit owner start. The fixture
  // acts as owner through the genuine authorization event, covering the
  // kernel's own current ready identity (no authority is invented).
  const startIdentity = currentExplicitStartIdentity(rebuildSchedulerProjection(seed.readRun(RUN_ID)));
  assert.ok(startIdentity, "the fixture plan is ready with a complete start identity");
  seed.append({
    runId: RUN_ID,
    type: "planning.execution_authorized",
    occurredAt: CLOCK,
    actor: { role: "user", id: "local-user" },
    idempotencyKey: "owner-start",
    payload: { authorization: { ...startIdentity, version: 1, ownerChoice: "execute" } },
  });
  seed.close();
  const reviewer = new ReviewerModel(options.observe);
  const pauseDetail = () => JSON.stringify((handle!.runtime as unknown as { store: SqliteSchedulerStore }).store.readRun(RUN_ID).filter((item) => item.type === "run.paused").at(-1)?.payload);
  const worker = new WorkerModel(content, options.observe, options.testFile === null ? DELIVERY_VALIDATION_SCOPE_NO_TESTS : DELIVERY_VALIDATION_SCOPE);
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: withPathPrefix(snapshotNativeBuildAmbientEnvironment(), options.pathPrefix),
  });
  // T7a/T7b: the seeded source_registered manifest names SOURCE_TEXT bytes.
  // Provision the exact bytes into the same artifact store the factory
  // reads before factory.create; the stored hash must be the manifest
  // authority (no source authority is faked or bypassed).
  const { manifest: sourceManifest } = scenario();
  const storedSource = await executionHost.artifacts.put(Buffer.from(SOURCE_TEXT, "utf-8"), "text/plain", "approved source");
  assert.equal(storedSource.hash, sourceManifest.artifactDigest, "the stored source bytes are the manifest authority");
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  try {
    const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: RUN_ID });
    factory = new NativeBuildFactory({
      projectRoot: project,
      stateDirectory: state,
      providerConfigs: {
        load: () => [provider("arch:architect", 1), provider("work:worker", 2), provider("rev:reviewer", 3)],
        save: () => undefined,
        close: () => undefined,
      },
      executionHost,
      baselineFor: () => baseline.revision,
      providerModelFactory: (config) => config.runtimeId === "arch:architect"
        ? new ArchitectModel(() => handle!.runtime.projection())
        : config.runtimeId === "work:worker" ? worker : reviewer,
    });
    handle = await factory.create(await factory.prepareSpec({
      version: 2,
      runId: RUN_ID,
      projectId: "delivery-fixture",
      objective: "Deliver the value module.",
      planningPolicy: { version: 1 },
      architectRuntimeId: "arch:architect",
      workerRuntimeIds: ["work:worker"],
      verifierRuntimeIds: ["rev:reviewer"],
      alwaysRequireIndependentVerifier: false,
      maxConcurrency: 1,
      permissionProfile: "full",
      runPolicy: "finish",
      planCritique: "off",
      budgetLimits: {},
      createdAt: CLOCK,
      idempotencyKey: "delivery-factory",
    }));
    const actions: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      const projection = handle.runtime.projection();
      if (Object.keys(projection.delivery?.phaseAcceptances ?? {}).length > 0) break;
      if (options.expect === "not_accepted" && projection.delivery?.boundaries.T1?.length) break;
      const result = await handle.runtime.step();
      actions.push(result.action ?? result.status);
      if (result.status === "paused") break;
    }
    const projection = handle.runtime.projection();
    assert.equal(projection.status === "paused", false, `${actions.join(",")} :: ${JSON.stringify(projection.pauseReason)} :: ${pauseDetail()} :: ${JSON.stringify(projection.delivery?.boundaries.T1)}`);
    const review = projection.delivery?.reviews.T1;
    assert.ok(review, actions.join(","));
    assert.equal(review.stage, "completed");
    assert.equal(review.independence, "distinct_model");
    assert.equal(review.reviewerRuntimeId, "rev:reviewer");
    assert.ok(review.depth!.inspectionToolCalls >= 1, "the reviewer really inspected the task checkout");
    assert.deepEqual(review.claims!.map((claim) => claim.id), ["claim:c1", "claim:summary"]);
    assert.match(review.claims!.at(-1)!.text, /Added src\/value\.mjs/, "the summary claim is the worker's own submit_task summary");
    assert.ok(reviewer.passes.includes("delivery-findings-system") && reviewer.passes.includes("delivery-verdict-system"));
    const boundary = projection.delivery!.boundaries.T1!.at(-1)!;
    if (options.expect === "not_accepted") {
      assert.equal(boundary.passed, false, JSON.stringify(boundary));
      assert.equal(projection.tasks.T1!.status, "integrated");
      return { review, boundary, projection, manifests: handle!.contextManifests?.() ?? [] };
    }
    const testsCheck = boundary.checks.find((check) => check.checkId === "tests")!;
    assert.equal(testsCheck.report?.status, "passed", JSON.stringify(testsCheck));
    assert.ok((testsCheck.report?.counts?.passed ?? 0) >= 1, "real counts: at least one executed test");
    assert.match(testsCheck.report!.artifactHash!, /^[a-f0-9]{64}$/);
    assert.equal(boundary.passed, true, JSON.stringify(boundary));
    assert.equal(boundary.integrationRevision, projection.integrationRevision);
    assert.ok(boundary.checks.some((check) => check.checkId === "tests" && check.outcome === "passed" && check.evidenceIds.length > 0));
    assert.deepEqual(boundary.changedFiles, ["src/value.mjs"]);
    assert.ok(projection.delivery!.taskAcceptances.T1, actions.join(","));
    const phase = projection.delivery!.phaseAcceptances["revision_value:P1"];
    assert.ok(phase, actions.join(","));
    assert.deepEqual(phase.exitChecks.map((check) => check.checkId), ["tests"]);
    const readiness = buildCompletionReadiness(projection);
    assert.equal(readiness.issues.some((issue) => /acceptance|conditional_pending|coverage/i.test(issue)), false, readiness.issues.join(" | "));
    return { review, boundary, projection, manifests: handle!.contextManifests?.() ?? [] };
  } finally {
    await handle?.close();
    await factory?.close();
    await executionHost.close();
    rmSync(root, { recursive: true, force: true });
  }
}
