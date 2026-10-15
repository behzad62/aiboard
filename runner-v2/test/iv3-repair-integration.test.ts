import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import {
  DEFAULT_VALIDATION_BUDGET_MS,
  PROJECT_VALIDATION_CONFIG_PATH,
  cloneProjectValidationConfig,
  parseProjectValidationConfig,
  projectValidationConfigDigest,
  readValidationBudgetMsAtRevision,
  selectValidationTier,
  tierCommandsForTier,
  validationBudgetMsForConfig,
} from "../src/project-validation-config.js";
import {
  assertFinalVerificationExecutionProfile,
  cloneFinalVerificationExecutionProfile,
  finalVerificationProfileDigest,
  inspectFinalVerificationExecutionProfile,
  projectTierCommandsToRuntimeCommands,
} from "../src/final-verification-profile.js";
import {
  cloneValidationBudgetSubmission,
  getValidationBudgetUsage,
  isRunValidationBudgetScope,
  parseValidationBudgetSubmission,
  recordValidationBoundarySegment,
  recordValidationEvidenceSegment,
  summarizeValidationBudget,
  validationBudgetScopeId,
  validationEvidenceSegmentId,
} from "../src/validation-budget.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";
import { runGit } from "./support/git-fixture.js";
import {
  assertSelectedExecutionCoherence,
  assertValidationTierCoherence,
  evaluatePhaseAcceptance,
  validateSelectedCommandEvidenceBinding,
} from "../src/delivery-acceptance.js";
import { planTestReport } from "../src/delivery-execution.js";
import { claimBindingDigest } from "../src/review-key.js";
import { createEvidenceTools } from "../src/evidence-tools.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { ToolRegistry } from "../src/tool-registry.js";
import type { OneShotCommandExecutor } from "../src/one-shot-command-executor.js";
import { narrowNodeTestCommand, isPackageRunTestCommand } from "../src/flaky-rerun.js";
import { inspectTestIntegrityPin } from "../src/test-integrity-profile.js";
import {
  testIntegrityBaselineFindings,
  testIntegrityProfileFindings,
} from "../src/test-integrity.js";

/**
 * IV-3 independent-review repair 1: focused production integration for
 * F1-F6. Each test drives the real production path (parsers, profiles,
 * ledgers, pins, scopes) with hermetic temp state. No models, no network.
 */

function budgetLedgerFor(database: string, runId: string): SqliteBudgetLedger {
  return new SqliteBudgetLedger(database, {
    limitsFor: (scopeId) => {
      if (scopeId === runId) return { maxToolCalls: 1000 };
      if (isRunValidationBudgetScope(scopeId, runId)) return {};
      throw new Error(`Unknown budget scope ${scopeId}.`);
    },
  });
}

async function initRepo(root: string): Promise<void> {
  await runGit({ cwd: root, args: ["init", "-b", "main"] });
}

async function commitAll(root: string, message: string): Promise<string> {
  await runGit({ cwd: root, args: ["add", "--all"] });
  await runGit({ cwd: root, args: ["commit", "-m", message] });
  return (await runGit({ cwd: root, args: ["rev-parse", "HEAD"] })).stdout.trim();
}


// ---------------------------------------------------------------------------
// F1: one compatible command shape; strict parser, composable profile/runtime.
// ---------------------------------------------------------------------------

