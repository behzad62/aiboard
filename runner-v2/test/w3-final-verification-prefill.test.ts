import assert from "node:assert/strict";
import test from "node:test";
import {
  validateFinalVerificationPlan,
  type FinalVerificationPlan,
} from "../src/final-verification-contracts.js";
import {
  buildFinalVerificationPlanPrefill,
  finalVerificationProfileDigest,
  type FinalVerificationExecutionProfile,
} from "../src/final-verification-profile.js";
import { parseArchitectActionReason } from "../src/user-steering-contracts.js";
import { architectContextSections } from "../src/agent-prompts.js";
import {
  rebuildSchedulerProjection,
  type SchedulerEvent,
  type SchedulerProjection,
} from "../src/scheduler-store.js";

// W3 (AR-R29/AR-3): the runner-owned final-verification plan prefill marks
// every detected category required without inventing inapplicability
// rationales, binds to the inspected revision/profile, and leaves the
// existing plan validation authoritative.

const RUN = "w3-final-verification";
const AT = "2026-10-05T00:00:00.000Z";
const REV = "r".repeat(40);

function profile(signals: FinalVerificationExecutionProfile["detectedSignals"]): FinalVerificationExecutionProfile {
  const categories = new Set(signals.map((signal) => signal.category));
  return {
    version: 1,
    targetRevision: REV,
    inspectedPaths: ["package.json"],
    detectedSignals: signals,
    commands: {
      ...(categories.has("build") ? { build: [{ label: "build", executable: "npm", args: ["run", "build"] }] } : {}),
      ...(categories.has("tests") ? { tests: [{ label: "tests", executable: "npm", args: ["test"] }] } : {}),
    },
  };
}

test("W3 the prefill marks every detected category required and binds revision and digest", () => {
  const source = profile([
    { category: "build", source: "package.json", detail: "scripts.build" },
    { category: "tests", source: "package.json", detail: "scripts.test" },
  ]);
  const prefill = buildFinalVerificationPlanPrefill(RUN, source);
  assert.deepEqual(prefill.required, ["build", "tests"]);
  assert.deepEqual(prefill.undetected, ["runtime_smoke", "browser"]);
  assert.deepEqual(prefill.detectedSignals, source.detectedSignals);
  assert.equal(prefill.targetRevision, REV);
  assert.equal(prefill.profileDigest, finalVerificationProfileDigest(RUN, source));
  assert.match(prefill.profileDigest, /^[a-f0-9]{64}$/);
});

test("W3 non-detected categories get no fabricated not_applicable rationale", () => {
  const prefill = buildFinalVerificationPlanPrefill(RUN, profile([]));
  assert.deepEqual(prefill.required, []);
  assert.deepEqual(prefill.undetected, ["build", "tests", "runtime_smoke", "browser"]);
  const serialized = JSON.stringify(prefill);
  assert.doesNotMatch(serialized, /rationale/);
  assert.doesNotMatch(serialized, /not_applicable/);
  assert.doesNotMatch(serialized, /repositoryInspection/);
});

test("W3 detected categories still cannot be demoted to not_applicable", () => {
  const source = profile([{ category: "tests", source: "package.json", detail: "scripts.test" }]);
  const prefill = buildFinalVerificationPlanPrefill(RUN, source);
  assert.deepEqual(prefill.required, ["tests"]);
  const plan: FinalVerificationPlan = {
    checks: [
      { category: "build", status: "not_applicable", rationale: "No build script.", repositoryInspection: { paths: ["package.json"], summary: "Checked package.json; no build script." } },
      { category: "tests", status: "not_applicable", rationale: "Skipping.", repositoryInspection: { paths: ["package.json"], summary: "Checked." } },
      { category: "runtime_smoke", status: "not_applicable", rationale: "No server.", repositoryInspection: { paths: ["package.json"], summary: "Checked." } },
      { category: "browser", status: "not_applicable", rationale: "No UI.", repositoryInspection: { paths: ["src"], summary: "Checked." } },
    ],
  };
  const validation = validateFinalVerificationPlan(plan, { detectedSignals: source.detectedSignals });
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.detectedNotApplicableCategories, ["tests"]);
  assert.match(validation.issues.join(" "), /must remain required/);
});

test("W3 the plan-required reason round-trips the prefill and refuses malformed shapes", () => {
  const prefill = buildFinalVerificationPlanPrefill(RUN, profile([{ category: "build", source: "package.json" }]));
  const reason = { type: "final_verification_plan_required", integrationRevision: REV, planPrefill: prefill } as const;
  assert.deepEqual(parseArchitectActionReason(reason), reason);
  assert.deepEqual(
    parseArchitectActionReason({ type: "final_verification_plan_required", integrationRevision: REV }),
    { type: "final_verification_plan_required", integrationRevision: REV },
  );
  assert.throws(
    () => parseArchitectActionReason({ type: "final_verification_plan_required", integrationRevision: REV, planPrefill: { ...prefill, profileDigest: "nope" } }),
    /profileDigest/,
  );
  assert.throws(
    () => parseArchitectActionReason({ type: "final_verification_plan_required", integrationRevision: REV, planPrefill: { ...prefill, required: ["tests", "nope"] } }),
    /required/,
  );
  assert.throws(
    () => parseArchitectActionReason({ type: "final_verification_plan_required", integrationRevision: REV, planPrefill: { ...prefill, rationale: "invented" } }),
    /Unknown user-steering payload field/,
  );
});

const initial: SchedulerEvent = {
  runId: RUN, eventId: "init", sequence: 1, type: "run.initialized",
  occurredAt: AT, actor: { role: "runner", id: "build-runtime" },
  idempotencyKey: "init", payload: {},
};

function projectionAt(revision: string | undefined): SchedulerProjection {
  const projection = rebuildSchedulerProjection([initial]);
  projection.planningPolicyVersion = 1;
  if (revision !== undefined) projection.integrationRevision = revision;
  return projection;
}

test("W3 the prefill section renders only when bound to the current revision", () => {
  const prefill = buildFinalVerificationPlanPrefill(RUN, profile([{ category: "tests", source: "package.json", detail: "scripts.test" }]));
  const sectionsFor = (revision: string | undefined) => architectContextSections({
    limits: { maxBytes: 1024 * 1024, maxEstimatedTokens: 256 * 1024 },
    objective: "Finish verification.",
    reason: { type: "final_verification_plan_required", integrationRevision: revision ?? "missing" },
    projection: projectionAt(revision),
    finalVerificationPrefill: prefill,
    instructions: [],
    skills: [],
    memories: [],
    evidence: [],
    recentHistory: [],
  });
  const fresh = sectionsFor(REV).find((section) => section.id === "final-verification-prefill")?.content ?? "";
  assert.match(fresh, /already required/);
  assert.match(fresh, /"tests"/);
  assert.match(fresh, new RegExp(REV));
  assert.match(fresh, /cannot be marked not_applicable/);
  assert.doesNotMatch(fresh, /"rationale"/);
  // Revision drift drops the stale prefill instead of presenting it.
  assert.equal(sectionsFor("0".repeat(40)).find((section) => section.id === "final-verification-prefill"), undefined);
  assert.equal(sectionsFor(undefined).find((section) => section.id === "final-verification-prefill"), undefined);
});
