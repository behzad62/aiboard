import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentModel,
  AgentModelRequest,
  ModelTurn,
} from "../src/agent-contracts.js";
import {
  buildExecutionPlanRevision,
  T1A_SEEDED_HOST_PLANNING_CAPABILITIES,
  type CoverageReview,
  type ExecutionPlanPhase,
  type ExecutionTaskContract,
  type SourceRequirement,
} from "../src/planning-contracts.js";
import type { FinalVerificationPlan } from "../src/final-verification-contracts.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import {
  buildCompletionReadiness,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerActorRole,
  type SchedulerProjection,
} from "../src/scheduler-store.js";
import { buildSourceManifest } from "../src/source-manifest.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { assertAcceptanceCriteria } from "../src/acceptance-contracts.js";
import type { ChangeSet } from "../src/change-set.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import {
  NativeBuildFactory,
  IntegrationManager,
  WorkspaceManager,
  captureGitBaseline,
  runGit,
} from "./support/git-fixture.js";
import { seedEvent } from "./support/handoff-snapshot-harness.js";

/**
 * C3c: revision targeting after a mid-run kernel snapshot, and task/integration
 * commit trailers (SRC-A C3 steps 5 and 6; AR-R10; CD-11).
 *
 * The journey below builds a docs-v2 finish run through NativeBuildFactory and
 * drives it with BuildRuntime.step on real SQLite: a scripted worker really
 * writes a file and submits; the run pauses (kernel stop snapshot S1),
 * resumes, integrates the task, plans and executes final verification with a
 * second pause (snapshot S2) in the middle, and reaches handoff (snapshot S3).
 * Only model transport is scripted. Real git ancestry and trailers are
 * inspected at the end.
 */

const RUN = "run-c3c-stop-revision";
const CLOCK = "2026-09-25T00:00:00.000Z";
const SOURCE_TEXT = "SECTION 1: MANDATORY. The value module must export the value 2.";
const LOW_CONTENT = "export const value = 2;\n";
const VALUE_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value', () => assert.equal(value, 2));\n";
const NOTES_TEXT = "Next: keep the value module as is. Trap: do not hand-edit docs/project/STATE.md. Try: run the value test.";

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
    // C3c: the kernel materializes scheduler criteria as stable task-local
    // ids (schedulerTaskFromContract maps id/text); the trailer names those.
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
    runId: RUN,
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
    runId: RUN,
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
    seedEvent(RUN, type, key, role, id, payload);
  return [
    // C3c: docs policy v2 (stop snapshots) on a finish run with a real task.
    e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }),
    e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }),
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

const textTurn = (text: string): ModelTurn => ({
  blocks: [{ type: "text", text }],
  stopReason: "end_turn",
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
    if (toolCount === 0) return call("fs.write", { path: "src/value.mjs", content: LOW_CONTENT, createDirectories: true }, "write-1");
    if (toolCount === 1) return call("run_evidence_command", { label: "tests", command: process.execPath, args: ["--test"] }, "evidence-1");
    const record = lastToolValue(request)!;
    const fact = record.fact as { stdoutArtifactHash: string };
    return call("submit_task", {
      summary: "Added src/value.mjs exporting value = 2; node --test passes.",
      readiness: "ready_for_architect_review",
      unresolvedConcerns: [],
      criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [fact.stdoutArtifactHash] }],
    }, "submit-1");
  }
}

