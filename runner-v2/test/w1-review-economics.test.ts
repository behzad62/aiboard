import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CriterionEvidenceLink } from "../src/acceptance-contracts.js";
import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import {
  BuildRuntime,
  type ArchitectActionRequest,
  type ArchitectRuntimeDriver,
  type DeliveryBoundaryDriver,
  type IntegrationRuntimeDriver,
} from "../src/build-runtime.js";
import {
  assessDeliveryRisk,
  deliveryReviewId,
} from "../src/delivery-acceptance.js";
import { evidenceContentDigest } from "../src/evidence-content.js";
import type { EvidenceRecord } from "../src/evidence-store.js";
import {
  NativeDeliverableReviewRuntime,
  deliverySessionId,
  firstMissingResumePass,
  type DeliverableReviewInputs,
  type DeliveryDepthRunner,
} from "../src/native-deliverable-review.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import {
  claimBindingDigest,
  combineEvidenceContentDigests,
  computeReviewKey,
  findOscillatingRepairAttempt,
  isDuplicateReviewReuse,
  repairDiffFingerprint,
  repairDiffReverseFingerprint,
  semanticContractDigest,
  testIntegrityDigest,
  type ReviewKeyInputs,
} from "../src/review-key.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "../src/runtime-router.js";
import {
  currentExplicitStartIdentity,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerActorRole,
  type SchedulerEventType,
  type SchedulerProjection,
} from "../src/scheduler-store.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import type { ExecutionTaskContract } from "../src/planning-contracts.js";
import type { WorkerAssignment, WorkerOutcome, WorkerRuntimeDriver } from "../src/task-scheduler.js";
import {
  FIXTURE_AMENDED_TEXT,
  buildPlanningFixtureScenario,
  type PlanningFixtureScenario,
} from "./fixtures/planning-source-fixture.js";
import { seedCompletedDeliveryReview } from "./support/delivery-seed.js";

/**
 * W1 (AR-R27) own tests: ReviewKey dedupe, stage resume, repair
 * oscillation and current-authority ordering. Only these W1 files run in
 * this packet; prior groups and the broad suite stay deferred to T8.
 */

const HEX = (char: string): string => char.repeat(64);

function baseKeyInputs(): ReviewKeyInputs {
  return {
    semanticContractDigest: HEX("a"),
    baseTree: "b".repeat(40),
    headTree: "c".repeat(40),
    diffDigest: HEX("d"),
    diffArtifactHash: HEX("e"),
    evidenceContentDigest: HEX("f"),
    claimBindingDigest: HEX("1"),
    testIntegrityDigest: HEX("2"),
    tier: "low",
    reviewerPolicyVersion: 1,
    authorModelIdentity: "author-model",
    policyVersions: "evidence:0|integrity:0|scope:0|encoding:0",
  };
}

test("W1 key: stable 64-hex; every dimension invalidates", () => {
  const base = baseKeyInputs();
  const key = computeReviewKey(base);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(computeReviewKey({ ...base }), key, "same inputs give the same key");
});

test("W1 key: each dimension invalidates the key", () => {
  const base = baseKeyInputs();
  const key = computeReviewKey(base);
  const flip = (dimension: keyof ReviewKeyInputs, value: string): void => {
    assert.notEqual(computeReviewKey({ ...base, [dimension]: value }), key, `${dimension} must invalidate`);
  };
  flip("semanticContractDigest", HEX("1"));
  flip("baseTree", "0".repeat(40));
  flip("headTree", "0".repeat(40));
  flip("diffDigest", HEX("2"));
  flip("diffArtifactHash", HEX("3"));
  flip("evidenceContentDigest", HEX("4"));
  flip("claimBindingDigest", HEX("5"));
  flip("testIntegrityDigest", HEX("6"));
  flip("tier", "high");
  flip("authorModelIdentity", "other-model");
  flip("policyVersions", "evidence:1|integrity:0|scope:0|encoding:0");
  assert.notEqual(computeReviewKey({ ...base, reviewerPolicyVersion: 2 }), key, "reviewerPolicyVersion must invalidate");
});

test("W1 key: empty, unknown and malformed inputs never hit", () => {
  const base = baseKeyInputs();
  assert.throws(() => computeReviewKey({ ...base, tier: "" }), /never hit/);
  assert.throws(() => computeReviewKey({ ...base, baseTree: "" }), /never hit/);
  assert.throws(() => computeReviewKey({ ...base, semanticContractDigest: "not-hex" }), /semantic contract digest/);
  assert.throws(() => computeReviewKey({ ...base, diffDigest: HEX("d").slice(0, 63) }), /real diff digest/);
  assert.throws(() => computeReviewKey({ ...base, diffArtifactHash: "zz" }), /diff artifact hash/);
  assert.throws(() => computeReviewKey({ ...base, evidenceContentDigest: "zz" }), /evidence-content digest/);
  assert.throws(() => computeReviewKey({ ...base, baseTree: "commit:abc" }), /actual base Git tree/);
  assert.throws(() => computeReviewKey({ ...base, headTree: "" }), /never hit/);
  assert.throws(() => computeReviewKey({ ...base, claimBindingDigest: "zz" }), /claim-binding digest/);
  assert.throws(() => computeReviewKey({ ...base, testIntegrityDigest: "zz" }), /test-integrity digest/);
});

function w1Contract(overrides: Record<string, unknown> = {}): ExecutionTaskContract {
  return {
    id: "T1",
    lineage: ["T0"],
    accountablePhaseId: "P1",
    requirementIds: ["REQ-1"],
    outcome: { user: "Ship the feature.", system: "The feature ships." },
    scope: { includes: ["src/feature.ts"], excludes: [] },
    writableSurfaces: ["src/feature.ts"],
    forbiddenSurfaces: [],
    dependencies: [],
    requiredBase: "accepted plan revision rev-1",
    inputs: ["plan"],
    outputs: ["src/feature.ts"],
    steps: ["Write it.", "Test it."],
    acceptance: { criteria: [{ id: "c1", text: "It works." }], definitionOfDone: "Done." },
    validation: { targetedRationale: "Unit.", affectedScopeRationale: "One file." },
    negativeProofApplicability: { applicable: false, rationale: "New." },
    reviewCriteria: ["Independent review."],
    integrationChecks: ["Tests."],
    cleanup: { cleanup: "None.", recovery: "Retry.", rollback: "Revert." },
    requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-1" }],
    ...overrides,
  } as ExecutionTaskContract;
}

test("W1 semantic digest: plan lineage ignored, content rules", () => {
  const digest = semanticContractDigest(w1Contract());
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(semanticContractDigest(w1Contract({ lineage: ["T9", "T8"] })), digest, "lineage is not semantic identity");
  assert.notEqual(
    semanticContractDigest(w1Contract({ acceptance: { criteria: [{ id: "c1", text: "Changed." }], definitionOfDone: "Done." } })),
    digest,
    "criterion drift changes semantic identity",
  );
  assert.notEqual(semanticContractDigest(w1Contract({ id: "T2" })), digest, "task identity matters");
  assert.equal(semanticContractDigest(w1Contract()), digest, "stable across calls");
});

function w1CommandFact(overrides: Record<string, unknown> = {}): EvidenceRecord {
  return {
    id: "w1-ev",
    runId: "run-w1",
    taskId: "T1",
    actor: { role: "worker", id: "worker" },
    status: "observed",
    fact: {
      kind: "command",
      label: "tests",
      command: "node",
      args: ["--test"],
      cwd: ".",
      startedAt: "2026-10-01T00:00:00.000Z",
      finishedAt: "2026-10-01T00:00:01.000Z",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      stdoutArtifactHash: HEX("a"),
      stderrArtifactHash: HEX("b"),
      ...overrides,
    },
    createdAt: "2026-10-01T00:00:01.000Z",
    idempotencyKey: "evidence:w1-ev",
    attempt: 1,
  };
}

test("W1 evidence: bookkeeping-only reruns share content; real changes differ", () => {
  const first = w1CommandFact();
  const rerun = w1CommandFact({ label: "tests-retry", startedAt: "2026-10-02T00:00:00.000Z", finishedAt: "2026-10-02T00:00:05.000Z", capturedAt: "2026-10-02T00:00:06.000Z" });
  assert.equal(evidenceContentDigest(rerun), evidenceContentDigest(first), "labels and times are not novel evidence");
  assert.notEqual(evidenceContentDigest(w1CommandFact({ exitCode: 1 })), evidenceContentDigest(first), "exit code is content");
  assert.notEqual(evidenceContentDigest(w1CommandFact({ args: ["--test", "other"] })), evidenceContentDigest(first), "command is content");
  assert.equal(
    combineEvidenceContentDigests({ "ev-new": evidenceContentDigest(first), "ev-old": evidenceContentDigest(first) }),
    combineEvidenceContentDigests({ "ev-old": evidenceContentDigest(first) }),
    "a repeated check with a fresh id but identical content is not new evidence",
  );
  assert.notEqual(
    combineEvidenceContentDigests({ x: evidenceContentDigest(w1CommandFact({ exitCode: 1 })) }),
    combineEvidenceContentDigests({ x: evidenceContentDigest(first) }),
    "changed output changes the evidence dimension",
  );
});