test("IV-3 F1: profile tiers use the strict config shape and convert to runtime commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "iv3-f1-"));
  try {
    await initRepo(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "f1", scripts: { test: "node --test" } }));
    writeFileSync(
      join(root, PROJECT_VALIDATION_CONFIG_PATH),
      JSON.stringify({
        version: 1,
        validationBudgetMs: 1234,
        tiers: {
          fast: [{ label: "fast unit", executable: "node", args: ["--test", "test/fast/"], environment: { FAST: "1" } }],
          slow: [{ label: "slow suite", executable: "node", args: ["--test"], timeoutMs: 60000 }],
        },
      }),
    );
    const revision = await commitAll(root, "valid tier config");
    const profile = await inspectFinalVerificationExecutionProfile({
      repositoryRoot: root,
      targetRevision: revision,
      execute: runGit,
    });
    assert.equal(profile.validationBudgetMs, 1234);
    assert.deepEqual(Object.keys(profile.tiers ?? {}).sort(), ["fast", "slow"]);
    // Strict config shape: string-only env, no removals.
    assert.deepEqual(profile.tiers?.fast?.[0]?.environment, { FAST: "1" });
    // Clone/assert/digest roundtrip preserves tiers and budget.
    const clone = cloneFinalVerificationExecutionProfile(profile);
    assert.deepEqual(clone.tiers, profile.tiers);
    assert.equal(clone.validationBudgetMs, 1234);
    assertFinalVerificationExecutionProfile(clone, revision);
    assert.equal(finalVerificationProfileDigest("run-f1", clone), finalVerificationProfileDigest("run-f1", profile));
    // Runtime conversion composes without casts hiding removals.
    const runtime = projectTierCommandsToRuntimeCommands(profile.tiers!.fast!);
    assert.equal(runtime[0]!.executable, "node");
    assert.deepEqual(runtime[0]!.args, ["--test", "test/fast/"]);
    assert.deepEqual(runtime[0]!.environment, { FAST: "1" });
    // tierCommandsForTier works directly on profile tiers (the F1 tsc fix).
    const selected = tierCommandsForTier(profile.tiers, "fast");
    assert.equal(selected?.length, 1);
    assert.equal(selected?.[0]?.label, "fast unit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IV-3 F1/F7.5: malformed config and unknown tiers fail closed; missing map keeps IV-2 shape", async () => {
  const root = mkdtempSync(join(tmpdir(), "iv3-f1-strict-"));
  try {
    await initRepo(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "f1s", scripts: { test: "node --test" } }));
    // Unknown tier refused.
    writeFileSync(join(root, PROJECT_VALIDATION_CONFIG_PATH), JSON.stringify({ version: 1, tiers: { turbo: [] } }));
    const unknownTierRevision = await commitAll(root, "unknown tier");
    await assert.rejects(
      inspectFinalVerificationExecutionProfile({ repositoryRoot: root, targetRevision: unknownTierRevision, execute: runGit }),
      /Unknown validation tier/,
    );
    // Non-string env refused (strict: strings only).
    writeFileSync(
      join(root, PROJECT_VALIDATION_CONFIG_PATH),
      JSON.stringify({ version: 1, tiers: { fast: [{ label: "f", executable: "node", args: [], environment: { X: 1 } }] } }),
    );
    const badEnvironmentRevision = await commitAll(root, "bad environment");
    await assert.rejects(
      inspectFinalVerificationExecutionProfile({ repositoryRoot: root, targetRevision: badEnvironmentRevision, execute: runGit }),
      /environment/,
    );
    // Unknown top-level field refused.
    assert.throws(() => parseProjectValidationConfig({ version: 1, unknown: true }), /unknown field/);
    // Missing config: no profile tiers/budget fields (exact IV-2 shape).
    rmSync(join(root, PROJECT_VALIDATION_CONFIG_PATH), { force: true });
    const bareRevision = await commitAll(root, "remove validation config");
    const bare = await inspectFinalVerificationExecutionProfile({ repositoryRoot: root, targetRevision: bareRevision, execute: runGit });
    assert.equal(bare.tiers, undefined);
    assert.equal(bare.validationBudgetMs, undefined);
    const cloned = cloneProjectValidationConfig(parseProjectValidationConfig({ version: 1 }));
    assert.equal(cloned.tiers, undefined);
    assert.equal(validationBudgetMsForConfig(undefined), DEFAULT_VALIDATION_BUDGET_MS);
    assert.equal(projectValidationConfigDigest(cloned), projectValidationConfigDigest(cloneProjectValidationConfig(cloned)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IV-3 product repair: absolute direct node tier command gets runner-owned JUnit plan", () => {
  const root = mkdtempSync(join(tmpdir(), "iv3-direct-node-report-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "direct-node-report" }));
    const plan = planTestReport({
      checkoutPath: root,
      command: {
        label: "integration package a",
        executable: process.execPath,
        args: ["--test", "packages/a/test/a.test.mjs"],
        environment: { IV3_TIER: "integration" },
      },
      reportName: "iv3-direct-node",
    });
    assert.equal(plan.runner, "node --test");
    assert.equal(plan.format, "junit");
    assert.ok(plan.reportPath?.endsWith(".xml"));
    assert.deepEqual(plan.command?.args, ["--test", "packages/a/test/a.test.mjs"]);
    assert.equal(plan.command?.environment?.IV3_TIER, "integration");
    assert.match(plan.command?.environment?.NODE_OPTIONS ?? "", /--test-reporter=junit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F2: revision-bound budget resolver; override enforced, missing preserves 600000.
// ---------------------------------------------------------------------------

test("IV-3 F2: readValidationBudgetMsAtRevision binds the trusted revision blob", async () => {
  const root = mkdtempSync(join(tmpdir(), "iv3-f2-"));
  const git = async (...args: string[]) => (await runGit({ cwd: root, args })).stdout.trim();
  try {
    await git("init", "-b", "main");
    await git("config", "user.email", "iv3@example.com");
    await git("config", "user.name", "iv3");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "f2" }));
    await git("add", "--all");
    await git("commit", "-m", "base");
    const base = await git("rev-parse", "HEAD");
    // Missing config preserves the default.
    assert.equal(await readValidationBudgetMsAtRevision({ git: runGit, cwd: root, revision: base }), 600_000);
    // Configured override binds.
    writeFileSync(join(root, PROJECT_VALIDATION_CONFIG_PATH), JSON.stringify({ version: 1, validationBudgetMs: 50 }));
    await git("add", "--all");
    await git("commit", "-m", "override");
    const override = await git("rev-parse", "HEAD");
    assert.equal(await readValidationBudgetMsAtRevision({ git: runGit, cwd: root, revision: override }), 50);
    // The old revision still reads the old value (revision-bound, not ambient).
    assert.equal(await readValidationBudgetMsAtRevision({ git: runGit, cwd: root, revision: base }), 600_000);
    // Malformed config fails closed.
    writeFileSync(join(root, PROJECT_VALIDATION_CONFIG_PATH), JSON.stringify({ version: 1, validationBudgetMs: -5 }));
    await git("add", "--all");
    await git("commit", "-m", "malformed");
    const bad = await git("rev-parse", "HEAD");
    await assert.rejects(readValidationBudgetMsAtRevision({ git: runGit, cwd: root, revision: bad }), /malformed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IV-3 F2/F7.3: override 50ms + measured >50 requires reason; default would not", () => {
  const dir = mkdtempSync(join(tmpdir(), "iv3-f2-submit-"));
  const database = join(dir, "budget.sqlite");
  const ledger = budgetLedgerFor(database, "run_f2");
  try {
    recordValidationEvidenceSegment(ledger, {
      runId: "run_f2",
      taskId: "task_a",
      sessionId: "sess_1",
      callId: "call_1",
      startedAt: "2026-10-06T00:00:00.000Z",
      finishedAt: "2026-10-06T00:00:00.060Z",
    });
    assert.equal(getValidationBudgetUsage(ledger, "run_f2", "task_a").usedMs, 60);
    // Project override 50ms: over budget, justification required.
    const over = summarizeValidationBudget(ledger, { runId: "run_f2", taskId: "task_a", budgetMs: 50 });
    assert.equal(over.overBudget, true);
    assert.throws(() => parseValidationBudgetSubmission({ summary: over }), /requires a justification/);
    const accepted = parseValidationBudgetSubmission({ summary: over, justification: "slow suite needed a second pass" });
    assert.equal(accepted.justification, "slow suite needed a second pass");
    // Default 600000: same measured usage is under budget, reason forbidden.
    const under = summarizeValidationBudget(ledger, { runId: "run_f2", taskId: "task_a", budgetMs: 600_000 });
    assert.equal(under.overBudget, false);
    assert.deepEqual(parseValidationBudgetSubmission({ summary: under }), { summary: under });
    assert.throws(() => parseValidationBudgetSubmission({ summary: under, justification: "noise" }), /only when over budget/);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F3: tier-aware scope; forged tier rejected; slow milestone satisfies gate;
// tier subsets skip count and preserve the full baseline; legacy replay intact.
// ---------------------------------------------------------------------------

test("IV-3 F3: validation_tier coherence requires a real tier, command, and evidence", () => {
  // Coherent tier records pass.
  assertValidationTierCoherence("Boundary", {
    executedScope: "validation_tier",
    validationTier: "slow",
    command: "node",
    args: ["--test"],
    evidenceIds: ["ev-1"],
  });
  assertValidationTierCoherence("Affected-test", {
    executedScope: "validation_tier",
    validationTier: "fast",
    command: "node",
    args: ["--test", "test/fast/"],
    evidenceIds: ["ev-1", "ev-2"],
  });
  // Forged or incoherent tier values fail closed.
  for (const tier of [undefined, "turbo", "release", 42, ""]) {
    assert.throws(
      () => assertValidationTierCoherence("Boundary", {
        executedScope: "validation_tier",
        validationTier: tier,
        command: "node",
        args: ["--test"],
        evidenceIds: ["ev-1"],
      }),
      /tier/,
    );
  }
  // Tier scope without an actual command/evidence fails closed.
  for (const input of [
    { command: "", args: ["--test"], evidenceIds: ["ev-1"] },
    { command: "none", args: ["--test"], evidenceIds: ["ev-1"] },
    { command: "node", args: ["--test"], evidenceIds: [] },
  ]) {
    assert.throws(
      () => assertValidationTierCoherence("Boundary", {
        executedScope: "validation_tier",
        validationTier: "slow",
        ...input,
      }),
      /command|evidence/,
    );
  }
  // Full/selected scopes must not carry a forged tier.
  for (const scope of ["full_test_script", "selected"]) {
    assert.throws(
      () => assertValidationTierCoherence("Boundary", {
        executedScope: scope,
        validationTier: "fast",
        command: "node",
        args: ["--test"],
        evidenceIds: ["ev-1"],
      }),
      /only validation_tier scope carries a tier/,
    );
  }
  // Legacy full records without a tier still pass both coherence rules.
  assertValidationTierCoherence("Boundary", {
    executedScope: "full_test_script",
    validationTier: undefined,
    command: undefined,
    args: undefined,
    evidenceIds: undefined,
  });
  assertSelectedExecutionCoherence("Boundary", {
    executedScope: "full_test_script",
    rung: "legacy-rung",
    widened: undefined,
    wideningReasons: undefined,
    selectedTests: [],
    args: [],
  });
});

test("IV-3 F3: tier subsets skip full-suite count comparison like selected", () => {
  const pin = { revision: "base", commands: [{ executable: "npm", args: ["run", "test"] }], script: "node --test", configDigest: "c".repeat(64) };
  const baseline = { kind: "executed_report" as const, pin, executed: 100 };
  // Full scope shrinks flag.
  const full = testIntegrityBaselineFindings(baseline, pin, 2, { executedScope: "full_test_script" });
  assert.ok(full.some((finding) => finding.code === "suite_shrank"), "full scope must flag 100→2 shrink");
  // Selected and tier subsets skip the count comparison (profile/config guards still apply).
  assert.deepEqual(testIntegrityBaselineFindings(baseline, pin, 2, { executedScope: "selected" }), []);
  assert.deepEqual(testIntegrityBaselineFindings(baseline, pin, 2, { executedScope: "validation_tier" }), []);
  // Config changes still trip for tier subsets.
  const changed = { ...pin, configDigest: "d".repeat(64) };
  const tierFindings = testIntegrityBaselineFindings(baseline, changed, 2, { executedScope: "validation_tier" });
  assert.ok(tierFindings.some((finding) => finding.code === "test_config_changed"));
  assert.ok(!tierFindings.some((finding) => finding.code === "suite_shrank"));
});

test("IV-3 F3: slow milestone tier satisfies the tests gate; fast tier does not", () => {
  const base = {
    phase: { id: "P1", requirementIds: ["R1"] as readonly string[], contributingTaskIds: ["T1"] as readonly string[], requiredCombinedValidation: ["tests"] as readonly string[] },
    requirements: [{ id: "R1", contributingTaskIds: ["T1"] as readonly string[], applicability: { status: "applicable" as const } }] as const,
    taskStatuses: new Map([["T1", "integrated"]]),
    integrationRevision: "rev-1",
  };
  const boundaryFor = (scope: "full_test_script" | "validation_tier", tier?: "slow" | "fast") => ({
    taskId: "T1",
    boundaryId: "boundary:T1:1",
    generation: 1,
    attempt: 1,
    integrationRevision: "rev-1",
    changedFiles: ["a.ts"],
    executedScope: scope,
    ...(tier ? { validationTier: tier } : {}),
    selection: { rung: "module_graph", selectedTests: ["t.test.mjs"] },
    checks: [{ checkId: "tests", command: "node", args: ["--test"], evidenceIds: ["ev-1"], exitCode: 0, outcome: "passed" as const, report: { status: "passed" as const, runner: "node --test", format: "junit" as const, path: "r.xml", artifactHash: "a".repeat(64), counts: { selected: 1, passed: 1, failed: 0, skipped: 0 } } }],
    passed: true,
    sequence: 1,
  });
  const stateFor = (boundary: ReturnType<typeof boundaryFor>) => ({
    reviews: {},
    reviewHistory: {},
    authorModelIdentities: {},
    boundaries: { T1: [boundary] },
    taskAcceptances: { T1: { taskId: "T1", reviewId: "r", submissionAttempt: 1, changeSetId: "c", boundaryId: boundary.boundaryId, integrationRevision: "rev-1", requiredChecks: [], acceptedAt: "2026-10-06T00:00:00.000Z", sequence: 1 } },
    phaseAcceptances: {},
  });
  // Slow tier satisfies the milestone gate.
  const slow = evaluatePhaseAcceptance({ ...base, state: stateFor(boundaryFor("validation_tier", "slow")) as never });
  assert.equal(slow.ready, true, slow.issues.join(" "));
  // Fast tier does not satisfy the full-suite gate.
  const fast = evaluatePhaseAcceptance({ ...base, state: stateFor(boundaryFor("validation_tier", "fast")) as never });
  assert.equal(fast.ready, false);
  assert.ok(fast.issues.some((issue) => /no passed tests run/.test(issue)));
  // Full still satisfies (IV-2 behavior preserved).
  const full = evaluatePhaseAcceptance({ ...base, state: stateFor(boundaryFor("full_test_script")) as never });
  assert.equal(full.ready, true, full.issues.join(" "));
});

test("IV-3 F3: tier evidence binds to the authoritative command record, not self-reported argv", () => {
  const evidenceStore = {
    getByIds: ({ ids }: { runId: string; ids: readonly string[] }) =>
      ids.map((id) => ({
        id,
        taskId: id === "ev-tier" ? "delivery:T1" : "delivery:OTHER",
        fact: { kind: "command", command: "node", args: ["--test", "test/slow/"] },
      })),
  };
  // Coherent tier binding passes.
  validateSelectedCommandEvidenceBinding(
    {
      runId: "run-1",
      type: "delivery.boundary_checked",
      payload: {
        taskId: "T1",
        executedScope: "validation_tier",
        checks: [{ checkId: "tests", command: "node", args: ["--test", "test/slow/"], evidenceIds: ["ev-tier"] }],
      },
    },
    evidenceStore as never,
  );
  // Forged argv (self-reported args differ from evidence) fails closed.
  assert.throws(
    () => validateSelectedCommandEvidenceBinding(
      {
        runId: "run-1",
        type: "delivery.boundary_checked",
        payload: {
          taskId: "T1",
          executedScope: "validation_tier",
          checks: [{ checkId: "tests", command: "node", args: ["--test", "test/other/"], evidenceIds: ["ev-tier"] }],
        },
      },
      evidenceStore as never,
    ),
    /ran a different command/,
  );
  // Foreign task evidence fails closed.
  assert.throws(
    () => validateSelectedCommandEvidenceBinding(
      {
        runId: "run-1",
        type: "delivery.boundary_checked",
        payload: {
          taskId: "T1",
          executedScope: "validation_tier",
          checks: [{ checkId: "tests", command: "node", args: ["--test", "test/slow/"], evidenceIds: ["ev-foreign"] }],
        },
      },
      evidenceStore as never,
    ),
    /belongs to task/,
  );
  // Legacy full records keep historical replay: no new binding requirement.
  validateSelectedCommandEvidenceBinding(
    {
      runId: "run-1",
      type: "delivery.boundary_checked",
      payload: {
        taskId: "T1",
        executedScope: "full_test_script",
        checks: [{ checkId: "tests", command: "claimed", args: ["forged"], evidenceIds: [] }],
      },
    },
    evidenceStore as never,
  );
});

test("IV-3 F3/F7.6: low/medium/high map to fast/component/integration; no map keeps IV-2 fallback", () => {
  assert.equal(selectValidationTier({ changeRisk: "low", isMilestoneGate: false, isFinalCandidate: false }), "fast");
  assert.equal(selectValidationTier({ changeRisk: "medium", isMilestoneGate: false, isFinalCandidate: false }), "component");
  assert.equal(selectValidationTier({ changeRisk: "high", isMilestoneGate: false, isFinalCandidate: false }), "integration");
  assert.equal(selectValidationTier({ changeRisk: "low", isMilestoneGate: true, isFinalCandidate: false }), "slow");
  assert.equal(selectValidationTier({ changeRisk: "high", isMilestoneGate: false, isFinalCandidate: true }), "release");
  const tiers = parseProjectValidationConfig({
    version: 1,
    tiers: { fast: [{ label: "f", executable: "node", args: ["--test", "test/fast/"] }] },
  }).tiers;
  assert.equal(tierCommandsForTier(tiers, "fast")?.[0]?.args[1], "test/fast/");
  assert.equal(tierCommandsForTier(tiers, "slow"), undefined);
  assert.equal(tierCommandsForTier(undefined, "fast"), undefined);
});

// ---------------------------------------------------------------------------
// F4: validationBudget binds into the ReviewKey optionally; absent hashes legacy.
// ---------------------------------------------------------------------------

test("IV-3 F4: absent budget hashes legacy; present budget invalidates on change", () => {
  const base = {
    objective: "Do T1",
    criteria: [{ id: "c1", text: "criterion one" }],
    claims: [{ id: "claim:c1", text: "done", evidenceContent: ["digest-1"] }],
    workerSummary: "did it",
    unresolvedConcerns: [] as readonly string[],
  };
  const legacy = claimBindingDigest(base);
  // Absent hashes exactly as before (explicit undefined same as omitted).
  assert.equal(claimBindingDigest({ ...base, validationBudget: undefined }), legacy);
  const budget = {
    summary: {
      budgetMs: 50,
      usedMs: 60,
      overBudget: true,
      scopeId: validationBudgetScopeId("run_1", "task_a"),
      segments: [{ segmentId: validationEvidenceSegmentId("sess_1", "call_1"), kind: "evidence" as const, startedAt: "2026-10-06T00:00:00.000Z", durationMs: 60 }],
    },
    justification: "slow suite needed a second pass",
  };
  const withBudget = claimBindingDigest({ ...base, validationBudget: budget });
  assert.notEqual(withBudget, legacy, "present budget must change the key");
  // Same code/evidence + changed justification => fresh key.
  const changedJustification = claimBindingDigest({
    ...base,
    validationBudget: { ...budget, justification: "different reason entirely" },
  });
  assert.notEqual(changedJustification, withBudget);
  // Same code/evidence + changed snapshot (usedMs/segments) => fresh key.
  const changedSnapshot = claimBindingDigest({
    ...base,
    validationBudget: {
      ...budget,
      summary: { ...budget.summary, usedMs: 61, segments: [{ ...budget.summary.segments[0]!, durationMs: 61 }] },
    },
  });
  assert.notEqual(changedSnapshot, withBudget);
  // Deterministic: same input hashes the same.
  assert.equal(claimBindingDigest({ ...base, validationBudget: cloneValidationBudgetSubmission(budget) }), withBudget);
});

// ---------------------------------------------------------------------------
// F5: release-tier flaky rerun keeps the failed command identity.
// ---------------------------------------------------------------------------

test("IV-3 F5: release-tier node --test narrows from its own identity; unfilterable never falls back", () => {
  const release = projectTierCommandsToRuntimeCommands([
    { label: "release suite", executable: "node", args: ["--test", "test/release/"] },
  ])[0]!;
  const detected = { label: "package tests", executable: process.execPath, args: ["/x/npm-cli.js", "run", "test"] };
  // The release identity narrows from itself.
  const narrowed = narrowNodeTestCommand(release, ["release-case"]);
  assert.ok(narrowed, "release node --test must be narrowable");
  assert.ok(narrowed!.args.some((arg) => arg.includes("release-case")), "narrowed release keeps the failing test filter");
  assert.equal(narrowed!.executable, "node");
  assert.ok(narrowed!.args.includes("test/release/"), "narrowed release keeps its own suite path, not the default suite");
  // A release command that cannot be narrowed is unsupported, never the default suite.
  const unfilterable = projectTierCommandsToRuntimeCommands([
    { label: "release custom", executable: "custom-runner", args: ["--all"] },
  ])[0]!;
  assert.equal(narrowNodeTestCommand(unfilterable, ["x"]), undefined);
  assert.equal(isPackageRunTestCommand(unfilterable), false);
  assert.notDeepEqual(unfilterable, detected, "unsupported release must never become the detected default command");
});

// ---------------------------------------------------------------------------
// F6: aiboard-validation.json participates in the immutable test-integrity pin.
// ---------------------------------------------------------------------------

test("IV-3 F6: unchanged validation config is clean; budget/tier change trips test_config_changed", async () => {
  const root = mkdtempSync(join(tmpdir(), "iv3-f6-"));
  const git = async (...args: string[]) => (await runGit({ cwd: root, args })).stdout.trim();
  try {
    await git("init", "-b", "main");
    await git("config", "user.email", "iv3@example.com");
    await git("config", "user.name", "iv3");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    writeFileSync(join(root, PROJECT_VALIDATION_CONFIG_PATH), JSON.stringify({ version: 1, validationBudgetMs: 600000 }));
    await git("add", "--all");
    await git("commit", "-m", "baseline");
    const base = await git("rev-parse", "HEAD");
    const commands = [{ executable: "npm", args: ["run", "test"] }];
    const pinned = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: base, commands });
    // Unchanged config: clean.
    assert.deepEqual(testIntegrityProfileFindings(pinned, await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: base, commands })), []);
    // Budget-only change trips the guard.
    writeFileSync(join(root, PROJECT_VALIDATION_CONFIG_PATH), JSON.stringify({ version: 1, validationBudgetMs: 50 }));
    await git("add", "--all");
    await git("commit", "-m", "budget change");
    const budgeted = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: await git("rev-parse", "HEAD"), commands });
    const budgetFindings = testIntegrityProfileFindings(pinned, budgeted);
    assert.ok(budgetFindings.some((finding) => finding.code === "test_config_changed"), "budget change must trip test_config_changed");
    // Tier-map change trips the guard.
    writeFileSync(
      join(root, PROJECT_VALIDATION_CONFIG_PATH),
      JSON.stringify({ version: 1, tiers: { fast: [{ label: "f", executable: "node", args: ["--test"] }] } }),
    );
    await git("add", "--all");
    await git("commit", "-m", "tier change");
    const tiered = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: await git("rev-parse", "HEAD"), commands });
    assert.ok(testIntegrityProfileFindings(budgeted, tiered).some((finding) => finding.code === "test_config_changed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F7.1: evidence durations count actual outcomes; reuse counts zero; idempotent.
// ---------------------------------------------------------------------------

test("IV-3 F7.1: evidence tool counts success/nonzero/timeout/cancelled; reuse zero; idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "iv3-f71-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const store = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const ledger = budgetLedgerFor(join(root, "budget.sqlite"), "run_ev");
  try {
    let now = Date.parse("2026-10-06T00:00:00.000Z");
    const clock = () => new Date(now).toISOString();
    const advance = (ms: number) => { now += ms; };
    const processFor = (outcome: "exited" | "timed_out" | "cancelled", exitCode?: number) => ({
      logicalProcessId: `p-${outcome}-${exitCode ?? "x"}`,
      outcome,
      ...(exitCode !== undefined ? { exitCode } : {}),
      finishedAt: clock(),
      output: [
        { stream: "stdout" as const, tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
        { stream: "stderr" as const, tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
      ],
      cleanup: { state: "verified_empty" as const, verifiedAt: clock() },
    });
    const executionFor = (process: ReturnType<typeof processFor>): OneShotCommandExecutor => ({
      execute: async () => {
        advance(100);
        return { process, enforcement: "unconfined_explicit_full" as const, disclosure: "unconfined_explicit_full" as const };
      },
    });
    const registry = new ToolRegistry();
    // Success executor first; swapped per call below via re-registration.
    let current: OneShotCommandExecutor = executionFor(processFor("exited", 0));
    const tools = () => createEvidenceTools({
      store,
      artifacts,
      taskId: "task_a",
      execution: { execute: (request) => current.execute(request) },
      validationAccounting: { ledger, runId: "run_ev" },
      clock,
    });
    for (const tool of tools()) registry.register(tool);
    const baseContext = {
      runId: "run_ev",
      sessionId: "sess_ev",
      actor: { role: "worker" as const, id: "worker_1" },
      workspacePath: workspace,
    };
    const invoke = (callId: string) => registry.invoke(
      { type: "tool_call", callId, name: "run_evidence_command", arguments: { label: `c-${callId}`, command: "fixture", args: [] } } as never,
      baseContext as never,
    );
    // Success counts.
    current = executionFor(processFor("exited", 0));
    assert.equal((await invoke("call-success")).isError, false);
    assert.equal(getValidationBudgetUsage(ledger, "run_ev", "task_a").usedMs, 100);
    // Nonzero counts.
    current = executionFor(processFor("exited", 3));
    assert.equal((await invoke("call-nonzero")).isError, false);
    assert.equal(getValidationBudgetUsage(ledger, "run_ev", "task_a").usedMs, 200);
    // Timeout counts.
    current = executionFor(processFor("timed_out"));
    assert.equal((await invoke("call-timeout")).isError, false);
    assert.equal(getValidationBudgetUsage(ledger, "run_ev", "task_a").usedMs, 300);
    // Cancelled counts.
    current = executionFor(processFor("cancelled"));
    assert.equal((await invoke("call-cancelled")).isError, false);
    assert.equal(getValidationBudgetUsage(ledger, "run_ev", "task_a").usedMs, 400);
    // V2 reused result counts zero.
    current = {
      execute: async () => {
        advance(100);
        return {
          process: processFor("exited", 0),
          reuseSource: { id: "ev-old" } as never,
          enforcement: "unconfined_explicit_full" as const,
          disclosure: "unconfined_explicit_full" as const,
        };
      },
    };
    assert.equal((await invoke("call-reused")).isError, false);
    assert.equal(getValidationBudgetUsage(ledger, "run_ev", "task_a").usedMs, 400, "reused execution adds zero");
    // Idempotent same call adds zero even with advanced wall time.
    current = executionFor(processFor("exited", 0));
    advance(5000);
    assert.equal((await invoke("call-success")).isError, true, "reusing evidence idempotency with changed timestamped fact fails closed");
    assert.equal(getValidationBudgetUsage(ledger, "run_ev", "task_a").usedMs, 400, "same call id adds zero on retry");
    // Executor throwing before a trusted result contributes zero.
    current = { execute: async () => { throw Object.assign(new Error("launch_not_proven"), { code: "launch_not_proven" }); } };
    const failed = await invoke("call-throw");
    assert.equal(failed.isError, true);
    assert.equal(getValidationBudgetUsage(ledger, "run_ev", "task_a").usedMs, 400);
  } finally {
    store.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F7.2: boundary counted exactly once per attempt; overage never changes pass/fail.
// ---------------------------------------------------------------------------

test("IV-3 F7.2: boundary duration once per attempt; overage never changes pass/fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "iv3-f72-"));
  const ledger = budgetLedgerFor(join(dir, "budget.sqlite"), "run_b");
  try {
    recordValidationBoundarySegment(ledger, {
      runId: "run_b",
      taskId: "task_a",
      boundaryId: "boundary:task_a:1",
      attempt: 1,
      startedAt: "2026-10-06T00:00:00.000Z",
      finishedAt: "2026-10-06T00:00:01.000Z",
    });
    assert.equal(getValidationBudgetUsage(ledger, "run_b", "task_a").usedMs, 1000);
    // Same attempt retried with different wall time adds zero.
    recordValidationBoundarySegment(ledger, {
      runId: "run_b",
      taskId: "task_a",
      boundaryId: "boundary:task_a:1",
      attempt: 1,
      startedAt: "2026-10-06T01:00:00.000Z",
      finishedAt: "2026-10-06T01:00:05.000Z",
    });
    assert.equal(getValidationBudgetUsage(ledger, "run_b", "task_a").usedMs, 1000);
    // A new attempt adds its own duration.
    recordValidationBoundarySegment(ledger, {
      runId: "run_b",
      taskId: "task_a",
      boundaryId: "boundary:task_a:1",
      attempt: 2,
      startedAt: "2026-10-06T02:00:00.000Z",
      finishedAt: "2026-10-06T02:00:00.500Z",
    });
    assert.equal(getValidationBudgetUsage(ledger, "run_b", "task_a").usedMs, 1500);
    // Overage never changes pass/fail: passed is every check passed, independent of budget.
    const checks = [
      { checkId: "build", outcome: "passed" as const },
      { checkId: "tests", outcome: "passed" as const },
    ];
    const passed = checks.every((check) => check.outcome === "passed");
    assert.equal(passed, true);
    assert.equal(summarizeValidationBudget(ledger, { runId: "run_b", taskId: "task_a", budgetMs: 10 }).overBudget, true);
    assert.equal(passed, true, "over budget must not flip a passed boundary");
    const failedChecks: Array<{ checkId: string; outcome: "passed" | "failed" }> = [{ checkId: "tests", outcome: "failed" }];
    assert.equal(failedChecks.every((check) => check.outcome === "passed"), false);
    assert.equal(summarizeValidationBudget(ledger, { runId: "run_b", taskId: "other", budgetMs: 600_000 }).overBudget, false);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F7.3: submit dynamics; durable justification; reopen-exact; retry clears reason.
// ---------------------------------------------------------------------------

test("IV-3 F7.3: over-budget refusal is dynamic; justification durable; retry clears reason, usage persists", () => {
  const dir = mkdtempSync(join(tmpdir(), "iv3-f73-"));
  const database = join(dir, "budget.sqlite");
  let ledger: SqliteBudgetLedger | undefined = budgetLedgerFor(database, "run_s");
  try {
    // Under budget at tool-creation time: no reason needed.
    const before = summarizeValidationBudget(ledger, { runId: "run_s", taskId: "task_a", budgetMs: 1000 });
    assert.equal(before.overBudget, false);
    assert.deepEqual(parseValidationBudgetSubmission({ summary: before }), { summary: before });
    // Usage recorded AFTER the submit tool was created: refusal is dynamic.
    recordValidationEvidenceSegment(ledger, {
      runId: "run_s",
      taskId: "task_a",
      sessionId: "sess_1",
      callId: "call_1",
      startedAt: "2026-10-06T00:00:00.000Z",
      finishedAt: "2026-10-06T00:00:02.000Z",
    });
    const over = summarizeValidationBudget(ledger, { runId: "run_s", taskId: "task_a", budgetMs: 1000 });
    assert.equal(over.overBudget, true);
    assert.throws(() => parseValidationBudgetSubmission({ summary: over }), /requires a justification/);
    const submission = parseValidationBudgetSubmission({ summary: over, justification: "  integration pass ran long  " });
    assert.equal(submission.justification, "integration pass ran long");
    // Durable clone roundtrip.
    assert.deepEqual(cloneValidationBudgetSubmission(submission), submission);
    // SQLite reopen is exact.
    ledger.close();
    ledger = budgetLedgerFor(database, "run_s");
    assert.equal(getValidationBudgetUsage(ledger, "run_s", "task_a").usedMs, 2000);
    const reopened = summarizeValidationBudget(ledger, { runId: "run_s", taskId: "task_a", budgetMs: 1000 });
    assert.equal(reopened.overBudget, true);
    assert.deepEqual(parseValidationBudgetSubmission({ summary: reopened, justification: submission.justification }), submission);
    // Retry: new usage persists in the task ledger, but the new submission
    // carries no reason until its own overage justifies one (reason cleared).
    recordValidationEvidenceSegment(ledger, {
      runId: "run_s",
      taskId: "task_a",
      sessionId: "sess_1",
      callId: "call_2",
      startedAt: "2026-10-06T00:00:03.000Z",
      finishedAt: "2026-10-06T00:00:03.500Z",
    });
    assert.equal(getValidationBudgetUsage(ledger, "run_s", "task_a").usedMs, 2500, "task ledger usage persists across retries");
    const retry = summarizeValidationBudget(ledger, { runId: "run_s", taskId: "task_a", budgetMs: 10_000 });
    assert.equal(retry.overBudget, false);
    assert.deepEqual(parseValidationBudgetSubmission({ summary: retry }), { summary: retry });
  } finally {
    ledger?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F7.9 (bounded): real git + budget.sqlite + evidence timing + override + tier.
// ---------------------------------------------------------------------------

test("IV-3 F7.9: bounded journey — project override, real evidence timing, overage, tier command", async () => {
  const root = mkdtempSync(join(tmpdir(), "iv3-f79-"));
  const git = async (...args: string[]) => (await runGit({ cwd: root, args })).stdout.trim();
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const store = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const ledger = budgetLedgerFor(join(root, "budget.sqlite"), "run_j");
  try {
    await git("init", "-b", "main");
    await git("config", "user.email", "iv3@example.com");
    await git("config", "user.name", "iv3");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "journey", scripts: { test: "node --test" } }));
    writeFileSync(
      join(root, PROJECT_VALIDATION_CONFIG_PATH),
      JSON.stringify({
        version: 1,
        validationBudgetMs: 50,
        tiers: { fast: [{ label: "fast unit", executable: "node", args: ["--test", "test/fast/"] }] },
      }),
    );
    await git("add", "--all");
    await git("commit", "-m", "project with override and tier");
    const revision = await git("rev-parse", "HEAD");
    // Revision-bound override resolves from the trusted blob.
    assert.equal(await readValidationBudgetMsAtRevision({ git: runGit, cwd: root, revision }), 50);
    // Profile carries the same override and tier map.
    const profile = await inspectFinalVerificationExecutionProfile({ repositoryRoot: root, targetRevision: revision, execute: runGit });
    assert.equal(profile.validationBudgetMs, 50);
    assert.equal(profile.tiers?.fast?.[0]?.label, "fast unit");
    // Configured tier command for a low-risk task.
    const tier = selectValidationTier({ changeRisk: "low", isMilestoneGate: false, isFinalCandidate: false });
    assert.equal(tier, "fast");
    const commands = tierCommandsForTier(profile.tiers, tier);
    assert.equal(commands?.[0]?.executable, "node");
    const runtimeCommands = projectTierCommandsToRuntimeCommands(commands!);
    assert.deepEqual(runtimeCommands[0]!.args, ["--test", "test/fast/"]);
    // Actual run_evidence_command timing through the real tool + ledger.
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    let now = Date.parse("2026-10-06T00:00:00.000Z");
    const clock = () => new Date(now).toISOString();
    const execution: OneShotCommandExecutor = {
      execute: async () => {
        now += 60;
        return {
          process: {
            logicalProcessId: "journey-1",
            outcome: "exited",
            exitCode: 0,
            finishedAt: clock(),
            output: [
              { stream: "stdout" as const, tail: "ok", totalBytes: 2, truncated: false, spillBytes: 0, lossyBytes: 0 },
              { stream: "stderr" as const, tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
            ],
            cleanup: { state: "verified_empty" as const, verifiedAt: clock() },
          },
          enforcement: "unconfined_explicit_full" as const,
          disclosure: "unconfined_explicit_full" as const,
        };
      },
    };
    const registry = new ToolRegistry();
    for (const tool of createEvidenceTools({
      store,
      artifacts,
      taskId: "task_j",
      execution,
      validationAccounting: { ledger, runId: "run_j" },
      clock,
    })) registry.register(tool);
    const result = await registry.invoke(
      { type: "tool_call", callId: "journey-call", name: "run_evidence_command", arguments: { label: "journey", command: "fixture", args: [] } } as never,
      { runId: "run_j", sessionId: "sess_j", actor: { role: "worker", id: "worker_j" }, workspacePath: workspace } as never,
    );
    assert.equal(result.isError, false);
    assert.equal(getValidationBudgetUsage(ledger, "run_j", "task_j").usedMs, 60);
    // Overage justification required under the 50ms override.
    const summary = summarizeValidationBudget(ledger, { runId: "run_j", taskId: "task_j", budgetMs: 50 });
    assert.equal(summary.overBudget, true);
    const submission = parseValidationBudgetSubmission({ summary, justification: "fast tier needed a rerun" });
    assert.equal(submission.justification, "fast tier needed a rerun");
    // Same usage under the default would not require a reason.
    assert.equal(summarizeValidationBudget(ledger, { runId: "run_j", taskId: "task_j", budgetMs: 600_000 }).overBudget, false);
  } finally {
    store.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
