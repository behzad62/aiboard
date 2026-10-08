import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import {
  buildExecutionPlanRevision,
  T1A_SEEDED_HOST_PLANNING_CAPABILITIES,
  type CoverageReview,
  type ExecutionPlanPhase,
  type ExecutionTaskContract,
  type SourceRequirement,
} from "../src/planning-contracts.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import {
  currentExplicitStartIdentity,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerActorRole,
  type SchedulerProjection,
} from "../src/scheduler-store.js";
import { buildSourceManifest } from "../src/source-manifest.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { captureGitBaseline, NativeBuildFactory } from "./support/git-fixture.js";

/**
 * IV-2 (CD-23/EP16) product journey: an authentic unseeded
 * NativeBuildFactory -> BuildRuntime.step journey over real
 * SQLite/Git/artifacts/executor. A high-tier npm-workspaces change runs
 * the affected package's tests selected at BOTH the review-depth and the
 * integrated-boundary gates while the untouched package's failing
 * sentinel never executes. Only the model transport is scripted.
 */

const RUN_ID = "run-iv2-journey";
const CLOCK = "2026-09-25T00:00:00.000Z";
const SOURCE_TEXT = "SECTION 1: MANDATORY. Package a must export a = 1.";
const A_SRC = "packages/a/src/a.mjs";
const A_TEST = "packages/a/test/a.test.mjs";
const SENTINEL_TEST = "packages/b/test/sentinel.test.mjs";

const A_BASELINE = "export const a = 0;\n";
const A_WORKER = "export const a = 1;\n" + Array.from({ length: 150 }, (_, index) => `export const filler${index} = ${index} + 1;\n`).join("");
const A_TEST_CONTENT = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { a } from "../src/a.mjs";',
  'test("a is one", () => assert.equal(a, 1));',
  'test("a is numeric", () => assert.equal(typeof a, "number"));',
  "",
].join("\n");
const SENTINEL_CONTENT = [
  'import test from "node:test";',
  'test("full-only sentinel", () => { throw new Error("SENTINEL RAN: the full suite executed"); });',
  "",
].join("\n");

const IV2_SCOPE = {
  changed: [A_SRC],
  verified: ["a exports 1"],
  testsRun: [{ command: `node --test ${A_TEST}`, counts: { selected: 2, passed: 2, failed: 0, skipped: 0 } }],
  notRun: [{ what: "package b tests", why: "no change under packages/b" }],
};