test("W1 claim binding: texts, summary, concerns and content links bind (bookkeeping ids are not inputs)", () => {
  const content = "a".repeat(64);
  const base = {
    objective: "Ship the feature.",
    criteria: [{ id: "c1", text: "It works." }],
    claims: [{ id: "claim:c1", text: "Criterion c1 is satisfied.", evidenceContent: [content] }],
    workerSummary: "Worker summary.",
    unresolvedConcerns: [] as string[],
  };
  const digest = claimBindingDigest(base);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(claimBindingDigest({ ...base }), digest, "stable across calls");
  assert.notEqual(claimBindingDigest({ ...base, claims: [{ id: "claim:c1", text: "Changed text.", evidenceContent: [content] }] }), digest, "claim text drift invalidates");
  assert.notEqual(claimBindingDigest({ ...base, workerSummary: "Different summary." }), digest, "summary drift invalidates");
  assert.notEqual(claimBindingDigest({ ...base, unresolvedConcerns: ["A new worry."] }), digest, "new concerns invalidate");
  assert.notEqual(
    claimBindingDigest({
      ...base,
      claims: [
        { id: "claim:c1", text: "Criterion c1 is satisfied.", evidenceContent: [] },
        { id: "claim:c2", text: "Extra.", evidenceContent: [content] },
      ],
      criteria: [...base.criteria, { id: "c2", text: "More." }],
    }),
    digest,
    "swapped evidence links with the same union invalidate",
  );
  assert.notEqual(claimBindingDigest({ ...base, repairTaskKind: "verification_repair" }), digest, "repair semantics bind");
});

test("W1 test-integrity: baseline and candidate drift invalidate; absence is stable", () => {
  const base = { planRevisionId: "rev-1", planDigest: "a".repeat(64), candidateRevision: "c".repeat(40) };
  const digest = testIntegrityDigest(base);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(testIntegrityDigest({ ...base }), digest, "stable across calls");
  assert.notEqual(
    testIntegrityDigest({ ...base, baselinePinDigest: "b".repeat(64), baselineKind: "executed_report", baselineRevision: "d".repeat(40), baselineExecuted: 3 }),
    digest,
    "a captured baseline invalidates the no-baseline key",
  );
  assert.notEqual(testIntegrityDigest({ ...base, candidateRevision: "e".repeat(40) }), digest, "candidate drift invalidates");
  assert.notEqual(testIntegrityDigest({ ...base, planRevisionId: "rev-2" }), digest, "plan drift invalidates");
});

function w1Pad(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `+// w1-size-witness:${prefix}:${index}`);
}

// Medium-band fixture diffs (about 130 added lines across a source/test
// pair): attempt-1 and attempt-2 risk both land medium, so tier alone never
// decides reuse — only the ReviewKey dimensions do.
const W1_DIFF = [
  "diff --git a/src/feature.ts b/src/feature.ts",
  "--- a/src/feature.ts",
  "+++ b/src/feature.ts",
  "@@ -1,2 +1,66 @@",
  " export const a = 1;",
  "-export const b = 2;",
  "+export const b = 3;",
  "+export const c = a + b;",
  ...w1Pad("feature", 63),
  "diff --git a/test/feature.test.ts b/test/feature.test.ts",
  "--- a/test/feature.test.ts",
  "+++ b/test/feature.test.ts",
  "@@ -1 +1,66 @@",
  " import test from 'node:test';",
  ...w1Pad("feature-test", 65),
].join("\n");

const W1_OTHER_DIFF = [
  "diff --git a/src/other.ts b/src/other.ts",
  "--- a/src/other.ts",
  "+++ b/src/other.ts",
  "@@ -1,2 +1,66 @@",
  " export const z = 0;",
  "-export const y = 0;",
  "+export const y = 1;",
  "+export const w = z + y;",
  ...w1Pad("other", 63),
  "diff --git a/test/other.test.ts b/test/other.test.ts",
  "--- a/test/other.test.ts",
  "+++ b/test/other.test.ts",
  "@@ -1 +1,66 @@",
  " import test from 'node:test';",
  ...w1Pad("other-test", 65),
].join("\n");

function reverseDiff(diffText: string): string {
  return diffText.split("\n").map((line) => {
    if (line.startsWith("+++") || line.startsWith("---")) return line;
    if (line.startsWith("+")) return `-${line.slice(1)}`;
    if (line.startsWith("-")) return `+${line.slice(1)}`;
    return line;
  }).join("\n");
}

test("W1 repair fingerprints: exact and reversed match with lineage; unrelated misses", () => {
  const forward = repairDiffFingerprint(W1_DIFF);
  const reverse = repairDiffReverseFingerprint(W1_DIFF);
  assert.match(forward, /^[a-f0-9]{64}$/);
  assert.match(reverse, /^[a-f0-9]{64}$/);
  assert.notEqual(forward, reverse);
  assert.equal(repairDiffFingerprint(`${W1_DIFF}\r\n`.replaceAll("\n", "\r\n")), forward, "CRLF equals LF");
  const failed = [{ attempt: 1, forward, reverse }];
  assert.equal(findOscillatingRepairAttempt(forward, reverse, failed), 1, "exact repair repeats attempt 1");
  assert.equal(findOscillatingRepairAttempt(repairDiffFingerprint(reverseDiff(W1_DIFF)), repairDiffReverseFingerprint(reverseDiff(W1_DIFF)), failed), 1, "reversed repair repeats attempt 1");
  assert.equal(findOscillatingRepairAttempt(repairDiffFingerprint(W1_OTHER_DIFF), repairDiffReverseFingerprint(W1_OTHER_DIFF), failed), undefined, "unrelated repair is clean");
  assert.equal(findOscillatingRepairAttempt(forward, reverse, []), undefined, "no lineage means no flag");
  assert.equal(findOscillatingRepairAttempt(forward, reverse, [{ attempt: 2, forward: repairDiffFingerprint(W1_OTHER_DIFF), reverse: repairDiffReverseFingerprint(W1_OTHER_DIFF) }]), undefined, "other lineage does not match");
});

test("W1 canonical diff: shifted headers, context and CRLF still match; paths and direction do not", () => {
  const forward = repairDiffFingerprint(W1_DIFF);
  const shifted = W1_DIFF
    .replaceAll("index 1111111..2222222 100644", "index aaaaaaa..bbbbbbb 100644")
    .replaceAll("@@ -1,2 +1,66 @@", "@@ -41,7 +87,71 @@")
    .replaceAll("@@ -1 +1,66 @@", "@@ -9,3 +30,68 @@");
  assert.equal(repairDiffFingerprint(shifted), forward, "index blobs and hunk offsets carry no meaning");
  const reversedOrderFiles = [...W1_DIFF.split("diff --git ")].filter(Boolean).reverse().map((part) => `diff --git ${part}`).join("\n");
  assert.equal(repairDiffFingerprint(reversedOrderFiles), forward, "file order carries no meaning");
  assert.equal(repairDiffFingerprint(`${W1_DIFF}\r\n`.replaceAll("\n", "\r\n")), forward, "CRLF equals LF");
  const renamedPath = W1_DIFF.replaceAll("src/feature.ts", "src/renamed.ts");
  assert.notEqual(repairDiffFingerprint(renamedPath), forward, "file identity is meaningful");
  const droppedHunk = W1_DIFF.split("\n").filter((line) => line !== "+export const c = a + b;").join("\n");
  assert.notEqual(repairDiffFingerprint(droppedHunk), forward, "substantive content is meaningful");
  assert.equal(findOscillatingRepairAttempt(forward, repairDiffReverseFingerprint(W1_DIFF), []), undefined, "no lineage means no flag");
});

test("W1 first missing stage: completed stages never veto, started never resumes", () => {
  const at = (stage: "started" | "requested" | "obligations_recorded" | "diff_delivered" | "findings_recorded" | "report_delivered" | "completed") =>
    ({ stage }) as unknown as Parameters<typeof firstMissingResumePass>[0];
  assert.equal(firstMissingResumePass(at("requested")), "findings", "low tier skips obligations");
  assert.equal(firstMissingResumePass(at("obligations_recorded")), "findings");
  assert.equal(firstMissingResumePass(at("diff_delivered")), "findings");
  assert.equal(firstMissingResumePass(at("findings_recorded")), "verdict");
  assert.equal(firstMissingResumePass(at("report_delivered")), "verdict");
  assert.equal(firstMissingResumePass(at("started")), undefined, "a requested event is required before any resume");
  assert.equal(firstMissingResumePass(at("completed")), undefined, "completed reviews never resume");
});

test("W1 reuse flag: generation alone is not a cycle", () => {
  assert.equal(isDuplicateReviewReuse(undefined), false);
  assert.equal(isDuplicateReviewReuse({}), false);
  assert.equal(isDuplicateReviewReuse({ reusedFrom: "delivery:T1:1:1" }), true);
});

// ---------------------------------------------------------------------------
// Harness: real SQLite scheduler/evidence/session stores, the real kernel
// reducer, the real review runtime tool loop and the real BuildRuntime pump.
// Scripted models only; no seeded scheduler/task/delivery authority.
// ---------------------------------------------------------------------------

const RUN_ID = "run-w1-economics";
const TASK_ID = "T1";

function event(type: SchedulerEventType | string, key: string, actor: { role: SchedulerActorRole; id: string }, payload: Record<string, unknown>): NewSchedulerEvent {
  return { runId: RUN_ID, type: type as SchedulerEventType, occurredAt: "2026-10-01T00:00:00.000Z", actor, idempotencyKey: key, payload };
}

