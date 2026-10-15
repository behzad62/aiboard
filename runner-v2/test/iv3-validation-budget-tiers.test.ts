import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BudgetExceededError } from "../src/budget-ledger.js";
import {
  DEFAULT_VALIDATION_BUDGET_MS,
  MAX_VALIDATION_BUDGET_MS,
  PROJECT_VALIDATION_CONFIG_PATH,
  cloneProjectValidationConfig,
  parseProjectValidationConfig,
  projectValidationConfigDigest,
  selectValidationTier,
  tierCommandsForTier,
  validationBudgetMsForConfig,
} from "../src/project-validation-config.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";
import {
  cloneValidationBudgetSubmission,
  getValidationBudgetUsage,
  isRunValidationBudgetScope,
  parseValidationBudgetJustification,
  parseValidationBudgetSubmission,
  recordValidationBoundarySegment,
  recordValidationEvidenceSegment,
  summarizeValidationBudget,
  validationBoundarySegmentId,
  validationBudgetScopeId,
  validationEvidenceSegmentId,
} from "../src/validation-budget.js";

/**
 * IV-3 (CD-23) focused collateral: the project validation config carrier
 * (`aiboard-validation.json`; budget override + tier map), the pure tier
 * selector, the advisory budget record rules, and the per-task ledger
 * accounting (accumulate, idempotent, reopen-exact, run budget unchanged).
 */

test("IV-3: budget defaults to 600000; bounded overrides accepted, malformed refused", () => {
  assert.equal(PROJECT_VALIDATION_CONFIG_PATH, "aiboard-validation.json");
  assert.equal(DEFAULT_VALIDATION_BUDGET_MS, 600_000);
  assert.equal(validationBudgetMsForConfig(undefined), 600_000);
  assert.equal(
    validationBudgetMsForConfig(parseProjectValidationConfig({ version: 1 })),
    600_000,
  );
  assert.equal(
    validationBudgetMsForConfig(
      parseProjectValidationConfig({ version: 1, validationBudgetMs: 1_000 }),
    ),
    1_000,
  );
  assert.equal(
    validationBudgetMsForConfig(
      parseProjectValidationConfig({ version: 1, validationBudgetMs: 0 }),
    ),
    0,
  );
  for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "600000", null, Number.NaN]) {
    assert.throws(
      () => parseProjectValidationConfig({ version: 1, validationBudgetMs: bad }),
      /validationBudgetMs/,
    );
  }
  assert.throws(
    () =>
      parseProjectValidationConfig({
        version: 1,
        validationBudgetMs: MAX_VALIDATION_BUDGET_MS + 1,
      }),
    /validationBudgetMs/,
  );
  assert.throws(() => parseProjectValidationConfig({ version: 2 }), /version/);
  assert.throws(
    () => parseProjectValidationConfig({ version: 1, unknown: true }),
    /unknown field/,
  );
});

test("IV-3: tier map validates strictly; missing map keeps no profile field", () => {
  const parsed = parseProjectValidationConfig({
    version: 1,
    tiers: {
      fast: [{ label: "fast unit", executable: "node", args: ["--test", "test/fast/"] }],
      release: [
        { label: "full", executable: "npm", args: ["run", "test"], timeoutMs: 600_000 },
      ],
    },
  });
  assert.deepEqual(Object.keys(parsed.tiers ?? {}).sort(), ["fast", "release"]);
  const missing = parseProjectValidationConfig({ version: 1 });
  assert.equal(missing.tiers, undefined);
  const empty = parseProjectValidationConfig({ version: 1, tiers: {} });
  assert.equal(empty.tiers, undefined);
  assert.throws(
    () => parseProjectValidationConfig({ version: 1, tiers: { turbo: [] } }),
    /Unknown validation tier/,
  );
  assert.throws(
    () => parseProjectValidationConfig({ version: 1, tiers: { fast: [] } }),
    /1 to 8 commands/,
  );
  assert.throws(
    () =>
      parseProjectValidationConfig({
        version: 1,
        tiers: { fast: [{ label: "x", executable: "sh", args: [], shell: "npm test" }] },
      }),
    /unknown field/,
  );
  assert.throws(
    () =>
      parseProjectValidationConfig({
        version: 1,
        tiers: { fast: [{ label: "", executable: "node", args: [] }] },
      }),
    /label/,
  );
  const clone = cloneProjectValidationConfig(parsed);
  assert.deepEqual(clone, parsed);
  assert.notEqual(clone.tiers?.fast?.[0]?.args, parsed.tiers?.fast?.[0]?.args);
  assert.equal(projectValidationConfigDigest(clone), projectValidationConfigDigest(parsed));
});