class ReviewerModel implements AgentModel {
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const system = request.messages.find((message) => message.role === "system");
    const pass = system?.id ?? "";
    const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
    const tools = request.messages.filter((message) => message.role === "tool").length;
    if (pass === "delivery-obligations-system") {
      return call("record_deliverable_obligations", { obligations: [{ id: "o1", description: "value must be 2." }] }, `obl-${tools}`);
    }
    if (pass === "delivery-findings-system") {
      if (tools === 0) return call("fs.read", { path: "src/value.mjs" }, "read-1");
      return call("record_deliverable_findings", { findings: [] }, `findings-${tools}`);
    }
    const claimIds = [...new Set([...text.matchAll(/"id": "(claim:[^"]+)"/g)].map((match) => match[1]!))];
    return call("submit_deliverable_verdict", {
      summary: "The module exports 2 and the cited test run passed.",
      satisfied: true,
      claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Confirmed in the checkout." })),
    }, `verdict-${tools}`);
  }
}

function fvPlan(): FinalVerificationPlan {
  const na = (category: "build" | "runtime_smoke" | "browser"): FinalVerificationPlan["checks"][number] => ({
    category,
    status: "not_applicable",
    rationale: `The fixture has no ${category} entry point.`,
    repositoryInspection: { paths: ["package.json"], summary: `The fixture package has no ${category} entry point.` },
  });
  return {
    checks: [
      na("build"),
      { category: "tests", status: "required" },
      na("runtime_smoke"),
      na("browser"),
    ],
  };
}

class ArchitectModel implements AgentModel {
  notesCalls = 0;
  constructor(private readonly projection: () => SchedulerProjection) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    // C3b one-shot stop notes: no tools offered, fixed short text.
    if (request.tools.length === 0) {
      this.notesCalls += 1;
      return textTurn(NOTES_TEXT);
    }
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
    if (task.status === "integrated") {
      const current = projection.finalVerification?.current;
      if (!current) {
        return call("plan_final_verification", { plan: fvPlan() }, `fv-plan-${request.messages.length}-${tools}`);
      }
      if (current.review?.status === "requested" && current.submission && current.submissionResult) {
        const submission = current.submissionResult;
        return call("review_final_verification", {
          taskId: current.taskId,
          generationId: current.generationId,
          targetRevision: current.targetRevision,
          submissionId: current.submission.submissionId,
          attempt: current.submission.attempt,
          decision: "approved",
          summary: "Final verification is green on the integrated revision.",
          architectRisk: "low",
          architectRiskRationale: "A single new module with passing tests.",
          categoryReviews: submission.checks.map((check) => ({
            category: check.category,
            verdict: "approved",
            rationale: check.status === "required" ? "Executed green with evidence." : "Not applicable to this fixture.",
            evidenceIds: [...check.evidenceIds],
          })),
        }, `fv-review-${request.messages.length}-${tools}`);
      }
      if (current.review?.status === "approved" && !projection.projectHandoff) {
        return call("complete_run", { summary: "The value module is delivered and verified." }, `complete-${request.messages.length}-${tools}`);
      }
    }
    throw new Error(`Unexpected Architect turn with T1 ${task.status}, fv ${projection.finalVerification?.current?.generationId ?? "none"}/${projection.finalVerification?.current?.review?.status ?? "none"}.`);
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

/** The trailing contiguous `Key: value` trailer block of a commit message. */
function trailerBlock(body: string): Set<string> {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const block = new Set<string>();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!/^[A-Za-z0-9-]+:[ \t]+\S/.test(line)) break;
    block.add(line);
  }
  return block;
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await runGit({ cwd, args })).stdout.trim();
}

function snapshotCommits(events: { type: string }[]): { sequence: number; payload: Record<string, unknown> }[] {
  return (events as { sequence: number; type: string; payload: Record<string, unknown> }[])
    .filter((event) => event.type === "project_docs.handoff_snapshot_committed")
    .map((event) => ({ sequence: event.sequence, payload: event.payload }));
}

function integrationRepoPath(state: string): string {
  const entries = readdirSync(join(state, "integration"));
  assert.equal(entries.length, 1);
  return join(state, "integration", entries[0]!);
}

/**
 * C3c journey (AR-R08 step 5, AR-R10 step 6, CD-11): pause -> kernel stop
 * snapshot -> resume -> post-snapshot task integration with runner trailers ->
 * final verification on the exact canonical revision (with a second
 * pause/snapshot mid-verification) -> handoff snapshot. Real
 * NativeBuildFactory, BuildRuntime.step, SQLite and git; only model transport
 * is scripted. A harness that only steps a pre-completed task would not prove
 * post-snapshot integration, so the worker submits after the first snapshot.
 */