function planningInputs(fixture: PlanningFixtureScenario): NewSchedulerEvent[] {
  return [
    event("run.policy_configured", "policy", { role: "runner", id: "build-runtime" }, { runPolicy: "finish" }),
    event("planning.policy_configured", "planning-policy", { role: "runner", id: "build-runtime" }, { version: 1 }),
    event("project_docs.policy_configured", "docs-policy", { role: "runner", id: "build-runtime" }, { version: 1 }),
    event("planning.source_registered", "source", { role: "user", id: "owner" }, { manifest: fixture.priorManifest }),
    event("planning.source_amended", "source-amendment", { role: "user", id: "owner" }, { manifest: fixture.manifest }),
    event("request.triaged", "triage", { role: "architect", id: "architect" }, { decision: "build", rationale: "Build the fixture." }),
    event("planning.ledger_persisted", "ledger", { role: "architect", id: "architect" }, { id: "ledger", requirements: fixture.requirements, phases: fixture.phases, nonNormativeSections: [] }),
    ...fixture.manifest.sections.map((section) => event("planning.source_section_read", `read:${section.id}`, { role: "architect", id: "architect" }, { manifestId: fixture.manifest.manifestId, manifestDigest: fixture.manifest.artifactDigest, sectionId: section.id, sectionDigest: section.digest, readAt: "2026-10-01T00:00:01.000Z" })),
    event("planning.plan_drafted", "plan", { role: "architect", id: "architect" }, { revision: fixture.revision, expectedRevisionId: null, expectedDigest: null }),
    event("planning.coverage_review_requested", "coverage-request", { role: "architect", id: "architect" }, { reviewId: fixture.coverageReview.id, planRevisionId: fixture.revision.revisionId, planRevisionDigest: fixture.revision.digest, sourceManifestId: fixture.manifest.manifestId, requestedAt: "2026-10-01T00:00:02.000Z" }),
    event("planning.coverage_obligations_recorded", "coverage-obligations", { role: "verifier", id: "coverage-reviewer" }, { reviewId: fixture.coverageReview.id, sourceManifestId: fixture.manifest.manifestId, sourceManifestDigest: fixture.manifest.artifactDigest, obligations: fixture.coverageReview.derivedObligations, sectionCoverage: fixture.manifest.sections.map((section) => ({ sectionId: section.id, obligationIds: fixture.coverageReview.derivedObligations.map((obligation) => obligation.id) })), recordedAt: "2026-10-01T00:00:03.000Z" }),
    event("planning.coverage_plan_delivered", "coverage-plan", { role: "runner", id: "build-runtime" }, { reviewId: fixture.coverageReview.id, planRevisionId: fixture.revision.revisionId, planRevisionDigest: fixture.revision.digest, sourceManifestId: fixture.manifest.manifestId, deliveredAt: "2026-10-01T00:00:04.000Z" }),
    event("planning.coverage_review_recorded", "coverage-review", { role: "verifier", id: "coverage-reviewer" }, { review: fixture.coverageReview }),
    event("planning.plan_ready", "ready", { role: "runner", id: "build-runtime" }, { hostCapabilities: fixture.hostCapabilities }),
  ];
}

type W1Pass = "obligations" | "findings" | "verdict";

interface W1ReviewerScript {
  inspect?: boolean;
  findings?: () => unknown[];
  failOnce?: W1Pass;
}

