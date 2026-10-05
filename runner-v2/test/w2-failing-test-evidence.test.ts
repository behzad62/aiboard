import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import { nodeJunitOutcome } from "../src/delivery-execution.js";
import { applyLateFindingRule } from "../src/review-delta.js";
import {
  rebuildSchedulerProjection,
  reduceSchedulerEvent,
  type SchedulerEvent,
} from "../src/scheduler-store.js";
import type { DeliveryReviewRecord } from "../src/delivery-acceptance.js";
import type { PlanningFinding } from "../src/planning-contracts.js";

// F3: failing-test identities are authentic exception facts. Real
// `node --test` junit bytes -> the real outcome parser -> the real
// kernel projector -> the real classifier. References, ids and model
// claims alone mint nothing; forged, foreign, successful or byte-less
// evidence never authorizes the exception.

function finding(id: string, location: string, extra: Partial<PlanningFinding> = {}): PlanningFinding {
  return { id, category: "missing_coverage", severity: "blocking", location, claim: `claim for ${id}`, evidenceRefs: [], ...extra };
}

// A fixture `node --test` child must be a GENUINE run: the test runner
// propagates NODE_TEST_CONTEXT, and Node 24 skips nested runs that inherit
// it ("run() is being called recursively ... skipping running files",
// exit 0, no report). Deleting it from the child env keeps the evidence
// honest; inheriting it would fake success with empty bytes.
function w2FixtureEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

const INITIAL: SchedulerEvent = {
  runId: "w2-f3", eventId: "init", sequence: 1, type: "run.initialized",
  occurredAt: "2026-10-05T00:00:00Z", actor: { role: "runner", id: "build-runtime" },
  idempotencyKey: "init", payload: {},
};

// New-policy runs only: the kernel refuses delivery events without the
// runner-configured planning policy, so the fixture configures it exactly
// as a real run creation would.
const POLICY: SchedulerEvent = {
  ...INITIAL, eventId: "policy", sequence: 2, type: "planning.policy_configured",
  idempotencyKey: "policy", payload: { version: 1 },
};

function reviewFixture(stage: DeliveryReviewRecord["stage"]): ReturnType<typeof rebuildSchedulerProjection> {
  const projection = rebuildSchedulerProjection([INITIAL, POLICY]);
  const review: DeliveryReviewRecord = {
    taskId: "T1", reviewId: "review_T1", generation: 2, submissionAttempt: 2, changeSetId: "changeset_T1",
    diffArtifactHash: "a".repeat(64), criteriaIds: ["c1"],
    authorRuntimeId: "work:author", authorModelIdentity: "author",
    architectRuntimeId: "arch:architect", architectModelIdentity: "architect",
    priorReviewId: "review_T1_gen1",
    stage, startedSequence: 1, reviewerRuntimeId: "rev:reviewer", reviewerModelIdentity: "reviewer",
    independence: "distinct_model",
    risk: { tier: "high", score: 4, digest: "b".repeat(64), signals: [] }, sessionIds: [],
    claims: [{ id: "claim:c1", text: "Value is delivered.", evidenceIds: [] }], findings: [],
  };
  projection.delivery = {
    reviews: { T1: review }, reviewHistory: {}, authorModelIdentities: {},
    boundaries: {}, taskAcceptances: {}, phaseAcceptances: {},
  };
  return projection;
}

function depthEvent(report: Record<string, unknown>): SchedulerEvent {
  return {
    ...INITIAL, eventId: "findings", sequence: 3, type: "delivery.findings_recorded",
    actor: { role: "verifier", id: "rev:reviewer" }, idempotencyKey: "findings",
    payload: {
      taskId: "T1", reviewId: "review_T1", sessionId: "fresh", findings: [],
      depth: {
        inspectionToolCalls: 1,
        affectedTests: {
          executedScope: "full_test_script", selectionRung: "full", changedFiles: ["src/value.mjs"],
          selectedTests: ["test/value.test.mjs"], fullSuiteCount: 1,
          command: "node", args: ["--test"], evidenceIds: ["depth-evidence"], exitCode: 1,
          outcome: "failed", report,
        },
        probe: {
          rung: "unavailable", mutantsGenerated: 0, mutantsExecuted: 0, mutantsCaught: 0,
          survivors: [], partial: true, evidenceIds: [], notes: [],
        },
      },
    },
  };
}