test("IV-3: one pure tier selector; absent tier falls back", () => {
  assert.equal(
    selectValidationTier({ changeRisk: "low", isMilestoneGate: false, isFinalCandidate: false }),
    "fast",
  );
  assert.equal(
    selectValidationTier({ changeRisk: "medium", isMilestoneGate: false, isFinalCandidate: false }),
    "component",
  );
  assert.equal(
    selectValidationTier({ changeRisk: "high", isMilestoneGate: false, isFinalCandidate: false }),
    "integration",
  );
  assert.equal(
    selectValidationTier({ changeRisk: "low", isMilestoneGate: true, isFinalCandidate: false }),
    "slow",
  );
  assert.equal(
    selectValidationTier({ changeRisk: "high", isMilestoneGate: true, isFinalCandidate: true }),
    "release",
  );
  const tiers = parseProjectValidationConfig({
    version: 1,
    tiers: { fast: [{ label: "f", executable: "node", args: ["--test"] }] },
  }).tiers;
  assert.equal(tierCommandsForTier(tiers, "fast")?.length, 1);
  assert.equal(tierCommandsForTier(tiers, "release"), undefined);
  assert.equal(tierCommandsForTier(undefined, "fast"), undefined);
});

test("IV-3: justification required exactly when over budget", () => {
  assert.equal(parseValidationBudgetJustification("  ran the slow suite  "), "ran the slow suite");
  assert.throws(() => parseValidationBudgetJustification("   "), /non-empty/);
  assert.throws(
    () => parseValidationBudgetJustification("x".repeat(2001)),
    /at most 2000/,
  );
  const under = {
    summary: {
      budgetMs: 600_000,
      usedMs: 10,
      overBudget: false,
      scopeId: validationBudgetScopeId("run_1", "task_a"),
      segments: [],
    },
  };
  assert.deepEqual(parseValidationBudgetSubmission(under), under);
  assert.throws(
    () => parseValidationBudgetSubmission({ ...under, justification: "noise" }),
    /only when over budget/,
  );
  const over = {
    summary: { ...under.summary, usedMs: 700_000, overBudget: true },
    justification: "integration suite needed a second full pass",
  };
  assert.deepEqual(parseValidationBudgetSubmission(over), over);
  assert.throws(
    () => parseValidationBudgetSubmission({ summary: over.summary }),
    /requires a justification/,
  );
  assert.throws(
    () =>
      parseValidationBudgetSubmission({
        summary: { ...under.summary, overBudget: true },
      }),
    /disagrees/,
  );
  const clone = cloneValidationBudgetSubmission(over);
  assert.deepEqual(clone, over);
  assert.notEqual(clone.summary, over.summary);
});

test("IV-3: deterministic run/task scope and segment ids", () => {
  assert.equal(validationBudgetScopeId("run_1", "task_a"), "validation-budget:run_1:task_a");
  assert.ok(isRunValidationBudgetScope("validation-budget:run_1:task_a", "run_1"));
  assert.ok(!isRunValidationBudgetScope("run_1", "run_1"));
  assert.equal(
    validationEvidenceSegmentId("sess_1", "call_1"),
    "validation-evidence:sess_1:call_1",
  );
  assert.equal(
    validationBoundarySegmentId("boundary_1", 2),
    "validation-boundary:boundary_1:2",
  );
});