class W1Reviewer implements AgentModel {
  readonly requests: Array<{ pass: W1Pass; sessionId: string; tools: number }> = [];
  findingsCalls = 0;
  verdictCalls = 0;
  private failed = false;
  constructor(private readonly script: W1ReviewerScript = {}) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const system = request.messages.find((message) => message.role === "system");
    const pass = (system?.id.replace("delivery-", "").replace("-system", "") ?? "findings") as W1Pass;
    const toolResults = request.messages.filter((message) => message.role === "tool");
    this.requests.push({ pass, sessionId: request.sessionId, tools: toolResults.length });
    if (this.script.failOnce === pass && !this.failed) {
      this.failed = true;
      throw Object.assign(new Error("fatal provider rejection"), { status: 400 });
    }
    const call = (name: string, args: unknown): ModelTurn => ({
      blocks: [{ type: "tool_call", callId: `${pass}-${name}-${toolResults.length}-${request.messages.length}`, name, arguments: args }],
      stopReason: "tool_calls",
    });
    if (pass === "obligations") {
      return call("record_deliverable_obligations", { obligations: [{ id: "obl-w1", description: "The change must meet every criterion." }] });
    }
    if (pass === "findings") {
      if (this.script.inspect && !toolResults.some((message) => (message.content as { toolName?: string }).toolName === "fs.read")) {
        return call("fs.read", { path: "src/feature.ts" });
      }
      this.findingsCalls += 1;
      return call("record_deliverable_findings", { findings: this.script.findings?.() ?? [] });
    }
    const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
    const claimIds = [...new Set([...text.matchAll(/"id": "(claim:[^"]+)"/g)].map((match) => match[1]!))];
    const priorSection = text.split("Prior review")[1] ?? "";
    const hasPrior = priorSection.length > 0;
    const priorIds = [...new Set([...priorSection.matchAll(/"id": "((?!claim:)[^"]+)"/g)].map((match) => match[1]!))];
    this.verdictCalls += 1;
    const blocking = /"severity": "blocking"/.test(text.split("Your durably recorded findings:")[1]?.split("The worker's report")[0] ?? "");
    // The script always resolves prior checks as outstanding: an
    // outstanding prior finding carries forward as this review's
    // blocking finding, so a re-review with a prior is unsatisfied.
    const satisfied = !blocking && priorIds.length === 0;
    return call("submit_deliverable_verdict", {
      summary: "Reviewed against the criteria.",
      satisfied,
      claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Checked in the checkout." })),
      ...(hasPrior ? { priorFindingChecks: priorIds.map((findingId) => ({ findingId, resolution: "outstanding", rationale: "Unchanged repair; still open." })) } : {}),
    });
  }
}

type EvidenceCase = (attempt: number) => { args: string[]; output: string } | { missing: true };

class W1Workers implements WorkerRuntimeDriver {
  constructor(private readonly harness: W1Harness, private readonly evidenceCase: EvidenceCase) {}
  async run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    const { task, attempt } = assignment;
    const authorRuntimeId = "author-runtime";
    this.harness.scheduler.append(event("worker.runtime_assigned", `runtime:${task.id}:${attempt}`, { role: "runner", id: "runtime-router" }, { taskId: task.id, attempt, runtimeId: authorRuntimeId, sessionId: `session:${task.id}:${attempt}` }));
    const links: CriterionEvidenceLink[] = [];
    for (const criterion of task.acceptanceCriteria ?? []) {
      const decided = this.evidenceCase(attempt);
      let evidenceId: string;
      let decidedHashes: string[] = [];
      if ("missing" in decided) {
        evidenceId = `w1-missing-evidence:${task.id}:${attempt}`;
      } else {
        const stdout = await this.harness.artifacts.put(Buffer.from(decided.output, "utf8"), "text/plain", "w1 testimony");
        const stderr = await this.harness.artifacts.put(Buffer.from("", "utf8"), "text/plain", "w1 stderr");
        const record = this.harness.evidence.record({
          runId: RUN_ID,
          taskId: task.id,
          attempt,
          actor: { role: "worker", id: assignment.workerId },
          createdAt: "2026-10-01T00:00:01.000Z",
          idempotencyKey: `w1-evidence:${task.id}:${attempt}:${criterion.id}`,
          fact: {
            kind: "command",
            label: "tests",
            command: "node",
            args: decided.args,
            cwd: ".",
            startedAt: "2026-10-01T00:00:00.000Z",
            finishedAt: "2026-10-01T00:00:01.000Z",
            exitCode: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
            outputTruncated: false,
            stdoutArtifactHash: stdout.hash,
            stderrArtifactHash: stderr.hash,
          },
        });
        evidenceId = record.id;
        decidedHashes = [stdout.hash, stderr.hash];
      }
      links.push({ criterionId: criterion.id, evidenceId, artifactHashes: decidedHashes, taskId: task.id, attempt });
    }
    return { type: "submitted", changeSetId: `changeset:${task.id}:${attempt}`, criterionEvidenceLinks: links };
  }
}

class W1Architect implements ArchitectRuntimeDriver {
  constructor(private readonly harness: W1Harness, private readonly rejectAttempts: Set<number>) {}
  async run(request: ArchitectActionRequest): Promise<void> {
    const store = this.harness.scheduler;
    if (request.reason.type === "review_required") {
      const task = request.projection.tasks[request.reason.taskId]!;
      const links = task.criterionEvidenceLinks ?? [];
      const reject = this.rejectAttempts.has(task.attempt);
      store.append(event("review.decided", `review:${task.id}:${task.attempt}`, { role: "architect", id: "architect" }, {
        taskId: task.id,
        decision: reject ? "rejected" : "approved",
        summary: "Architect review.",
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        criterionVerdicts: (task.acceptanceCriteria ?? []).map((criterion) => ({ criterionId: criterion.id, verdict: reject ? "unsatisfied" : "satisfied", rationale: "Judged.", evidenceIds: links.filter((link) => link.criterionId === criterion.id).map((link) => link.evidenceId), artifactHashes: [...new Set(links.filter((link) => link.criterionId === criterion.id).flatMap((link) => link.artifactHashes))] })),
      }));
      return;
    }
    if (request.reason.type === "integration_approval_required") {
      store.append(event("task.transitioned", `integrate:${request.reason.taskId}`, { role: "architect", id: "architect" }, { taskId: request.reason.taskId, status: "integrating" }));
      return;
    }
    throw new Error(`Unexpected Architect reason ${request.reason.type}: ${JSON.stringify(request.reason).slice(0, 400)}.`);
  }
}

interface W1HarnessOptions {
  reviewer?: W1Reviewer;
  rejectAttempts?: number[];
  evidenceCase?: EvidenceCase;
  diffForAttempt?: (attempt: number) => string;
  pathsForAttempt?: (attempt: number) => string[];
  summaryForAttempt?: (attempt: number) => string;
  loadInputsError?: string;
  tamperContract?: boolean;
  /** Unknown actual base tree: the audited resolver yields nothing (conservative miss). */
  treesError?: boolean;
}

interface W1Harness {
  root: string;
  scheduler: SqliteSchedulerStore;
  evidence: SqliteEvidenceStore;
  artifacts: ArtifactStore;
  sessions: SqliteAgentSessionStore;
  runtime: BuildRuntime;
  reviewer: W1Reviewer;
  review: NativeDeliverableReviewRuntime;
  workspaceCreates: number;
  depthCalls: number;
  peekCalls: number;
  fullCalls: number;
  options: W1HarnessOptions;
  projection(): SchedulerProjection;
  until(predicate: (projection: SchedulerProjection) => boolean, maxSteps?: number): Promise<void>;
  cycles(): number;
  reviewEvents(type: string): number;
  /** Closes and reopens the real SQLite session store, then rebuilds the pump on it. */
  reopenSessions(): void;
  close(): void;
}

const W1_CANDIDATES: AgentRuntimeCandidate[] = [
  { runtimeId: "architect-runtime", providerId: "architect", modelId: "architect-model", capabilities: ["code"], priority: 1 },
  { runtimeId: "author-runtime", providerId: "author", modelId: "author-model", capabilities: ["code"], priority: 2 },
  { runtimeId: "reviewer-runtime", providerId: "reviewer", modelId: "reviewer-model", capabilities: ["code"], priority: 3 },
];

function w1Scenario(): PlanningFixtureScenario {
  const base = buildPlanningFixtureScenario();
  return {
    ...base,
    manifest: {
      ...base.manifest,
      amendment: {
        ...base.manifest.amendment!,
        recordedImpact: { addsSectionIds: ["s8"], retiresSectionIds: ["s7"], addsRequirementIds: [], retiresRequirementIds: ["REQ-RETIRED"] },
      },
    },
  };
}

async function createW1Harness(options: W1HarnessOptions = {}): Promise<W1Harness> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-w1-"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const scheduler = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: evidence, artifacts });
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 9, 1, 0, 0, 0, tick++ * 10)).toISOString();
  const scenario = w1Scenario();
  for (const input of planningInputs(scenario)) scheduler.append(input);
  // T7b: the ready plan waits for its explicit owner start. The test
  // acts as owner through the genuine authorization event, covering
  // the kernel's own current ready identity (no authority is seeded
  // or invented: the identity is read from the real projection).
  const startIdentity = currentExplicitStartIdentity(rebuildSchedulerProjection(scheduler.readRun(RUN_ID)));
  assert.ok(startIdentity, "the fixture plan is ready with a complete start identity");
  scheduler.append({
    runId: RUN_ID,
    type: "planning.execution_authorized",
    occurredAt: clock(),
    actor: { role: "user", id: "local-user" },
    idempotencyKey: "w1-owner-start",
    payload: { authorization: { ...startIdentity!, version: 1, ownerChoice: "execute" } },
  });
  // The pump verifies the current source artifact authority from the
  // real bytes: the exact fixture bytes hash to the manifest digest.
  const stored = await artifacts.put(Buffer.from(FIXTURE_AMENDED_TEXT, "utf8"), "text/plain", "w1 approved source");
  assert.equal(stored.hash, scenario.manifest.artifactDigest, "the stored source bytes are the manifest authority");
  const candidates = W1_CANDIDATES;
  const router = new RuntimeRouter({ health: new ProviderHealthRegistry(), candidates });
  const reviewer = options.reviewer ?? new W1Reviewer({ inspect: true, findings: () => [] });
  const workspaceRoot = join(root, "review-workspace");
  const harness = { root, scheduler, evidence, artifacts, sessions, reviewer, options } as unknown as W1Harness;
  harness.workspaceCreates = 0;
  harness.depthCalls = 0;
  harness.peekCalls = 0;
  harness.fullCalls = 0;
  // W1 (F5): the cheap peek carries the validated submission, contract
  // and diff bytes but no candidate-pin workspace; the full loader adds
  // the validated test-integrity reference once a real review proceeds.
  const buildInputs = async (task: { id: string; attempt: number; changeSetId?: string; objective: string; acceptanceCriteria?: { id: string; text: string }[] }, projection: SchedulerProjection, full: boolean): Promise<DeliverableReviewInputs> => {
    if (options.loadInputsError) throw new Error(options.loadInputsError);
    const attempt = task.attempt;
    const text = options.diffForAttempt?.(attempt) ?? W1_DIFF;
    const diff = await artifacts.put(Buffer.from(text, "utf8"), "text/x-diff", "w1 diff");
    const criteria = (task.acceptanceCriteria ?? []).map((criterion) => ({ id: criterion.id, text: criterion.text }));
    const changeSetId = task.changeSetId!;
    const links = projection.tasks[task.id]?.criterionEvidenceLinks ?? [];
    // W1 (F7): the default resubmission repeats the identical summary
    // text, so an exact repeat keeps its claim identity; drifted
    // summaries opt in through summaryForAttempt and must miss reuse.
    const summary = options.summaryForAttempt?.(attempt) ?? `Worker summary for ${task.id}`;
    return {
      taskId: task.id,
      attempt,
      changeSetId,
      baselineRevision: "b".repeat(40),
      taskRevision: "c".repeat(40),
      diffArtifactHash: diff.hash,
      diffText: text,
      changedPaths: options.pathsForAttempt?.(attempt) ?? ["src/feature.ts", "test/feature.test.ts"],
      objective: task.objective,
      criteria,
      workerSummary: summary,
      unresolvedConcerns: [],
      claims: [
        ...criteria.map((criterion) => ({ id: `claim:${criterion.id}`, text: `Criterion ${criterion.id} is satisfied.`, evidenceIds: links.filter((link) => link.criterionId === criterion.id).map((link) => link.evidenceId) })),
        { id: "claim:summary", text: summary, evidenceIds: [] },
      ],
      authorRuntimeId: projection.runtime.workerAssignments[`${task.id}:${attempt}`]!.runtimeId,
      ...(full
        ? {
            testIntegrityReference: {
              planRevisionId: "plan-w1",
              planDigest: HEX("a"),
              baselinePinDigest: HEX("b"),
              candidatePinDigest: HEX("c"),
              baselineKind: "executed_report" as const,
              baselineExecuted: 1,
              baselineRevision: "b".repeat(40),
              findings: [],
            },
          }
        : {}),
      ...(options.tamperContract ? { contractRef: { revisionId: "forged", digest: HEX("f"), taskId: "forged" } } : {}),
    };
  };
  const buildPump = (sessionStore: SqliteAgentSessionStore): { review: NativeDeliverableReviewRuntime; runtime: BuildRuntime } => {
    const review = new NativeDeliverableReviewRuntime({
    store: scheduler,
    architectRuntimeId: "architect-runtime",
    router,
    candidates,
    models: new Map(candidates.map((candidate) => [candidate.runtimeId, reviewer])),
    reviewerRuntimeIds: ["reviewer-runtime"],
    sessions: sessionStore,
    artifacts,
    evidenceStore: evidence,
    loadInputs: async ({ task, projection }): Promise<DeliverableReviewInputs> => {
      harness.fullCalls += 1;
      return buildInputs(task, projection, true);
    },
    peekInputs: async ({ task, projection }): Promise<DeliverableReviewInputs> => {
      harness.peekCalls += 1;
      return buildInputs(task, projection, false);
    },
    // Fixed-tree fixture resolver: the positive path proves real
    // audited trees; treesError proves the unknown-tree miss. Real
    // Git A->B/B->A reversal lives in w1-product-review.test.ts.
    resolveTrees: async () => {
      if (options.treesError) return undefined;
      return { baseTree: "b".repeat(40), headTree: "c".repeat(40) };
    },
    workspace: {
      create: async () => {
        harness.workspaceCreates += 1;
        mkdirSync(join(workspaceRoot, "src"), { recursive: true });
        writeFileSync(join(workspaceRoot, "src", "feature.ts"), "export const b = 3;\n");
        return { path: workspaceRoot };
      },
      cleanup: async () => rmSync(workspaceRoot, { recursive: true, force: true }),
    },
    depth: {
      run: async () => {
        harness.depthCalls += 1;
        return {
          affectedTests: {
            executedScope: "full_test_script",
            selectionRung: "w1",
            changedFiles: ["src/feature.ts"],
            selectedTests: ["test/feature.test.ts"],
            fullSuiteCount: 1,
            command: "w1",
            args: [],
            evidenceIds: [],
            exitCode: null,
            outcome: "unknown",
            report: { status: "unknown", runner: "w1" },
          },
          probe: { rung: "w1", mutantsGenerated: 0, mutantsExecuted: 0, mutantsCaught: 0, survivors: [], partial: true, evidenceIds: [], notes: ["w1"] },
        };
      },
    } as unknown as DeliveryDepthRunner,
    clock,
  });
    const defaultEvidence: EvidenceCase = () => ({ args: ["--test"], output: "w1 test output\n" });
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store: scheduler,
      artifacts,
      workerDriver: new W1Workers(harness, options.evidenceCase ?? defaultEvidence),
      architectDriver: new W1Architect(harness, new Set(options.rejectAttempts ?? [])),
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: `01${"f".repeat(38)}` }) } as IntegrationRuntimeDriver,
      deliveryReview: review,
      deliveryBoundary: { check: async () => { throw new Error("no boundary in the W1 economics harness"); } } as unknown as DeliveryBoundaryDriver,
      maxConcurrency: 1,
      maxTaskAttempts: 3,
      workspaceFor: async (task) => join(root, "work", task.id),
      clock,
      evidenceStore: evidence,
      architectId: "architect-runtime",
    });
    return { review, runtime };
  };
  const pump = buildPump(sessions);
  Object.assign(harness, {
    runtime: pump.runtime,
    review: pump.review,
    projection: () => rebuildSchedulerProjection(scheduler.readRun(RUN_ID)),
    until: async (predicate: (projection: SchedulerProjection) => boolean, maxSteps = 120) => {
      for (let step = 0; step < maxSteps; step += 1) {
        if (predicate(harness.projection())) return;
        const result = await harness.runtime.step();
        if (result.status === "paused") {
          if (predicate(harness.projection())) return;
          throw new Error(`Run paused (${harness.projection().pauseReason?.reason}) before the condition.`);
        }
      }
      if (!predicate(harness.projection())) throw new Error("Condition not reached.");
    },
    cycles: () => scheduler.readRun(RUN_ID).filter((entry) => entry.type === "repair.cycle_recorded").length,
    reviewEvents: (type: string) => scheduler.readRun(RUN_ID).filter((entry) => entry.type === type).length,
    reopenSessions: () => {
      harness.sessions.close();
      const fresh = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
      const next = buildPump(fresh);
      harness.sessions = fresh;
      harness.review = next.review;
      harness.runtime = next.runtime;
    },
    close: () => {
      scheduler.close();
      evidence.close();
      harness.sessions.close();
      rmSync(root, { recursive: true, force: true });
    },
  });
  return harness;
}