test("F3 real node junit bytes yield real failing identities with stored byte provenance", (t) => {
  const root = mkdtempSync(join(tmpdir(), "w2-f3-report-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "value.test.mjs"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
    "test('w2 real passing case', () => assert.equal(1, 1));\n" +
    "test('w2 real failing case', () => assert.equal(1, 2));\n",
  );
  const xmlPath = join(root, "report.xml");
  let failed = false;
  try {
    execFileSync(process.execPath, ["--test", "--test-reporter=junit", `--test-reporter-destination=${xmlPath}`, join(root, "value.test.mjs")], { encoding: "utf8", env: w2FixtureEnv() });
  } catch {
    failed = true; /* exit 1: the failure is the fixture */
  }
  assert.equal(failed, true, "the fixture run must fail");
  const bytes = readFileSync(xmlPath);
  const outcome = nodeJunitOutcome(bytes.toString("utf8"), root, false);
  assert.equal(outcome.status, "failed", "the actual run failed");
  assert.ok(outcome.failingTestIds?.includes("w2 real failing case"), `real failing identity: ${outcome.failingTestIds}`);
  assert.ok(!outcome.failingTestIds?.includes("w2 real passing case"), "passing cases are not failing identities");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  return artifacts.put(bytes, "application/xml", "w2 failing report").then(async (record) => {
    assert.match(record.hash, /^[a-f0-9]{64}$/);
    // The stored bytes reopen byte-identical: the provenance the kernel binds.
    const reopened = new ArtifactStore(join(root, "artifacts"));
    assert.deepEqual(await reopened.get(record.hash), bytes);
    t.diagnostic(`F3 authentic failing identity '${outcome.failingTestIds?.[0]}' at artifact ${record.hash}`);
  });
});

test("F3 kernel preserves failing identities durably; absence stays absent", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "w2-f3-kernel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "value.test.mjs"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
    "test('w2 durable failing case', () => assert.equal(1, 2));\n",
  );
  const xmlPath = join(root, "report.xml");
  try {
    execFileSync(process.execPath, ["--test", "--test-reporter=junit", `--test-reporter-destination=${xmlPath}`, join(root, "value.test.mjs")], { encoding: "utf8", env: w2FixtureEnv() });
  } catch { /* exit 1: the failure is the fixture */ }
  const bytes = readFileSync(xmlPath);
  const outcome = nodeJunitOutcome(bytes.toString("utf8"), root, false);
  assert.equal(outcome.status, "failed");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const record = await artifacts.put(bytes, "application/xml", "w2 durable failing report");
  const report = {
    status: outcome.status, runner: "node --test", format: "junit", path: "report.xml",
    artifactHash: record.hash,
    counts: outcome.counts, failingTestIds: outcome.failingTestIds,
  };
  const next = reduceSchedulerEvent(reviewFixture("diff_delivered"), depthEvent(report));
  assert.deepEqual(
    next.delivery?.reviews.T1?.depth?.affectedTests?.report.failingTestIds,
    ["w2 durable failing case"],
    "authentic failing identities survive the kernel projector",
  );
  // Historical absence is preserved: reports without identities stay absent.
  const absent = reduceSchedulerEvent(
    reviewFixture("diff_delivered"),
    depthEvent({ status: "failed", runner: "node --test", artifactHash: record.hash, counts: { selected: 1, passed: 0, failed: 1, skipped: 0 } }),
  );
  assert.equal(absent.delivery?.reviews.T1?.depth?.affectedTests?.report.failingTestIds, undefined);
  // Malformed identities are dropped, never trusted.
  const malformed = reduceSchedulerEvent(
    reviewFixture("diff_delivered"),
    depthEvent({ status: "failed", runner: "node --test", artifactHash: record.hash, failingTestIds: ["ok", 7] }),
  );
  assert.equal(malformed.delivery?.reviews.T1?.depth?.affectedTests?.report.failingTestIds, undefined);
});

test("F3 classifier binds the exception to this review's stored failed report", () => {
  const hash = "e".repeat(64);
  const base = {
    isReReview: true,
    deltaFiles: ["src/fix.mjs"],
    priorReviewedFiles: ["src/other.mjs"],
    deltaHunks: {},
    priorShownLines: { "src/other.mjs": [3] },
    priorReadRanges: [],
  } as const;
  const proven = finding("late", "src/other.mjs:3", {
    lateFinding: { basis: "failing_test", testIds: ["w2 durable failing case"], rationale: "Runner check fails on the unchanged helper." },
  });
  const bound = { ...base, failingTestIds: ["w2 durable failing case"], depthFailed: true, depthReportArtifactHash: hash };
  assert.deepEqual(applyLateFindingRule([proven], bound).retained.map((item) => item.id), ["late"]);
  // Forged, foreign, successful, byte-less, or unrationalized bases fail closed.
  const forged = finding("forged", "src/other.mjs:3", {
    lateFinding: { basis: "failing_test", testIds: ["invented case"], rationale: "Model claims a failure." },
  });
  assert.deepEqual(applyLateFindingRule([forged], bound).followUp.map((item) => item.id), ["forged"]);
  assert.deepEqual(applyLateFindingRule([proven], { ...bound, depthFailed: false }).followUp.map((item) => item.id), ["late"]);
  assert.deepEqual(applyLateFindingRule([proven], { ...bound, depthReportArtifactHash: undefined }).followUp.map((item) => item.id), ["late"]);
  assert.deepEqual(applyLateFindingRule([proven], { ...bound, depthReportArtifactHash: "not-a-hash" }).followUp.map((item) => item.id), ["late"]);
});