test("C3c: pause/snapshot/resume/task integration/final verification/handoff target the current revision with trailers", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-c3c-revision-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "c3c-revision-fixture", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(project, "test", "value.test.mjs"), VALUE_TEST);
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: RUN });
  const runRoot = join(state, "builds", safeSegment(RUN));
  mkdirSync(runRoot, { recursive: true });
  const seeder = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"));
  for (const input of planningEvents()) seeder.append(input);
  seeder.close();
  const reviewer = new ReviewerModel();
  const worker = new WorkerModel();
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
  });
  let factory: NativeBuildFactory | undefined;
  let manager: NativeBuildManager | undefined;
  let runtime: { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection } | undefined;
  try {
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
        ? new ArchitectModel(() => runtime!.projection())
        : config.runtimeId === "work:worker" ? worker : reviewer,
    });
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: (spec) => factory!.create(spec).then((handle) => {
        runtime = handle.runtime as typeof runtime;
        return handle;
      }),
      prepareSpec: (spec) => factory!.prepareSpec(spec),
    });
    await manager.create(await factory.prepareSpec({
      version: 2,
      runId: RUN,
      projectId: "c3c-fixture",
      objective: "Deliver the value module.",
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
      idempotencyKey: "c3c-stop-revision",
    }));
    const stepUntil = async (label: string, done: (projection: SchedulerProjection) => boolean, cap: number): Promise<SchedulerProjection> => {
      for (let step = 0; step < cap; step += 1) {
        const projection = runtime!.projection();
        if (done(projection)) return projection;
        if (projection.status === "paused") {
          throw new Error(`${label}: run paused unexpectedly (${JSON.stringify(projection.pauseReason)})`);
        }
        await runtime!.step();
      }
      const projection = runtime!.projection();
      if (done(projection)) return projection;
      throw new Error(`${label}: not reached within ${cap} steps (T1 ${projection.tasks.T1?.status}, fv ${projection.finalVerification?.current?.generationId ?? "none"})`);
    };

    // The worker really submits after the run starts (pre-snapshot work is
    // real, not a seeded completion).
    await stepUntil("task submitted", (projection) => projection.tasks.T1?.status === "submitted", 60);
    assert.equal(runtime!.projection().integrationRevision, undefined, "nothing integrated yet");

    // Pause -> kernel stop snapshot S1 on the integration branch.
    await manager.pause(RUN, "user", "pause:c3c-midrun");
    let events = manager.events(RUN);
    let snapshots = snapshotCommits(events);
    assert.equal(snapshots.length, 1, "the mid-run pause commits exactly one stop snapshot");
    const stopPayload = snapshots[0]!.payload;
    assert.equal(stopPayload.stopKind, "paused");
    const stopCommit = String(stopPayload.commit);
    assert.equal(await gitText(integrationRepoPath(state), ["rev-list", "--count", `${baseline.revision}..HEAD`]), "1");
    // C2/CD-11 semantics (inherited, not this packet): with no canonical
    // revision and no prior tip, a pre-integration snapshot does not start
    // the document chain -- the reducer only advances the tip past a commit
    // continuing the canonical revision or the tip.
    assert.equal(runtime!.projection().projectDocs?.documentTip, undefined, "no canonical chain yet: the pre-integration snapshot leaves the tip unset");
    assert.equal(runtime!.projection().integrationRevision, undefined, "a kernel snapshot is not an integration revision");

    // Resume -> the submitted task integrates past the snapshot.
    await manager.resume(RUN, "resume:c3c-midrun");
    const integrated = await stepUntil("task integrated", (projection) => projection.tasks.T1?.status === "integrated", 60);
    const canonical = integrated.integrationRevision!;
    assert.ok(canonical, "integration records a canonical revision");
    assert.equal(integrated.tasks.T1?.integrationRevision, canonical);
    assert.equal(
      await gitText(integrationRepoPath(state), ["merge-base", "--is-ancestor", stopCommit, canonical]),
      "",
      "integration descends from the stop snapshot",
    );
    assert.equal(integrated.projectDocs?.documentTip, undefined, "task integration clears the snapshot tip");
    const repoPath = integrationRepoPath(state);
    const integrationBody = await gitText(repoPath, ["log", "-1", "--format=%B", canonical]);
    assert.match(integrationBody, /\(cherry picked from commit [a-f0-9]{40}\)/, "the integration commit is the runner cherry-pick");
    const integrationTrailers = trailerBlock(integrationBody);
    assert.ok(integrationTrailers.has(`AIBoard-Run: ${RUN}`), "runner stamps the run trailer");
    assert.ok(integrationTrailers.has("AIBoard-Task: T1"), "runner stamps the task trailer");
    assert.ok(
      integrationTrailers.has("AIBoard-Requirements: c1"),
      `runner stamps the accepted criterion id (got: ${[...integrationTrailers].join(" | ")})`,
    );
    const meta = await gitText(repoPath, ["log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce", canonical]);
    const [authorName, authorEmail, committerName, committerEmail] = meta.split("\0");
    assert.equal(authorName, "AIBoard Worker", "the integrated commit keeps the worker author");
    assert.equal(committerName, "AIBoard Integrator", "the integration commit is runner-committed");

    // Final verification plans the exact canonical revision.
    const planned = await stepUntil(
      "final verification planned",
      (projection) => projection.finalVerification?.current?.targetRevision === canonical,
      60,
    );
    const generation = planned.finalVerification!.current!;
    assert.equal(generation.targetRevision, canonical);

    // Execute the first check, then pause mid-verification: snapshot S2 must
    // not strand the remaining checks on a stale branch.
    await stepUntil(
      "first verification check completed",
      (projection) => (projection.finalVerification?.current?.completedChecks?.length ?? 0) >= 1,
      60,
    );
    await manager.pause(RUN, "user", "pause:c3c-midverify");
    events = manager.events(RUN);
    snapshots = snapshotCommits(events);
    assert.equal(snapshots.length, 2, "the mid-verification pause commits a second stop snapshot");
    const midPayload = snapshots[1]!.payload;
    assert.equal(midPayload.stopKind, "paused");
    assert.equal(String(midPayload.revision), canonical, "the mid-verification snapshot names the canonical revision");
    const midCommit = String(midPayload.commit);
    assert.equal(runtime!.projection().projectDocs?.documentTip, midCommit);
    await manager.resume(RUN, "resume:c3c-midverify");

    // To handoff: remaining checks execute on the canonical revision, the
    // submission/review/decision follow, and the handoff snapshot lands.
    await stepUntil(
      "handoff requested",
      (projection) => projection.projectHandoff?.status === "requested",
      120,
    );
    const beforeHandoff = runtime!.projection();
    const finished = beforeHandoff.finalVerification!.current!;
    assert.equal(finished.targetRevision, canonical, "verification still targets the canonical revision");
    assert.equal(finished.submission?.targetRevision, canonical);
    assert.equal(finished.submissionResult?.targetRevision, canonical);
    assert.equal(finished.review?.status, "approved");
    for (const check of finished.completedChecks ?? []) {
      for (const fact of check.facts) {
        if (fact.kind === "command" && "repositoryRevision" in fact) {
          assert.equal(
            (fact as { repositoryRevision: string }).repositoryRevision,
            canonical,
            `check ${check.category} executed on the recorded revision`,
          );
        }
      }
    }
    events = manager.events(RUN);
    snapshots = snapshotCommits(events);
    assert.equal(snapshots.length, 3, "handoff commits the third snapshot");
    const handoffPayload = snapshots[2]!.payload;
    assert.equal(String(handoffPayload.revision), canonical, "the handoff snapshot hands off the verified revision");
    const handoffCommit = String(handoffPayload.commit);
    for (const ancestor of [stopCommit, canonical, midCommit]) {
      assert.equal(
        await gitText(repoPath, ["merge-base", "--is-ancestor", ancestor, handoffCommit]),
        "",
        `${ancestor.slice(0, 12)} is an ancestor of the handoff commit`,
      );
    }
    assert.equal(await gitText(repoPath, ["rev-list", "--count", `${baseline.revision}..HEAD`]), "4");

    // Every commit is classified: kernel snapshots carry snapshot trailers
    // and no task evidence; the integration commit carries task trailers and
    // the cherry-pick line but no snapshot key (docs commits are never task
    // integration evidence and vice versa).
    const lineage = (await gitText(repoPath, ["log", "--reverse", "--format=%H", `${baseline.revision}..HEAD`])).split("\n");
    assert.deepEqual(lineage, [stopCommit, canonical, midCommit, handoffCommit]);
    for (const [revision, kind] of [[stopCommit, "snapshot"], [canonical, "integration"], [midCommit, "snapshot"], [handoffCommit, "snapshot"]] as const) {
      const body = await gitText(repoPath, ["log", "-1", "--format=%B", revision]);
      const block = trailerBlock(body);
      if (kind === "snapshot") {
        assert.ok([...block].some((line) => line.startsWith("AIBoard-Snapshot-Key: ")), `${revision.slice(0, 12)} carries a snapshot key`);
        assert.ok(block.has("AIBoard-Generated: handoff-snapshot"));
        assert.ok(!block.has("AIBoard-Task: T1"), "a kernel snapshot is not task evidence");
        assert.ok(!body.includes("cherry picked from commit"), "a kernel snapshot is not an integration commit");
      } else {
        assert.ok(![...block].some((line) => line.startsWith("AIBoard-Snapshot-Key: ")), "the integration commit is not a snapshot");
        assert.ok(block.has(`AIBoard-Run: ${RUN}`));
        assert.ok(block.has("AIBoard-Task: T1"));
        assert.ok(block.has("AIBoard-Requirements: c1"));
      }
    }

    // The explicit owner handoff completes the run after the snapshots.
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c3c-stop-revision");
    assert.equal(selected.status, "completed");
    assert.equal(selected.projectHandoff?.status, "selected");
  } finally {
    await manager?.close();
    await factory?.close();
    await executionHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function trailerFixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `aiboard-c3c-${label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  const runId = `run_c3c_${label}`;
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const workspaces = new WorkspaceManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
  });
  const integration = new IntegrationManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
  });
  await integration.initialize();
  return { root, project, state, runId, baseline, workspaces, integration };
}

/**
 * C3c trailers (AR-R10 step 6) at the IntegrationManager level: a new-policy
 * integration stamps AIBoard-Run/Task/Requirements on every cherry-picked
 * commit (from the accepted contract, never model free text); the legacy path
 * without the policy flag stays byte-identical; recovery still finds the
 * integration by its cherry-pick line (docs commits never match it).
 */
test("C3c: new-policy integration stamps trailers per commit; legacy stays byte-identical", async () => {
  const fixture = await trailerFixture("trailers");
  try {
    const alpha = await fixture.workspaces.createTaskWorkspace("alpha");
    writeFileSync(join(alpha.path, "alpha.txt"), "alpha\n");
    await fixture.workspaces.commitTask("alpha", "Add alpha");
    writeFileSync(join(alpha.path, "beta.txt"), "beta\n");
    const taskCommit = await fixture.workspaces.commitTask("alpha", "Add beta");
    assert.equal(taskCommit.commits.length, 2, "two worker commits");
    const workerBodies = new Map<string, string>();
    for (const revision of taskCommit.commits) {
      workerBodies.set(revision, await gitText(alpha.path, ["log", "-1", "--format=%B", revision]));
    }
    const legacy: ChangeSet = {
      id: "cs_legacy",
      runId: fixture.runId,
      taskId: "alpha",
      baselineRevision: taskCommit.baselineRevision,
      taskRevision: taskCommit.revision,
      commits: [...taskCommit.commits],
      changedPaths: [...taskCommit.changedPaths],
      diffArtifactHash: "0".repeat(64),
      evidenceArtifactHashes: [],
      externalEffects: [],
      guidanceIds: [],
      memoryIds: [],
      unresolvedConcerns: [],
    };
    const first = await fixture.integration.integrate(legacy);
    assert.equal(first.status, "integrated");
    const legacyLineage = (await gitText(fixture.integration.path, ["log", "--reverse", "--format=%H", `${fixture.baseline.revision}..HEAD`])).split("\n");
    assert.equal(legacyLineage.length, 2);
    for (const [index, revision] of legacyLineage.entries()) {
      const source = taskCommit.commits[index]!;
      const body = await gitText(fixture.integration.path, ["log", "-1", "--format=%B", revision]);
      assert.equal(
        body,
        `${workerBodies.get(source)}\n(cherry picked from commit ${source})`,
        "legacy integration is the byte-identical cherry-pick",
      );
      assert.ok(![...trailerBlock(body)].some((line) => line.startsWith("AIBoard-Requirements:")), "no requirements trailer on legacy runs");
    }

    const criteria = [
      { id: "c1", text: "Alpha holds.", requirementId: "REQ-1" },
      { id: "c2", text: "Beta holds." },
    ];
    assertAcceptanceCriteria(criteria);
    const beta = await fixture.workspaces.createTaskWorkspace("beta");
    writeFileSync(join(beta.path, "gamma.txt"), "gamma\n");
    const betaCommit = await fixture.workspaces.commitTask("beta", "Add gamma");
    const changeSet: ChangeSet = {
      id: "cs_beta",
      runId: fixture.runId,
      taskId: "beta",
      baselineRevision: betaCommit.baselineRevision,
      taskRevision: betaCommit.revision,
      commits: [...betaCommit.commits],
      changedPaths: [...betaCommit.changedPaths],
      acceptanceCriteria: criteria.map((criterion) => ({ ...criterion })),
      diffArtifactHash: "0".repeat(64),
      evidenceArtifactHashes: [],
      externalEffects: [],
      guidanceIds: [],
      memoryIds: [],
      unresolvedConcerns: [],
    };
    // C3c gate: new-policy runs stamp trailers; the cast keeps this compiling
    // both before the fix (options ignored) and after it.
    const integrateWithPolicy = fixture.integration.integrate.bind(fixture.integration) as (
      changeSet: ChangeSet,
      options?: { planningPolicyVersion?: number },
    ) => Promise<{ status: string; integrationRevision: string }>;
    const second = await integrateWithPolicy(changeSet, { planningPolicyVersion: 1 });
    assert.equal(second.status, "integrated");
    const betaBody = await gitText(fixture.integration.path, ["log", "-1", "--format=%B", second.integrationRevision]);
    assert.match(betaBody, new RegExp(`\\(cherry picked from commit ${betaCommit.revision}\\)`), "the cherry-pick line survives the trailer stamp");
    const betaBlock = trailerBlock(betaBody);
    assert.ok(betaBlock.has(`AIBoard-Run: ${fixture.runId}`));
    assert.ok(betaBlock.has("AIBoard-Task: beta"));
    assert.ok(betaBlock.has("AIBoard-Requirements: REQ-1 c2"), `run-level id preferred, task-local id kept (got: ${[...betaBlock].join(" | ")})`);

    // Recovery finds the trailer-stamped integration by its cherry-pick
    // line: generated docs commits (no such line) are never mistaken for it.
    const refs = (await gitText(fixture.project, ["for-each-ref", "--format=%(refname)"])).split("\n").filter((ref) => ref.includes("/integrated/"));
    assert.equal(refs.length, 2);
    await runGit({ cwd: fixture.project, args: ["update-ref", "-d", refs[1]!] });
    const recoveredManager = new IntegrationManager({
      repositoryRoot: fixture.project,
      stateDirectory: fixture.state,
      runId: fixture.runId,
      baselineRevision: fixture.baseline.revision,
    });
    await recoveredManager.initialize();
    const recovered = await (recoveredManager.integrate.bind(recoveredManager) as (
      changeSet: ChangeSet,
      options?: { planningPolicyVersion?: number },
    ) => Promise<{ status: string; integrationRevision: string }>)(changeSet, { planningPolicyVersion: 1 });
    assert.equal(recovered.status, "integrated");
    assert.equal(recovered.integrationRevision, second.integrationRevision, "recovery reuses the stamped integration commit");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

/**
 * C3c revision targeting, negative case: a change set whose base left the
 * run's integration history is refused fail-closed, and an integrated
 * revision unrelated to the document tip is reported as unrelated.
 */
test("C3c: a stale task base and an unrelated tip revision are refused", async () => {
  const fixture = await trailerFixture("stale");
  try {
    const alpha = await fixture.workspaces.createTaskWorkspace("alpha");
    writeFileSync(join(alpha.path, "alpha.txt"), "alpha\n");
    const taskCommit = await fixture.workspaces.commitTask("alpha", "Add alpha");
    const stale: ChangeSet = {
      id: "cs_stale",
      runId: fixture.runId,
      taskId: "alpha",
      baselineRevision: "f".repeat(40),
      taskRevision: taskCommit.revision,
      commits: [...taskCommit.commits],
      changedPaths: [...taskCommit.changedPaths],
      diffArtifactHash: "0".repeat(64),
      evidenceArtifactHashes: [],
      externalEffects: [],
      guidanceIds: [],
      memoryIds: [],
      unresolvedConcerns: [],
    };
    await assert.rejects(
      () => fixture.integration.integrate(stale),
      /not based on this run's integration history/,
      "a stale base never integrates",
    );
    assert.equal(await gitText(fixture.integration.path, ["rev-parse", "HEAD"]), fixture.integration.revision);
    await assert.rejects(
      () => fixture.integration.relateToDocumentTip({ revision: fixture.baseline.revision, tip: "e".repeat(40) }),
      /not related to the document tip/,
      "an unrelated tip revision fails closed",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

/**
 * C3c revision targeting, negative case: completion refuses a final
 * verification generation that targets a superseded revision.
 */
test("C3c: completion refuses final verification aimed at a stale revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-c3c-stalefv-"));
  try {
    const runId = "run_c3c_stalefv";
    const oldRevision = "a".repeat(40);
    const newRevision = "b".repeat(40);
    const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    const e = (type: string, key: string, role: SchedulerActorRole, id: string, payload: Record<string, unknown>): NewSchedulerEvent =>
      seedEvent(runId, type, key, role, id, payload);
    for (const input of [
      e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }),
      e("planning.policy_configured", "planning-policy", "runner", "build-runtime", { version: 1 }),
      e("integration.revision_advanced", "integration-old", "runner", "integration", { integrationRevision: oldRevision }),
      e("integration.revision_advanced", "integration-new", "runner", "integration", { integrationRevision: newRevision }),
    ]) store.append(input);
    const events = store.readRun(runId);
    // A stale generation object (as a planner could have recorded before the
    // advance) never satisfies the completion gate next to the new canonical
    // revision.
    const projection = rebuildSchedulerProjection(events);
    assert.equal(projection.integrationRevision, newRevision);
    assert.notEqual(oldRevision, projection.integrationRevision);
    const readiness = buildCompletionReadiness({
      ...projection,
      finalVerification: {
        current: {
          taskId: "final-verification",
          generationId: "generation-stale",
          targetRevision: oldRevision,
          planVersion: 1,
          plan: { checks: [] },
          state: "current",
        },
        history: [],
      },
    } as unknown as SchedulerProjection);
    assert.ok(
      readiness.issues.some((issue) => /Current final-verification target does not match the canonical integration revision/.test(issue)),
      `stale target refused (got: ${readiness.issues.join(" | ")})`,
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