const W1_BLOCKING = () => [{
  id: "f-w1-1",
  category: "missing_coverage",
  severity: "blocking",
  claim: "The changed branch has no covering test.",
  evidenceRefs: ["src/feature.ts:1"],
  defectClass: "missing coverage",
}];

const completedReview = (harness: W1Harness) => harness.projection().delivery?.reviews[TASK_ID];

test("W1 exact repeat: prior verdict returns with no model/depth/workspace work and no new review or cycle", async () => {
  let first = true;
  const reviewer = new W1Reviewer({ inspect: true, findings: () => (first ? (first = false, W1_BLOCKING()) : []) });
  const harness = await createW1Harness({ reviewer, rejectAttempts: [1, 2, 3] });
  try {
    await harness.until((projection) => projection.delivery?.reviews[TASK_ID]?.stage === "completed");
    const gen1 = completedReview(harness)!;
    assert.equal(gen1.satisfied, false, "attempt 1 is a failed review");
    assert.ok(gen1.reviewKey, "the completed review carries its ReviewKey");
    assert.ok(harness.fullCalls >= 1, "the fresh review upgrades peek inputs to the full loader");
    assert.ok(gen1.diffFingerprint, "the current diff fingerprint rides the request");
    assert.ok(Array.isArray(gen1.failedRepairFingerprints), "failed lineage rides the request");
    const callsAfterGen1 = reviewer.requests.length;
    const workspacesAfterGen1 = harness.workspaceCreates;
    const fullAfterGen1 = harness.fullCalls;
    await harness.until((projection) => projection.tasks[TASK_ID]?.status === "rejected");
    await harness.until(() => harness.cycles() > 0);
    const cyclesAfterGen1 = harness.cycles();
    assert.ok(cyclesAfterGen1 > 0, "the failed review charges repair cycles");
    await harness.until((projection) => (completedReview(harness)?.reusedFrom ?? "") !== "");
    const reused = completedReview(harness)!;
    assert.equal(reused.reusedFrom, gen1.reviewId, "the repeat binds the prior verdict");
    assert.deepEqual(reused.findings, gen1.findings, "original finding provenance preserved");
    assert.deepEqual(reused.claimVerdicts, gen1.claimVerdicts, "original verdict provenance preserved");
    assert.equal(reused.reviewId, gen1.reviewId, "no duplicate verdict provenance minted");
    assert.equal(reused.completedSequence, gen1.completedSequence, "original completion sequence preserved");
    const history = harness.projection().delivery?.reviewHistory[TASK_ID] ?? [];
    assert.ok(history.some((record) => record.reviewId === gen1.reviewId && record.stage === "completed"), "the original completed record stays completed in history");
    assert.equal(harness.fullCalls, fullAfterGen1, "the cheap repeat buys no full load");
    assert.ok(harness.peekCalls > 0, "the repeat still recomputes current authority");
    assert.equal(reviewer.requests.length, callsAfterGen1, "no model calls on the exact repeat");
    assert.equal(harness.workspaceCreates, workspacesAfterGen1, "no workspace work on the exact repeat");
    assert.equal(harness.depthCalls, 0, "no depth work on the exact repeat");
    assert.equal(harness.reviewEvents("delivery.review_started"), 1, "no new review opened");
    assert.equal(harness.reviewEvents("delivery.review_reused"), 1, "exactly one reuse record");
    await harness.until((projection) => projection.tasks[TASK_ID]?.status === "rejected" && projection.tasks[TASK_ID]?.attempt === 2);
    await harness.until((projection) => projection.tasks[TASK_ID]?.status !== "rejected");
    assert.equal(harness.cycles(), cyclesAfterGen1, "duplicate failed reuse consumes no further cycle");
  } finally {
    harness.close();
  }
});

test("W1 oscillation: identical repair with new evidence is a blocking finding", async () => {
  let first = true;
  const reviewer = new W1Reviewer({ inspect: true, findings: () => (first ? (first = false, W1_BLOCKING()) : []) });
  const harness = await createW1Harness({
    reviewer,
    rejectAttempts: [1, 2, 3],
    evidenceCase: (attempt) => attempt >= 2
      ? { args: ["--test", "other"], output: "w1 different test output\n" }
      : { args: ["--test"], output: "w1 test output\n" },
  });
  try {
    await harness.until((projection) => projection.delivery?.reviews[TASK_ID]?.stage === "completed");
    assert.equal(harness.cycles(), 0, "no charge before rejection");
    await harness.until((projection) => projection.tasks[TASK_ID]?.status === "rejected");
    const callsAfterGen1 = reviewer.requests.length;
    await harness.until((projection) => {
      const review = completedReview(harness);
      return review?.stage === "completed" && (review.generation ?? 0) >= 2;
    });
    const gen2 = completedReview(harness)!;
    assert.equal(gen2.generation, 1 + 1, "new evidence means a new review generation");
    assert.ok(
      gen2.findings?.some((finding) => finding.id === "repair-oscillation:1" && finding.severity === "blocking"),
      `identical repair of failed attempt 1 is blocked: ${JSON.stringify(gen2.findings)}`,
    );
    assert.ok(reviewer.requests.length > callsAfterGen1, "the new review really ran");
    assert.equal(harness.reviewEvents("delivery.review_reused"), 0, "no reuse on changed evidence");
    assert.equal(gen2.satisfied, false, "the oscillated repair stays unsatisfied");
  } finally {
    harness.close();
  }
});

test("W1 oscillation: reversed repair is blocked, unrelated repair is clean", async () => {
  for (const [mode, diffFor, expectBlocked] of [
    ["reversed", (attempt: number) => (attempt >= 2 ? reverseDiff(W1_DIFF) : W1_DIFF), true],
    ["unrelated", (attempt: number) => (attempt >= 2 ? W1_OTHER_DIFF : W1_DIFF), false],
  ] as const) {
    let first = true;
    const reviewer = new W1Reviewer({ inspect: true, findings: () => (first ? (first = false, W1_BLOCKING()) : []) });
    const harness = await createW1Harness({ reviewer, rejectAttempts: [1, 2, 3], diffForAttempt: diffFor });
    try {
      await harness.until((projection) => projection.delivery?.reviews[TASK_ID]?.stage === "completed");
      await harness.until((projection) => projection.tasks[TASK_ID]?.status === "rejected");
      await harness.until((projection) => {
        const review = completedReview(harness);
        return review?.stage === "completed" && (review.generation ?? 0) >= 2;
      });
      const gen2 = completedReview(harness)!;
      const oscillation = gen2.findings?.filter((finding) => finding.id.startsWith("repair-oscillation:"));
      assert.equal((oscillation?.length ?? 0) > 0, expectBlocked, `${mode} repair oscillation expectation`);
      if (expectBlocked) assert.equal(oscillation![0]!.severity, "blocking");
    } finally {
      harness.close();
    }
  }
});

test("W1 authority first: a completed review never authorizes itself", async () => {
  const harness = await createW1Harness({ loadInputsError: "boom" });
  try {
    await harness.until((projection) => Object.values(projection.tasks).some((task) => task.status === "submitted"));
    const task = Object.values(harness.projection().tasks).find((candidate) => candidate.status === "submitted")!;
    seedCompletedDeliveryReview(harness.scheduler, RUN_ID, task.id, { authorRuntimeId: "author-runtime" });
    assert.equal(completedReview(harness)?.stage, "completed");
    const inputsUnavailable = await harness.review.review({ runId: RUN_ID, taskId: task.id });
    assert.equal(inputsUnavailable.status, "unavailable");
    assert.equal((inputsUnavailable as { reason?: string }).reason, "delivery_inputs_unavailable");
  } finally {
    harness.close();
  }
});

test("W1 authority first: a tampered contract copy is refused, not reused", async () => {
  const harness = await createW1Harness({ tamperContract: true });
  try {
    await harness.until((projection) => Object.values(projection.tasks).some((task) => task.status === "submitted"));
    const task = Object.values(harness.projection().tasks).find((candidate) => candidate.status === "submitted")!;
    seedCompletedDeliveryReview(harness.scheduler, RUN_ID, task.id, { authorRuntimeId: "author-runtime" });
    const refused = await harness.review.review({ runId: RUN_ID, taskId: task.id });
    assert.equal(refused.status, "unavailable");
    assert.equal((refused as { reason?: string }).reason, "delivery_inputs_unavailable");
  } finally {
    harness.close();
  }
});

test("W1 missing evidence cannot reuse: tampered artifacts force a fresh review", async () => {
  const harness = await createW1Harness({});
  try {
    await harness.until((projection) => Object.values(projection.tasks).some((task) => task.status === "submitted"));
    const task = Object.values(harness.projection().tasks).find((candidate) => candidate.status === "submitted")!;
    const priorReviewId = seedCompletedDeliveryReview(harness.scheduler, RUN_ID, task.id, { authorRuntimeId: "author-runtime" });
    const callsBefore = harness.reviewer.requests.length;
    // Tamper AFTER submission: remove the recorded stdout bytes, so the
    // current evidence no longer verifies against its immutable hash.
    const link = task.criterionEvidenceLinks![0]!;
    const record = harness.evidence.getByIds({ runId: RUN_ID, ids: [link.evidenceId] })[0]!;
    assert.equal(record.fact.kind, "command");
    if (record.fact.kind === "command") {
      rmSync(join(harness.root, "artifacts", record.fact.stdoutArtifactHash.slice(0, 2), record.fact.stdoutArtifactHash), { force: true });
    }
    const result = await harness.review.review({ runId: RUN_ID, taskId: task.id });
    assert.equal(result.status, "reviewed", "tampered evidence still gets a fresh review, never the old verdict");
    const current = harness.projection().delivery!.reviews[task.id]!;
    assert.notEqual(current.reviewId, priorReviewId, "the old verdict is never returned");
    assert.equal(current.reusedFrom, undefined, "no reuse without verified evidence");
    assert.equal(harness.reviewEvents("delivery.review_reused"), 0, "no reuse without verified evidence");
    assert.ok(harness.reviewer.requests.length > callsBefore, "the fresh review really ran");
  } finally {
    harness.close();
  }
});