function scenario() {
  const manifest = buildSourceManifest(Buffer.from(SOURCE_TEXT, "utf-8"), [{ id: "s1", startByte: 0, endByte: Buffer.byteLength(SOURCE_TEXT) }], {
    manifestId: "manifest_iv2",
    sourceId: "source_iv2",
    mediaType: "text/plain",
    encoding: "utf-8",
    authority: "owner",
    createdAt: "2026-09-24T00:00:00.000Z",
  });
  const requirements: SourceRequirement[] = [{
    id: "REQ-1",
    reference: { sourceId: manifest.sourceId, sectionIds: ["s1"] },
    purpose: "Export a = 1 from package a.",
    observableOutcome: "Package a exports 1.",
    obligationKind: "mandatory",
    applicability: { status: "applicable" },
    accountablePhaseId: "P1",
    contributingTaskIds: ["T1"],
    acceptanceConditions: [{ id: "REQ-1-ac1", description: "a is 1.", responsibleGateId: "P1-exit", requiredEvidenceKinds: ["command"] }],
  }];
  const phases: ExecutionPlanPhase[] = [{
    id: "P1",
    purpose: "Deliver package a.",
    requirementIds: ["REQ-1"],
    scope: { includes: [A_SRC], excludes: ["docs/project/STATE.md"] },
    entryConditions: ["Plan ready."],
    contributingTaskIds: ["T1"],
    exitCriteria: ["Package a is accepted."],
    // F4: T1 closes P1, so a tests gate here would force the whole suite
    // (the milestone rule). The typecheck gate keeps this journey on the
    // selected path while the phase still closes on a real check.
    requiredCombinedValidation: ["typecheck"],
    exitUnlocks: ["final verification"],
  }];
  const tasks: ExecutionTaskContract[] = [{
    id: "T1",
    lineage: [],
    accountablePhaseId: "P1",
    requirementIds: ["REQ-1"],
    outcome: { user: `Create ${A_SRC} exporting a = 1.`, system: "Package a exports 1." },
    scope: { includes: [A_SRC], excludes: [A_TEST] },
    writableSurfaces: [A_SRC],
    forbiddenSurfaces: [A_TEST, SENTINEL_TEST],
    dependencies: [],
    requiredBase: "accepted plan revision revision_iv2",
    inputs: ["accepted plan revision"],
    outputs: [A_SRC],
    steps: ["Write the module.", "Run the package tests."],
    acceptance: { criteria: [{ id: "c1", text: `${A_SRC} exports a = 1 and the package tests pass.` }], definitionOfDone: "Tests pass." },
    validation: { targetedRationale: "The package a test.", affectedScopeRationale: "The module only." },
    negativeProofApplicability: { applicable: false, rationale: "A new module has no prior-incorrect case." },
    reviewCriteria: ["Independent review confirms the value."],
    integrationChecks: ["Post-integration tests."],
    cleanup: { cleanup: "None.", recovery: "Retry.", rollback: "Revert." },
    requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-1" }],
  }];
  const revision = buildExecutionPlanRevision({
    revisionId: "revision_iv2",
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
    id: "coverage_iv2",
    runId: RUN_ID,
    reviewerRuntimeId: "reviewer:distinct-model",
    independence: "distinct_model",
    sourceReadManifestId: manifest.manifestId,
    planRevisionId: revision.revisionId,
    planRevisionDigest: revision.digest,
    derivedObligations: [{ id: "obl-REQ-1", requirementId: "REQ-1", description: "Export 1.", recordedBeforePlanOrDiffProvided: true, recordedAt: "2026-09-24T00:05:00.000Z" }],
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
    // The real provisioned prefix (T7a): docs v2, run.initialized carrying
    // the IV-2-relevant policy versions plus the spec objective, then
    // planning policy. The factory reuses this prefix verbatim.
    e("project_docs.policy_configured", "project-docs-policy", "runner", "build-runtime", { version: 2 }),
    e("run.initialized", "run-initialized", "runner", "build-runtime", { testIntegrityPolicyVersion: 1, validationScopePolicyVersion: 1, objective: "Deliver package a." }),
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

class WorkerModel implements AgentModel {
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const toolCount = request.messages.filter((message) => message.role === "tool").length;
    if (toolCount === 0) return call("fs.read", { path: A_SRC }, "read-1");
    if (toolCount === 1) {
      const read = lastToolValue(request) as { sha256: string };
      return call("fs.write", { path: A_SRC, content: A_WORKER, expectedSha256: read.sha256 }, "write-1");
    }
    if (toolCount === 2) return call("run_evidence_command", { label: "tests", command: process.execPath, args: ["--test", A_TEST] }, "evidence-1");
    const record = lastToolValue(request)!;
    const fact = record.fact as { stdoutArtifactHash: string };
    return call("submit_task", {
      summary: `Added ${A_SRC} exporting a = 1; package tests pass.`,
      readiness: "ready_for_architect_review",
      unresolvedConcerns: [],
      criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [fact.stdoutArtifactHash] }],
      validationScope: IV2_SCOPE,
    }, "submit-1");
  }
}