test("IV-3: evidence plus boundary accumulate per task; retries add zero; reopen exact", () => {
  const dir = mkdtempSync(join(tmpdir(), "iv3-budget-"));
  const database = join(dir, "budget.sqlite");
  const limitsFor = (scopeId: string) => {
    if (scopeId === "run_iv3") return { maxToolCalls: 1 };
    if (isRunValidationBudgetScope(scopeId, "run_iv3")) return {};
    throw new Error(`Unknown budget scope ${scopeId}.`);
  };
  let ledger: SqliteBudgetLedger | undefined;
  try {
    ledger = new SqliteBudgetLedger(database, { limitsFor });
    recordValidationEvidenceSegment(ledger, {
      runId: "run_iv3",
      taskId: "task_a",
      sessionId: "sess_1",
      callId: "call_1",
      startedAt: "2026-10-06T00:00:00.000Z",
      finishedAt: "2026-10-06T00:00:01.000Z",
    });
    recordValidationEvidenceSegment(ledger, {
      runId: "run_iv3",
      taskId: "task_a",
      sessionId: "sess_1",
      callId: "call_2",
      startedAt: "2026-10-06T00:00:02.000Z",
      finishedAt: "2026-10-06T00:00:04.000Z",
    });
    assert.equal(getValidationBudgetUsage(ledger, "run_iv3", "task_a").usedMs, 3_000);
    // Idempotent retry of the same call with different wall time adds zero.
    recordValidationEvidenceSegment(ledger, {
      runId: "run_iv3",
      taskId: "task_a",
      sessionId: "sess_1",
      callId: "call_1",
      startedAt: "2026-10-06T00:00:10.000Z",
      finishedAt: "2026-10-06T00:00:20.000Z",
    });
    assert.equal(getValidationBudgetUsage(ledger, "run_iv3", "task_a").usedMs, 3_000);
    recordValidationBoundarySegment(ledger, {
      runId: "run_iv3",
      taskId: "task_a",
      boundaryId: "boundary_1",
      attempt: 1,
      startedAt: "2026-10-06T00:01:00.000Z",
      finishedAt: "2026-10-06T00:01:00.500Z",
    });
    const usage = getValidationBudgetUsage(ledger, "run_iv3", "task_a");
    assert.equal(usage.usedMs, 3_500);
    assert.deepEqual(
      usage.segments.map((segment) => segment.kind).sort(),
      ["boundary", "evidence", "evidence"],
    );
    assert.equal(
      summarizeValidationBudget(ledger, {
        runId: "run_iv3",
        taskId: "task_a",
        budgetMs: 600_000,
      }).overBudget,
      false,
    );
    assert.equal(
      summarizeValidationBudget(ledger, {
        runId: "run_iv3",
        taskId: "task_a",
        budgetMs: 1_000,
      }).overBudget,
      true,
    );
    assert.equal(getValidationBudgetUsage(ledger, "run_iv3", "task_b").usedMs, 0);
    // The hard run budget is unchanged: tool-call exhaustion still throws,
    // while unbounded advisory validation time never routes through it.
    ledger.reserve({
      scopeId: "run_iv3",
      reservationId: "tool_1",
      kind: "tool",
      estimate: {},
      occurredAt: "2026-10-06T00:02:00.000Z",
      idempotencyKey: "reserve:tool_1",
    });
    assert.throws(
      () =>
        ledger!.reserve({
          scopeId: "run_iv3",
          reservationId: "tool_2",
          kind: "tool",
          estimate: {},
          occurredAt: "2026-10-06T00:02:01.000Z",
          idempotencyKey: "reserve:tool_2",
        }),
      (error: unknown) => error instanceof BudgetExceededError,
    );
    ledger.close();
    ledger = new SqliteBudgetLedger(database, { limitsFor });
    assert.equal(getValidationBudgetUsage(ledger, "run_iv3", "task_a").usedMs, 3_500);
  } finally {
    ledger?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IV-3: interrupted validation timing contributes zero, never invented time", () => {
  const dir = mkdtempSync(join(tmpdir(), "iv3-budget-open-"));
  const database = join(dir, "budget.sqlite");
  const ledger = new SqliteBudgetLedger(database, {
    limitsFor: (scopeId) =>
      isRunValidationBudgetScope(scopeId, "run_iv3") ? {} : { maxToolCalls: 1 },
  });
  try {
    const scopeId = validationBudgetScopeId("run_iv3", "task_c");
    ledger.startActive({
      scopeId,
      segmentId: validationEvidenceSegmentId("sess_x", "call_x"),
      reserveMs: 0,
      occurredAt: "2026-10-06T00:00:00.000Z",
      idempotencyKey: "test-open-start",
    });
    assert.equal(getValidationBudgetUsage(ledger, "run_iv3", "task_c").usedMs, 0);
    ledger.stopActive({
      scopeId,
      segmentId: validationEvidenceSegmentId("sess_x", "call_x"),
      occurredAt: "2026-10-06T00:00:00.000Z",
      idempotencyKey: "test-open-stop",
    });
    assert.equal(getValidationBudgetUsage(ledger, "run_iv3", "task_c").usedMs, 0);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