test("W1 key drift: a changed worker summary opens a fresh review, never a reuse", async () => {
  let first = true;
  const reviewer = new W1Reviewer({ inspect: true, findings: () => (first ? (first = false, W1_BLOCKING()) : []) });
  const harness = await createW1Harness({
    reviewer,
    rejectAttempts: [1, 2, 3],
    summaryForAttempt: (attempt) => (attempt >= 2 ? "A rewritten worker summary." : "Worker summary for T1"),
  });
  try {
    await harness.until((projection) => projection.delivery?.reviews[TASK_ID]?.stage === "completed");
    await harness.until((projection) => projection.tasks[TASK_ID]?.status === "rejected");
    await harness.until((projection) => {
      const review = completedReview(harness);
      return review?.stage === "completed" && (review.generation ?? 0) >= 2;
    });
    const gen2 = completedReview(harness)!;
    assert.equal(gen2.generation, 2, "drifted claims open a fresh generation");
    assert.equal(gen2.reusedFrom, undefined, "drifted claims never reuse the prior verdict");
    assert.equal(harness.reviewEvents("delivery.review_started"), 2, "a fresh review opens");
    assert.equal(harness.reviewEvents("delivery.review_reused"), 0, "no reuse on claim drift");
  } finally {
    harness.close();
  }
});

test("W1 unknown tree: an unresolvable actual base tree is a conservative miss with lineage intact", async () => {
  let first = true;
  const reviewer = new W1Reviewer({ inspect: true, findings: () => (first ? (first = false, W1_BLOCKING()) : []) });
  const harness = await createW1Harness({ reviewer, rejectAttempts: [1, 2], treesError: true });
  try {
    await harness.until((projection) => projection.delivery?.reviews[TASK_ID]?.stage === "completed");
    const gen1 = completedReview(harness)!;
    assert.equal(gen1.reviewKey, undefined, "no key without actual trees");
    assert.ok(gen1.diffFingerprint, "the current diff fingerprint rides the request without a key");
    assert.ok(Array.isArray(gen1.failedRepairFingerprints), "failed lineage rides the request without a key");
    await harness.until((projection) => projection.tasks[TASK_ID]?.status === "rejected");
    await harness.until((projection) => {
      const review = completedReview(harness);
      return review?.stage === "completed" && (review.generation ?? 0) >= 2;
    });
    const gen2 = completedReview(harness)!;
    assert.equal(gen2.reusedFrom, undefined, "unknown trees never hit reuse");
    assert.equal(harness.reviewEvents("delivery.review_reused"), 0, "no reuse without actual trees");
    assert.ok(
      gen2.findings?.some((finding) => finding.id === "repair-oscillation:1" && finding.severity === "blocking"),
      "the mandatory oscillation finding survives the cache miss",
    );
  } finally {
    harness.close();
  }
});

test("W1 resume: the same reviewer continues at the first missing durable stage", async () => {
  const harness = await createW1Harness({ reviewer: new W1Reviewer({ inspect: true, failOnce: "findings", findings: () => [] }) });
  try {
    await harness.until(() => false, 60).catch(() => undefined);
    let projection = harness.projection();
    assert.equal(projection.status, "paused");
    assert.match(projection.pauseReason?.reason ?? "", /^delivery_/);
    const first = Object.values(projection.delivery!.reviews)[0]!;
    assert.notEqual(first.stage, "completed");
    harness.scheduler.append(event("run.resumed", "resume-1", { role: "user", id: "owner" }, {}));
    await harness.until((current) => current.delivery!.reviews[first.taskId]!.stage === "completed", 60);
    projection = harness.projection();
    const second = projection.delivery!.reviews[first.taskId]!;
    assert.equal(second.reviewId, first.reviewId, "the same review continues");
    assert.equal(second.generation, first.generation, "no new generation on same-reviewer resume");
    assert.equal(harness.reviewEvents("delivery.review_started"), 1, "no duplicate start");
  } finally {
    harness.close();
  }
});

test("W1 resume: SQLite close/reopen keeps the first missing stage for the same runtime", async () => {
  const harness = await createW1Harness({ reviewer: new W1Reviewer({ inspect: true, failOnce: "findings", findings: () => [] }) });
  try {
    await harness.until(() => false, 60).catch(() => undefined);
    let projection = harness.projection();
    assert.equal(projection.status, "paused");
    const first = Object.values(projection.delivery!.reviews)[0]!;
    assert.notEqual(first.stage, "completed");
    // Real SQLite close/reopen between interruption and resume: durable
    // stages survive, completed sessions never veto the missing stage.
    harness.reopenSessions();
    harness.scheduler.append(event("run.resumed", "resume-reopen-1", { role: "user", id: "owner" }, {}));
    await harness.until((current) => current.delivery!.reviews[first.taskId]!.stage === "completed", 60);
    projection = harness.projection();
    const second = projection.delivery!.reviews[first.taskId]!;
    assert.equal(second.reviewId, first.reviewId, "the same review continues across reopen");
    assert.equal(second.generation, first.generation, "no new generation on same-runtime resume");
    assert.equal(harness.reviewEvents("delivery.review_started"), 1, "no duplicate start across reopen");
    assert.ok(harness.fullCalls >= 1, "the resumed missing stage receives full validated inputs");
  } finally {
    harness.close();
  }
});

test("W1 resume: a changed reviewer model restarts at the first pass", async () => {
  const harness = await createW1Harness({});
  try {
    await harness.until((projection) => Object.values(projection.tasks).some((task) => task.status === "submitted"));
    const task = Object.values(harness.projection().tasks).find((candidate) => candidate.status === "submitted")!;
    const runner = { role: "runner" as const, id: "delivery-review-runtime" };
    const reviewId = deliveryReviewId(task.id, task.attempt, 1);
    harness.scheduler.append(event("delivery.review_started", "w1-model-start", runner, {
      taskId: task.id, reviewId, generation: 1, attempt: task.attempt, changeSetId: task.changeSetId,
      diffArtifactHash: HEX("d"), criteriaIds: (task.acceptanceCriteria ?? []).map((criterion) => criterion.id),
      authorRuntimeId: "author-runtime", authorModelIdentity: "author-model",
      architectRuntimeId: "architect-runtime", architectModelIdentity: "architect-model",
    }));
    const riskInput = {
      authorModelId: "author-model",
      changedFiles: ["src/feature.ts"],
      linesAdded: 2,
      linesRemoved: 1,
      attempts: task.attempt,
      acceptedFailuresUsed: false,
    };
    const risk = assessDeliveryRisk(riskInput);
    harness.scheduler.append(event("delivery.review_requested", "w1-model-requested", runner, {
      taskId: task.id, reviewId, reviewerRuntimeId: "reviewer-runtime", reviewerModelIdentity: "changed-model",
      independence: "distinct_model", reviewTier: risk.tier, riskDigest: risk.digest, riskInput,
    }));
    const result = await harness.review.review({ runId: RUN_ID, taskId: task.id });
    assert.equal(result.status, "reviewed");
    const projection = harness.projection();
    const second = projection.delivery!.reviews[task.id]!;
    assert.equal(second.generation, 2, "a changed model starts a new generation");
    assert.equal(projection.delivery!.reviewHistory[task.id]![0]!.stage, "abandoned");
    assert.equal(projection.delivery!.reviewHistory[task.id]![0]!.reviewId, reviewId);
  } finally {
    harness.close();
  }
});