class ReviewerModel implements AgentModel {
  readonly passes: string[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const system = request.messages.find((message) => message.role === "system");
    const pass = system?.id ?? "";
    this.passes.push(pass);
    const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
    const tools = request.messages.filter((message) => message.role === "tool").length;
    if (pass === "delivery-obligations-system") {
      return call("record_deliverable_obligations", { obligations: [{ id: "o1", description: "a must be 1." }] }, `obl-${tools}`);
    }
    if (pass === "delivery-findings-system") {
      if (tools === 0) return call("fs.read", { path: A_SRC }, "read-1");
      return call("record_deliverable_findings", { findings: [] }, `findings-${tools}`);
    }
    const claimIds = [...new Set([...text.matchAll(/"id"\s*:\s*"(claim:[^"]+)"/g)].map((match) => match[1]!))];
    return call("submit_deliverable_verdict", {
      summary: "The module exports 1 and the cited test run passed.",
      satisfied: true,
      claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Confirmed in the checkout." })),
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

test("IV-2 product journey: a high-tier workspaces change runs selected at depth and boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard iv2 journey "));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({
    name: "iv2-journey-fixture", version: "1.0.0", type: "module", packageManager: "npm@11.0.0",
    scripts: { test: "node --test", build: "node scripts/typecheck.mjs" }, workspaces: ["packages/a", "packages/b"],
  }, null, 2));
  const files: Record<string, string> = {
    "packages/a/package.json": JSON.stringify({ name: "a", version: "1.0.0" }),
    [A_SRC]: A_BASELINE,
    [A_TEST]: A_TEST_CONTENT,
    "packages/b/package.json": JSON.stringify({ name: "b", version: "1.0.0" }),
    "packages/b/src/b.mjs": "export const b = 2;\n",
    [SENTINEL_TEST]: SENTINEL_CONTENT,
    "scripts/typecheck.mjs": 'import { readFileSync } from "node:fs"; const source = readFileSync(new URL("../packages/a/src/a.mjs", import.meta.url), "utf8"); if (!source.includes("export const a = 1")) throw new Error("a export missing");\n',
  };
  for (const [path, text] of Object.entries(files)) {
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
  // T7b: the ready plan waits for its explicit owner start. The test acts as
  // owner through the genuine authorization event, covering the kernel's own
  // current ready identity (no authority is seeded or invented).
  const startIdentity = currentExplicitStartIdentity(rebuildSchedulerProjection(seed.readRun(RUN_ID)));
  assert.ok(startIdentity, "the journey plan is ready with a complete start identity");
  seed.append({
    runId: RUN_ID,
    type: "planning.execution_authorized",
    occurredAt: CLOCK,
    actor: { role: "user", id: "local-user" },
    idempotencyKey: "iv2-journey-owner-start",
    payload: { authorization: { ...startIdentity!, version: 1, ownerChoice: "execute" } },
  });
  seed.close();
  // The factory and the pump verify the registered source bytes before any
  // consumer reads them: the exact journey bytes hash to the manifest digest.
  const { manifest: journeyManifest } = scenario();
  const journeyArtifacts = new ArtifactStore(join(state, "artifacts"));
  const storedSource = await journeyArtifacts.put(Buffer.from(SOURCE_TEXT, "utf-8"), "text/plain", "iv2 journey approved source");
  assert.equal(storedSource.hash, journeyManifest.artifactDigest, "the stored source bytes are the manifest authority");
  const reviewer = new ReviewerModel();
  const worker = new WorkerModel();
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
  });
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
      projectId: "iv2-journey-fixture",
      objective: "Deliver package a.",
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
      idempotencyKey: "iv2-journey",
    }));
    const actions: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      const projection = handle.runtime.projection();
      if (Object.keys(projection.delivery?.phaseAcceptances ?? {}).length > 0) break;
      const result = await handle.runtime.step();
      actions.push(result.action ?? result.status);
      if (result.status === "paused") break;
    }
    const projection = handle.runtime.projection();
    const lastBoundary = projection.delivery?.boundaries?.T1?.at(-1);
    assert.equal(projection.status === "paused", false, `${actions.join(",")} :: ${JSON.stringify({ pauseReason: projection.pauseReason, boundary: lastBoundary })}`);
    const review = projection.delivery?.reviews.T1;
    assert.ok(review, actions.join(","));
    assert.equal(review.stage, "completed");
    assert.equal(review.risk!.tier, "high");
    assert.equal(review.depth!.affectedTests!.executedScope, "selected", "review depth runs the selected tests");
    assert.deepEqual(review.depth!.affectedTests!.selectedTests, [A_TEST]);
    assert.ok(review.depth!.probe!.mutantsExecuted >= 1, "the probe executes against the selected command");
    const boundary = lastBoundary!;
    assert.equal(boundary.executedScope, "selected", "the boundary runs the selected tests");
    assert.equal(boundary.selection.rung, "module_graph");
    assert.deepEqual(boundary.selection.selectedTests, [A_TEST]);
    const testsCheck = boundary.checks.find((check) => check.checkId === "tests")!;
    assert.deepEqual(testsCheck.args!.slice(-2), ["--", A_TEST]);
    assert.equal(testsCheck.report?.status, "passed");
    assert.deepEqual(testsCheck.report?.counts, { selected: 2, passed: 2, failed: 0, skipped: 0 });
    assert.equal(boundary.passed, true, "the failing sentinel never ran");
    assert.deepEqual(boundary.changedFiles, [A_SRC]);
    assert.ok(projection.delivery!.taskAcceptances.T1, actions.join(","));
    assert.ok(projection.delivery!.phaseAcceptances["revision_iv2:P1"], actions.join(","));
  } finally {
    await handle?.close();
    await factory?.close();
    await executionHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});