test("W1 resume: a partial missing-stage session is retried fresh, never borrowed", async () => {
  // A keyless seeded prior can never prove its identity, so the first
  // public call conservatively opens a new generation (which fails once
  // and therefore carries the exact known key). Tainting THAT review's
  // own findings session exactly like a crash partial, then resuming,
  // must continue the same review in a new genuinely fresh session.
  const harness = await createW1Harness({ reviewer: new W1Reviewer({ inspect: true, failOnce: "findings", findings: () => [] }) });
  try {
    await harness.until((projection) => Object.values(projection.tasks).some((task) => task.status === "submitted"));
    const task = Object.values(harness.projection().tasks).find((candidate) => candidate.status === "submitted")!;
    const runner = { role: "runner" as const, id: "delivery-review-runtime" };
    const reviewId = deliveryReviewId(task.id, task.attempt, 1);
    harness.scheduler.append(event("delivery.review_started", "w1-partial-start", runner, {
      taskId: task.id, reviewId, generation: 1, attempt: task.attempt, changeSetId: task.changeSetId,
      diffArtifactHash: HEX("d"), criteriaIds: (task.acceptanceCriteria ?? []).map((criterion) => criterion.id),
      authorRuntimeId: "author-runtime", authorModelIdentity: "author-model",
      architectRuntimeId: "architect-runtime", architectModelIdentity: "architect-model",
    }));
    const riskInput = {
      authorModelId: "author-model",
      changedFiles: ["src/feature.ts"],
      linesAdded: 2,
      linesRemoved: 1,
      attempts: task.attempt,
      acceptedFailuresUsed: false,
    };
    const risk = assessDeliveryRisk(riskInput);
    harness.scheduler.append(event("delivery.review_requested", "w1-partial-requested", runner, {
      taskId: task.id, reviewId, reviewerRuntimeId: "reviewer-runtime", reviewerModelIdentity: "reviewer-model",
      independence: "distinct_model", reviewTier: risk.tier, riskDigest: risk.digest, riskInput,
    }));
    const seededPartial = deliverySessionId(RUN_ID, reviewId, "findings", "reviewer-runtime", "distinct_model");
    await harness.sessions.create({ sessionId: seededPartial, runId: RUN_ID, actor: { role: "verifier", id: "reviewer-runtime" }, occurredAt: "2026-10-01T00:00:00.000Z" });
    harness.sessions.suspend(seededPartial, "provider_error", "boom", "2026-10-01T00:00:01.000Z");
    assert.equal(harness.sessions.events(seededPartial).length, 2, "the seeded session carries partial work");
    // Unknown prior key: a fresh generation opens (its request records
    // the exact known key) and fails once in findings.
    await harness.review.review({ runId: RUN_ID, taskId: task.id }).catch(() => undefined);
    const interrupted = harness.projection().delivery!.reviews[task.id]!;
    assert.equal(interrupted.generation, 2, "the keyless prior restarts conservatively");
    assert.notEqual(interrupted.reviewId, reviewId);
    assert.ok(interrupted.reviewKey, "the new generation carries its exact known key");
    assert.notEqual(interrupted.stage, "completed");
    // Taint the new review's own findings session exactly like a crash
    // partial, then close/reopen SQLite and resume through the pump.
    const partial = deliverySessionId(RUN_ID, interrupted.reviewId, "findings", "reviewer-runtime", "distinct_model");
    assert.ok(harness.sessions.events(partial).length > 0, "the interrupted findings session exists");
    harness.sessions.suspend(partial, "provider_error", "boom", "2026-10-01T00:00:02.000Z");
    assert.equal(harness.sessions.events(partial).length, 2, "the abandoned session carries partial work");
    harness.reopenSessions();
    harness.scheduler.append(event("run.resumed", "resume-partial-retry", { role: "user", id: "owner" }, {}));
    await harness.until((current) => current.delivery!.reviews[task.id]!.stage === "completed", 60);
    const second = harness.projection().delivery!.reviews[task.id]!;
    assert.equal(second.reviewId, interrupted.reviewId, "the same keyed review continues");
    assert.equal(second.generation, 2, "no third generation opens for partial reads");
    assert.equal(harness.reviewEvents("delivery.review_started"), 2, "no duplicate start");
    assert.ok(second.sessionIds.some((sessionId) => sessionId === `${partial}:retry1`), "the missing stage retries in a new genuinely fresh session");
    assert.ok(!second.sessionIds.includes(partial), "the contaminated session is never borrowed");
    assert.equal(harness.sessions.events(partial).length, 2, "the abandoned session stays immutable");
  } finally {
    harness.close();
  }
});

test("W1 reducer: review_reused validates the prior key, lineage and bindings", async () => {
  const harness = await createW1Harness({});
  try {
    await harness.until((projection) => Object.values(projection.tasks).some((task) => task.status === "submitted"));
    const task = Object.values(harness.projection().tasks).find((candidate) => candidate.status === "submitted")!;
    const priorReviewId = seedCompletedDeliveryReview(harness.scheduler, RUN_ID, task.id, { authorRuntimeId: "author-runtime" });
    const runner = { role: "runner" as const, id: "delivery-review-runtime" };
    const reuse = (key: string, payload: Record<string, unknown>): NewSchedulerEvent => event("delivery.review_reused", key, runner, {
      taskId: task.id,
      attempt: task.attempt,
      changeSetId: task.changeSetId,
      criteriaIds: (task.acceptanceCriteria ?? []).map((criterion) => criterion.id),
      authorRuntimeId: "author-runtime",
      authorModelIdentity: "author-model",
      architectRuntimeId: "architect-runtime",
      architectModelIdentity: "architect-model",
      priorReviewId,
      reviewKey: HEX("c"),
      ...payload,
    });
    assert.throws(() => harness.scheduler.append(reuse("bad-prior", { priorReviewId: "delivery:nope:9:9" })), /completed prior review/);
    assert.throws(() => harness.scheduler.append(reuse("bad-key", {})), /exact prior ReviewKey/);
    assert.throws(
      () => harness.scheduler.append(reuse("bad-author", { authorRuntimeId: "intruder-runtime" })),
      /recorded author runtime/,
    );
    assert.throws(
      () => harness.scheduler.append(reuse("bad-criteria", { criteriaIds: ["c-nope"] })),
      /exact acceptance criteria/,
    );
  } finally {
    harness.close();
  }
});

test("W1 claim binding: repeated identical verified content in one claim is bookkeeping", () => {
  const content = "a".repeat(64);
  const input = {
    objective: "Same",
    criteria: [{ id: "c1", text: "Same" }],
    workerSummary: "Same",
    unresolvedConcerns: [] as string[],
  };
  assert.equal(
    claimBindingDigest({ ...input, claims: [{ id: "claim:c1", text: "Same", evidenceContent: [content] }] }),
    claimBindingDigest({ ...input, claims: [{ id: "claim:c1", text: "Same", evidenceContent: [content, content] }] }),
    "a duplicated bookkeeping evidence id with identical verified content must not change the key",
  );
});

test("W1 replay: same-submission replay costs nothing, the original rejection still charges once", async () => {
  // Projection/issue lineage: a rejection carries one member issue per
  // distinct root cause — here the Architect's unsatisfied criterion
  // verdict (delivery-review:T1:c1) and the open blocking delivery
  // finding (delivery-review:T1:missing_coverage) — each with its own
  // repair budget. One rejection therefore records one cycle per issue
  // lineage (never a blanket single charge that would leave an issue
  // unbudgeted), while every duplicate of an already-charged lineage
  // records nothing further.
  const harness = await createW1Harness({
    reviewer: new W1Reviewer({ inspect: true, findings: W1_BLOCKING }),
    rejectAttempts: [1, 2, 3],
    diffForAttempt: (attempt) => (attempt >= 2 ? W1_OTHER_DIFF : W1_DIFF),
  });
  try {
    await harness.until((projection) => projection.delivery?.reviews[TASK_ID]?.stage === "completed");
    const gen1 = completedReview(harness)!;
    assert.equal(gen1.satisfied, false, "attempt 1 is a failed review");
    assert.equal(harness.cycles(), 0, "no repair cycle until actual Architect rejection");
    // Same-submission replay before the first rejection: the repeat
    // itself charges nothing and mints no new verdict.
    const replay = await harness.review.review({ runId: RUN_ID, taskId: TASK_ID });
    assert.equal(replay.status, "reviewed");
    assert.equal(harness.cycles(), 0, "the repeat itself does not charge a cycle");
    assert.equal(completedReview(harness)!.reusedFrom, undefined, "no self-binding is minted on the original verdict");
    await harness.until((projection) => projection.tasks[TASK_ID]!.attempt === 2);
    assert.equal(harness.cycles(), 2, "the original failed verdict rejection charges one cycle per issue lineage");
    const charges = () => Object.values(harness.projection().repairIssues ?? {})
      .filter((issue) => issue.rootCause.startsWith("delivery-review:T1:"))
      .map((issue) => ({ rootCause: issue.rootCause, used: issue.used }))
      .sort((left, right) => left.rootCause.localeCompare(right.rootCause));
    assert.deepEqual(charges(), [
      { rootCause: "delivery-review:T1:c1", used: 1 },
      { rootCause: "delivery-review:T1:missing_coverage", used: 1 },
    ], "each original issue root is charged exactly once");
    // Attempt 2 is a materially distinct repair: a fresh review with no
    // oscillation flag, whose own rejection charges its own lineage.
    await harness.until((projection) => {
      const review = completedReview(harness);
      return review?.stage === "completed" && review.submissionAttempt === 2;
    });
    const gen2 = completedReview(harness)!;
    assert.equal(gen2.generation, 2, "the distinct repair opens a fresh generation");
    assert.equal(gen2.reusedFrom, undefined, "the distinct repair never reuses");
    assert.ok(!(gen2.findings ?? []).some((finding) => finding.id.startsWith("repair-oscillation:")), "the unrelated repair stays clean");
    const replay2 = await harness.review.review({ runId: RUN_ID, taskId: TASK_ID });
    assert.equal(replay2.status, "reviewed");
    assert.equal(harness.cycles(), 2, "replaying the distinct submission adds no cycle");
    await harness.until(() => harness.cycles() >= 4);
    assert.equal(harness.cycles(), 4, "the distinct failed repair charges one cycle per its own issue lineage");
    assert.deepEqual(charges(), [
      { rootCause: "delivery-review:T1:c1", used: 2 },
      { rootCause: "delivery-review:T1:missing_coverage", used: 2 },
    ], "the distinct repair adds one charge to each affected root");
    // Attempt 3 resubmits attempt 2 identically: a cross-attempt
    // duplicate of the already-charged lineage consumes nothing further.
    await harness.until((projection) => (completedReview(harness)?.reusedFrom ?? "") !== "");
    assert.equal(completedReview(harness)!.reusedFrom, gen2.reviewId, "the identical resubmission binds the prior verdict");
    assert.equal(harness.cycles(), 4, "the duplicate consumes no further cycle");
    assert.deepEqual(charges(), [
      { rootCause: "delivery-review:T1:c1", used: 2 },
      { rootCause: "delivery-review:T1:missing_coverage", used: 2 },
    ], "the duplicate changes neither issue's used budget");
  } finally {
    harness.close();
  }
});

test("W1 immutable diff: the product loader and review refuse a tampered diff artifact", async () => {
  const harness = await createW1Harness({});
  try {
    await harness.until((projection) => Object.values(projection.tasks).some((task) => task.status === "submitted"));
    const projection = harness.projection();
    const task = Object.values(projection.tasks).find((candidate) => candidate.status === "submitted")!;
    const reviewOptions = (harness.review as unknown as { options: { peekInputs: unknown; loadInputs: unknown } }).options;
    const peek = reviewOptions.peekInputs as (request: { runId: string; task: unknown; projection: SchedulerProjection }) => Promise<DeliverableReviewInputs>;
    const inputs = await peek({ runId: RUN_ID, task, projection });
    // Exercise the genuine product input loader at its factory seam: all
    // durable fields are copied from the current submission, not invented.
    const submission = {
      authorRuntimeId: inputs.authorRuntimeId,
      summary: inputs.workerSummary,
      changeSet: {
        id: task.changeSetId!,
        baselineRevision: inputs.baselineRevision,
        taskRevision: inputs.taskRevision,
        diffArtifactHash: inputs.diffArtifactHash,
        changedPaths: inputs.changedPaths,
        unresolvedConcerns: [],
        criterionEvidenceLinks: task.criterionEvidenceLinks ?? [],
      },
    };
    const { loadDeliverableReviewInputs } = await import("../src/delivery-execution.js");
    const productLoader = async (request: { task: unknown }): Promise<DeliverableReviewInputs> =>
      loadDeliverableReviewInputs({ task: request.task as never, submission: submission as never, artifacts: harness.artifacts });
    reviewOptions.peekInputs = productLoader as never;
    reviewOptions.loadInputs = productLoader as never;
    const first = await harness.review.review({ runId: RUN_ID, taskId: task.id });
    assert.equal(first.status, "reviewed");
    const artifact = await harness.artifacts.stat(inputs.diffArtifactHash);
    writeFileSync(artifact.path, inputs.diffText.replace("export const b = 3", "export const b = 4"));
    assert.throws(() => harness.artifacts.verifySync(inputs.diffArtifactHash), /hash mismatch/);
    const second = await harness.review.review({ runId: RUN_ID, taskId: task.id });
    assert.equal(second.status, "unavailable", "tampered immutable diff cannot become a freshly reviewed or cached authority");
  } finally {
    harness.close();
  }
});

class PartialFindingsReviewer extends W1Reviewer {
  private interrupted = false;
  override async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const system = request.messages.find((message) => message.role === "system");
    if (
      system?.id === "delivery-findings-system" && !this.interrupted &&
      request.messages.some((message) => message.role === "tool" && (message.content as { toolName?: string }).toolName === "fs.read")
    ) {
      this.interrupted = true;
      throw Object.assign(new Error("interrupt after real successful file read"), { status: 400 });
    }
    return super.complete(request);
  }
}

test("W1 resume: partial findings after real reads keep completed obligations and retry fresh", async () => {
  // Source-only paths make this high tier, so obligations are durable
  // before the findings interruption.
  const reviewer = new PartialFindingsReviewer({ inspect: true });
  const harness = await createW1Harness({ reviewer, pathsForAttempt: () => ["src/security/auth.ts"] });
  try {
    await harness.until(() => false, 60).catch(() => undefined);
    const before = Object.values(harness.projection().delivery!.reviews)[0]!;
    assert.equal(harness.projection().status, "paused");
    assert.equal(before.stage, "diff_delivered");
    assert.ok(before.reviewKey, "the interrupted review carries its exact known key");
    assert.ok(before.obligations?.length, "real model obligations are durable before interruption");
    const partialId = deliverySessionId(RUN_ID, before.reviewId, "findings", "reviewer-runtime", "distinct_model");
    assert.ok(harness.sessions.events(partialId).length > 1, "a real partial findings checkpoint exists");
    harness.reopenSessions();
    harness.scheduler.append(event("run.resumed", "reviewer-partial-resume", { role: "user", id: "owner" }, {}));
    await harness.until((projection) => projection.delivery!.reviews[before.taskId]!.stage === "completed", 60);
    const after = harness.projection().delivery!.reviews[before.taskId]!;
    assert.equal(after.reviewId, before.reviewId, "the same review continues");
    assert.equal(after.generation, before.generation, "same runtime retries the first missing stage, preserving completed obligations");
    assert.equal(harness.reviewEvents("delivery.obligations_recorded"), 1, "completed obligations never rerun");
    assert.equal(harness.reviewEvents("delivery.review_started"), 1, "no new generation opens");
    assert.ok(after.sessionIds.some((sessionId) => sessionId !== partialId && sessionId.startsWith(`${partialId}:retry`)), "findings retry in a new genuinely fresh session");
    assert.ok(!after.sessionIds.includes(partialId), "the contaminated findings session is never borrowed");
  } finally {
    harness.close();
  }
});

test("W1 resume: an unknown prior key restarts at the first stage", async () => {
  const options: W1HarnessOptions = {
    reviewer: new W1Reviewer({ inspect: true, failOnce: "findings" }),
    pathsForAttempt: () => ["src/security/auth.ts"],
    treesError: true,
  };
  const harness = await createW1Harness(options);
  try {
    await harness.until(() => false, 60).catch(() => undefined);
    const before = Object.values(harness.projection().delivery!.reviews)[0]!;
    assert.equal(harness.projection().status, "paused");
    assert.equal(before.reviewKey, undefined, "no key without actual trees");
    assert.ok(before.obligations?.length, "obligations still record without a key");
    options.treesError = false;
    harness.reopenSessions();
    harness.scheduler.append(event("run.resumed", "reviewer-unknown-key-resume", { role: "user", id: "owner" }, {}));
    await harness.until((projection) => projection.delivery!.reviews[before.taskId]!.stage === "completed", 60);
    const after = harness.projection().delivery!.reviews[before.taskId]!;
    assert.equal(after.generation, before.generation + 1, "unknown prior semantic identity restarts conservatively");
    assert.equal(after.reviewId !== before.reviewId, true, "a fresh review opens once the actual tree is known");
    assert.ok(after.reviewKey, "the fresh review carries its exact known key");
    assert.equal(harness.projection().delivery!.reviewHistory[before.taskId]![0]!.reviewId, before.reviewId, "the keyless review is abandoned unchanged");
  } finally {
    harness.close();
  }
});

test("W1 resume: a changed reviewer runtime restarts at the first pass", async () => {
  const harness = await createW1Harness({});
  try {
    await harness.until((projection) => Object.values(projection.tasks).some((task) => task.status === "submitted"));
    const task = Object.values(harness.projection().tasks).find((candidate) => candidate.status === "submitted")!;
    const runner = { role: "runner" as const, id: "delivery-review-runtime" };
    const reviewId = deliveryReviewId(task.id, task.attempt, 1);
    harness.scheduler.append(event("delivery.review_started", "w1-runtime-start", runner, {
      taskId: task.id, reviewId, generation: 1, attempt: task.attempt, changeSetId: task.changeSetId,
      diffArtifactHash: HEX("d"), criteriaIds: (task.acceptanceCriteria ?? []).map((criterion) => criterion.id),
      authorRuntimeId: "author-runtime", authorModelIdentity: "author-model",
      architectRuntimeId: "architect-runtime", architectModelIdentity: "architect-model",
    }));
    const riskInput = {
      authorModelId: "author-model",
      changedFiles: ["src/feature.ts"],
      linesAdded: 2,
      linesRemoved: 1,
      attempts: task.attempt,
      acceptedFailuresUsed: false,
    };
    const risk = assessDeliveryRisk(riskInput);
    harness.scheduler.append(event("delivery.review_requested", "w1-runtime-requested", runner, {
      taskId: task.id, reviewId, reviewerRuntimeId: "other-runtime", reviewerModelIdentity: "reviewer-model",
      independence: "distinct_model", reviewTier: risk.tier, riskDigest: risk.digest, riskInput,
    }));
    const result = await harness.review.review({ runId: RUN_ID, taskId: task.id });
    assert.equal(result.status, "reviewed");
    const projection = harness.projection();
    const second = projection.delivery!.reviews[task.id]!;
    assert.equal(second.generation, 2, "a changed reviewer runtime starts a new generation");
    assert.equal(projection.delivery!.reviewHistory[task.id]![0]!.reviewId, reviewId, "the prior review is abandoned");
  } finally {
    harness.close();
  }
});

test("W1 resume: lifecycle-durable stages with open sessions reconcile without rerunning", async () => {
  // failOnce on the verdict deterministically stops the review with the
  // findings stage durable. session.complete is patched to a no-op to
  // simulate a crash between each lifecycle event and its completion:
  // the durable stages stand, but no session completes.
  const harness = await createW1Harness({ reviewer: new W1Reviewer({ inspect: true, failOnce: "verdict", findings: () => [] }) });
  try {
    const sessions = harness.sessions as unknown as { complete(sessionId: string, occurredAt: string): void };
    sessions.complete = () => undefined;
    await harness.until(() => false, 60).catch(() => undefined);
    const partial = harness.projection().delivery!.reviews[TASK_ID]!;
    assert.equal(harness.projection().status, "paused");
    assert.equal(partial.stage, "report_delivered", "findings and the worker report are durable before the crash");
    assert.ok((partial.sessionIds ?? []).length >= 1, "durable stages bound their sessions");
    for (const sessionId of partial.sessionIds) {
      assert.ok(!harness.sessions.events(sessionId).some((entry) => entry.type === "session.completed"), "no session completed before the crash");
    }
    // reopenSessions replaces the store instance (dropping this patch)
    // over the same SQLite file, which is the real close/reopen path.
    harness.reopenSessions();
    harness.scheduler.append(event("run.resumed", "resume-missing-complete", { role: "user", id: "owner" }, {}));
    await harness.until((projection) => projection.delivery!.reviews[TASK_ID]?.stage === "completed", 60);
    const done = harness.projection().delivery!.reviews[TASK_ID]!;
    assert.equal(done.reviewId, partial.reviewId, "the same review continues");
    assert.equal(done.generation, partial.generation, "no new generation opens");
    assert.equal(harness.reviewEvents("delivery.findings_recorded"), 1, "the durable findings stage never reruns");
    for (const sessionId of done.sessionIds) {
      assert.ok(harness.sessions.events(sessionId).some((entry) => entry.type === "session.completed"), `durable session ${sessionId} reconciles to completed`);
    }
  } finally {
    harness.close();
  }
});

