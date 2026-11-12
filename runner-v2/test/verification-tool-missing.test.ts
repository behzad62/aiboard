import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock } from "../src/agent-contracts.js";
import {
  BuildRuntime,
  type ArchitectActionRequest,
  type FinalVerificationCheckDriver,
} from "../src/build-runtime.js";
import { lookUpCheckTool } from "../src/check-tool-lookup.js";
import {
  parseVerificationNotRun,
  verificationCheckFailed,
  type FinalVerificationCategory,
  type FinalVerificationPlan,
} from "../src/final-verification-contracts.js";
import {
  assertFinalVerificationCheckSemantics,
  finalVerificationCheckTools,
} from "../src/final-verification-semantics.js";
import { handoffSnapshotInputFromProjection, renderHandoffSnapshot } from "../src/handoff-snapshot.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  acceptFinalVerificationProfile,
  profileForRequiredCategories,
} from "./support/final-verification-profile.js";

/**
 * VF2 (docs/plans/2026-11-13-build-verification.md): a check whose tool is
 * missing is recorded as not run with reason tool_missing, naming the
 * executable. It is never a failure, a repair task or a repair-cycle charge,
 * and only the Runner records it.
 */

const RUN_ID = "run-verification-tool-missing";
const REVISION = "a".repeat(40);
const TASK_ID = "final-verification-tool-missing";
const GENERATION_ID = "final-verification-generation-tool-missing";
const SUBMISSION_ID = `final-verification-submission:${GENERATION_ID}`;
const CATEGORIES: readonly FinalVerificationCategory[] = ["build", "tests", "runtime_smoke", "browser"];

test("VF2 lookup: a bare command is found on PATH, missing when PATH lacks it, and undecided otherwise", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-vf2-lookup-"));
  try {
    const bin = join(root, "bin dir");
    const empty = join(root, "empty dir");
    const cwd = join(root, "work dir");
    for (const dir of [bin, empty, cwd]) mkdirSync(dir, { recursive: true });
    const windows = process.platform === "win32";
    const toolFile = join(bin, windows ? "aiboard-vf2-tool.cmd" : "aiboard-vf2-tool");
    writeFileSync(toolFile, windows ? "@echo off\r\n" : "#!/bin/sh\n");
    if (!windows) chmodSync(toolFile, 0o755);
    const environment = (path: string) => ({ PATH: path, PATHEXT: ".COM;.EXE;.BAT;.CMD" });

    const found = await lookUpCheckTool("aiboard-vf2-tool", { cwd, environment: environment(bin) });
    assert.equal(found.status, "found");
    assert.equal(found.status === "found" ? found.path.toLowerCase() : "", toolFile.toLowerCase());
    assert.deepEqual(await lookUpCheckTool("aiboard-vf2-tool", { cwd, environment: environment(empty) }), { status: "missing" });
    mkdirSync(join(empty, windows ? "aiboard-vf2-dir.cmd" : "aiboard-vf2-dir"));
    assert.deepEqual(
      await lookUpCheckTool("aiboard-vf2-dir", { cwd, environment: environment(empty) }),
      { status: "missing" },
      "a directory with the tool's name is not the tool",
    );

    for (const pathCommand of ["./aiboard-vf2-tool", "bin/aiboard-vf2-tool", toolFile]) {
      assert.equal((await lookUpCheckTool(pathCommand, { cwd, environment: environment(empty) })).status, "unknown",
        `${pathCommand} names a path; its launch failure stays the project's failure`);
    }
    // With no PATH to search, absence proves nothing.
    assert.equal((await lookUpCheckTool("aiboard-vf2-tool", { cwd, environment: {} })).status, "unknown");
    assert.equal((await lookUpCheckTool("aiboard-vf2-tool", { cwd, environment: { PATH: "  " } })).status, "unknown");
    assert.equal((await lookUpCheckTool("", { cwd, environment: environment(bin) })).status, "unknown");

    if (windows) {
      // The Windows launcher probes the working directory first.
      writeFileSync(join(cwd, "aiboard-vf2-local.cmd"), "@echo off\r\n");
      assert.equal((await lookUpCheckTool("aiboard-vf2-local", { cwd, environment: environment(empty) })).status, "found");
    } else {
      const plain = join(bin, "aiboard-vf2-plain");
      writeFileSync(plain, "#!/bin/sh\n");
      chmodSync(plain, 0o644);
      assert.equal((await lookUpCheckTool("aiboard-vf2-plain", { cwd, environment: environment(bin) })).status, "unknown",
        "a file that exists but is not executable is launched, and its failure stays a failure");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VF2 contract: a not-run record is exactly a Runner tool_missing record and a not-run check is no failure", () => {
  const record = { reason: "tool_missing", tool: "npm", detail: "npm was not found on PATH, so the check was not run." };
  assert.deepEqual(parseVerificationNotRun(record, "Check"), record);
  for (const invalid of [
    { ...record, reason: "launch_failed" },
    { ...record, tool: "" },
    { ...record, extra: true },
    { reason: "tool_missing", tool: "npm" },
    "tool_missing",
  ]) {
    assert.throws(() => parseVerificationNotRun(invalid, "Check"), /not-run record is invalid/);
  }
  assert.equal(verificationCheckFailed({ green: false }), true);
  assert.equal(verificationCheckFailed({ green: false, notRun: record }), false);
  assert.equal(verificationCheckFailed({ green: true }), false);
});

test("VF2 semantics: a not-run check carries nothing and names a tool its specification launches", () => {
  const profile = {
    ...profileForRequiredCategories(REVISION, CATEGORIES),
    provisioning: {
      manager: "pnpm" as const,
      lockfile: "pnpm-lock.yaml",
      command: { label: "install dependencies", executable: "pnpm", args: ["install"] },
    },
  };
  assert.deepEqual(finalVerificationCheckTools(profile, "build").sort(), ["fixture", "pnpm"]);
  assert.deepEqual(finalVerificationCheckTools(profile, "browser").sort(), ["browser", "pnpm"]);
  const check = (category: FinalVerificationCategory, overrides: Record<string, unknown> = {}) => ({
    workspacePath: "C:/verification",
    targetRevision: REVISION,
    profile,
    check: { ...notRunCheck(category), ...overrides },
  });
  for (const category of CATEGORIES) assert.doesNotThrow(() => assertFinalVerificationCheckSemantics(check(category)));
  assert.doesNotThrow(() => assertFinalVerificationCheckSemantics(check("tests", { notRun: { ...notRunRecord("pnpm") } })));
  assert.throws(() => assertFinalVerificationCheckSemantics(check("build", { notRun: notRunRecord("make") })), /does not use/);
  assert.throws(() => assertFinalVerificationCheckSemantics(check("build", { notRun: notRunRecord("browser") })), /does not use/);
  assert.throws(() => assertFinalVerificationCheckSemantics(check("build", { green: true })), /cannot carry/);
  assert.throws(() => assertFinalVerificationCheckSemantics(check("build", { issues: ["build failed"] })), /cannot carry/);
  assert.throws(() => assertFinalVerificationCheckSemantics(check("build", { evidenceIds: ["evidence-1"] })), /cannot carry/);
  assert.throws(() => assertFinalVerificationCheckSemantics(check("build", {
    status: "not_applicable",
    rationale: "No build.",
    repositoryInspection: { paths: ["package.json"], summary: "No build." },
  })), /cannot carry/);
  assert.throws(() => assertFinalVerificationCheckSemantics(check("build", { notRun: { ...notRunRecord("fixture"), reason: "launch_failed" } })), /not-run record is invalid/);
});

test("VF2: a Build whose every check's tool is missing reaches its handoff with the not-run checks in the projection", async () => {
  const fixture = createFixture();
  const calls: FinalVerificationCategory[] = [];
  const reviewErrors: Array<string | undefined> = [];
  let architectReasons: string[] = [];
  try {
    // Only the Runner records a check as not run, and only for a tool its specification uses.
    assert.throws(() => fixture.store.append(checkCompleted("build", "architect-forged", { role: "architect", id: "architect" })), /runner|actor|only/i);
    assert.throws(() => fixture.store.append(checkCompleted("build", "wrong-tool", { role: "runner", id: "runtime" }, notRunRecord("make"))), /does not use/);

    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store: fixture.store,
      evidenceStore: fixture.evidence,
      finalVerificationDriver: notRunDriver(calls),
      finalVerificationCleanupDriver: { cleanup: async () => ({}) },
      workerDriver: { run: async () => ({ type: "failed" as const, reason: "a missing tool needs no worker" }) },
      architectDriver: {
        run: async (request: ArchitectActionRequest) => {
          architectReasons = [...architectReasons, request.reason.type];
          if (request.reason.type === "final_verification_review_required") {
            // A missing tool is not repaired by a task.
            const refused = await request.tools.invoke(reviewCall("review-repair", "repair_required"), request.context);
            reviewErrors.push(refused.error?.code);
            assert.match(refused.error?.message ?? "", /was not run because fixture is missing/);
            // The kernel refuses it too, whoever appends it.
            assert.throws(() => fixture.store.append({
              runId: RUN_ID,
              type: "final_verification.review_decided",
              occurredAt: "2026-11-13T00:00:30.000Z",
              actor: { role: "architect", id: "architect" },
              idempotencyKey: "raw-repair-of-not-run",
              payload: { ...reviewArguments("repair_required"), reviewId: `final-verification-review:${GENERATION_ID}` },
            }), /was not run because fixture is missing; it needs no repair/);
            const approved = await request.tools.invoke(reviewCall("review-approve", "approved"), request.context);
            assert.equal(approved.isError, false, approved.error?.message ?? "review failed");
            return;
          }
          if (request.reason.type === "completion_decision_required") {
            const completed = await request.tools.invoke({
              type: "tool_call",
              callId: "complete",
              name: "complete_run",
              arguments: { summary: "Nothing could be verified: every check's tool is missing on this computer." },
            }, request.context);
            assert.equal(completed.isError, false, completed.error?.message ?? "completion failed");
            return;
          }
          throw new Error(`Unexpected Architect reason ${request.reason.type}.`);
        },
      },
      integrationDriver: { integrate: async () => ({ status: "integrated" as const, integrationRevision: REVISION }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/never",
    });
    const actions: string[] = [];
    for (let step = 0; step < 20 && runtime.projection().projectHandoff?.status !== "requested"; step += 1) {
      const result = await runtime.step();
      actions.push(result.action ?? result.status);
    }
    assert.deepEqual(calls, [...CATEGORIES]);
    assert.deepEqual(actions.slice(0, 4), Array(4).fill("final_verification_check_not_run"));
    assert.deepEqual(reviewErrors, ["final_verification_check_not_run"]);
    assert.deepEqual(architectReasons, ["final_verification_review_required", "completion_decision_required"]);

    const projection = runtime.projection();
    assert.equal(projection.projectHandoff?.status, "requested", actions.join(","));
    const events = fixture.store.readRun(RUN_ID);
    assert.equal(events.some((event) => event.type === "final_verification.failure_reported"), false, "a missing tool is no failure");
    assert.equal(Object.keys(projection.repairIssues ?? {}).length, 0, "and opens no repair issue");
    assert.deepEqual(Object.keys(projection.tasks).sort(), ["final-verification-tool-missing", "implementation-one"], "and plans no repair task");
    assert.equal(projection.repairCycles?.used, 0, "and charges no repair cycle");

    const current = projection.finalVerification!.current!;
    assert.deepEqual(current.completedChecks!.map((check) => [check.category, check.green, check.notRun?.tool]), [
      ["build", false, "fixture"],
      ["tests", false, "fixture"],
      ["runtime_smoke", false, "fixture"],
      ["browser", false, "browser"],
    ]);
    assert.equal(current.failure, undefined);
    assert.equal(current.submissionResult?.green, true, "the submission has no failure");
    assert.deepEqual(current.submissionResult!.checks.map((check) => [check.category, check.green, check.notRun?.reason]), [
      ["build", false, "tool_missing"],
      ["tests", false, "tool_missing"],
      ["runtime_smoke", false, "tool_missing"],
      ["browser", false, "tool_missing"],
    ]);
    assert.equal(current.review?.status, "approved");

    // VF8 lists them from the handoff snapshot.
    const snapshot = renderHandoffSnapshot(handoffSnapshotInputFromProjection(projection));
    assert.match(snapshot, /not run \(tool missing: fixture\)/);
    assert.match(snapshot, /not run \(tool missing: browser\)/);

    // Replay and a reopened store give the same projection.
    fixture.store.close();
    fixture.store = openStore(fixture.database, fixture.evidence);
    assert.deepEqual(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)), projection);
  } finally {
    fixture.close();
  }
});

test("VF2: a not-run check next to a real failure still reports and repairs only the failure", async () => {
  const fixture = createFixture();
  try {
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store: fixture.store,
      evidenceStore: fixture.evidence,
      finalVerificationDriver: {
        executeCheck: async (input) => {
          if (input.category !== "tests") return notRunExecution(input.category);
          const execution = notRunExecution("tests");
          const { notRun: _notRun, ...failed } = execution.check;
          return { ...execution, check: { ...failed, green: false, issues: ["tests exited with status 1."] } };
        },
      },
      finalVerificationCleanupDriver: { cleanup: async () => ({}) },
      workerDriver: { run: async () => ({ type: "failed" as const, reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: { integrate: async () => ({ status: "integrated" as const, integrationRevision: REVISION }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/never",
    });
    assert.equal((await runtime.step()).action, "final_verification_check_not_run");
    assert.equal((await runtime.step()).action, "final_verification_check_non_green");
    assert.equal((await runtime.step()).action, "final_verification_failure_reported");
    const failure = runtime.projection().finalVerification?.current?.failure;
    assert.deepEqual(failure?.failedCategories, ["tests"], "the not-run build check is not among the failures");
  } finally {
    fixture.close();
  }
});

function notRunRecord(tool: string) {
  return { reason: "tool_missing" as const, tool, detail: `${tool} was not found on PATH, so the check was not run.` };
}

function notRunCheck(category: FinalVerificationCategory) {
  return {
    category,
    status: "required" as const,
    green: false,
    evidenceIds: [] as string[],
    facts: [],
    issues: [] as string[],
    notRun: notRunRecord(category === "browser" ? "browser" : "fixture"),
  };
}

function notRunExecution(category: FinalVerificationCategory) {
  return {
    workspacePath: "C:/verification-workspace",
    startedAt: "2026-11-13T00:00:04.000Z",
    finishedAt: "2026-11-13T00:00:04.500Z",
    check: notRunCheck(category),
  };
}

function notRunDriver(calls: FinalVerificationCategory[]): FinalVerificationCheckDriver {
  return {
    executeCheck: async (input) => {
      calls.push(input.category);
      assert.equal(input.generationId, GENERATION_ID);
      return notRunExecution(input.category);
    },
  };
}

function checkCompleted(
  category: FinalVerificationCategory,
  key: string,
  actor: { role: "runner" | "architect"; id: string },
  notRun = notRunRecord(category === "browser" ? "browser" : "fixture"),
) {
  return {
    runId: RUN_ID,
    type: "final_verification.check_completed" as const,
    occurredAt: "2026-11-13T00:00:04.000Z",
    actor,
    idempotencyKey: `forged-check:${key}`,
    payload: {
      taskId: TASK_ID,
      generationId: GENERATION_ID,
      targetRevision: REVISION,
      attempt: 1,
      ...notRunExecution(category),
      result: { ...notRunCheck(category), notRun },
    },
  };
}

function reviewArguments(verdict: "approved" | "repair_required") {
  return {
    taskId: TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    submissionId: SUBMISSION_ID,
    attempt: 1,
    decision: verdict,
    summary: verdict === "approved"
      ? "No check could run because its tool is missing; nothing was verified."
      : "Repair the build.",
    architectRisk: "low" as const,
    architectRiskRationale: "No additional semantic risk beyond the kernel-observed paths and effects.",
    categoryReviews: CATEGORIES.map((category) => ({
      category,
      verdict: category === "build" ? verdict : "approved" as const,
      rationale: `The ${category} check was not run because its tool is missing, so it is not verified.`,
      evidenceIds: [] as string[],
    })),
  };
}

function reviewCall(callId: string, verdict: "approved" | "repair_required"): ToolCallBlock {
  return { type: "tool_call", callId, name: "review_final_verification", arguments: reviewArguments(verdict) };
}

interface Fixture {
  root: string;
  database: string;
  evidence: SqliteEvidenceStore;
  store: SqliteSchedulerStore;
  close(): void;
}

function openStore(database: string, evidence: SqliteEvidenceStore): SqliteSchedulerStore {
  return new SqliteSchedulerStore(database, {
    evidenceStore: evidence,
    validateCleanupReceipt: () => undefined,
    validateExecutionProfile: acceptFinalVerificationProfile,
  });
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 vf2 tool missing "));
  const database = join(root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const fixture: Fixture = {
    root,
    database,
    evidence,
    store: openStore(database, evidence),
    close() {
      this.store.close();
      this.evidence.close();
      rmSync(this.root, { recursive: true, force: true });
    },
  };
  const append = (type: string, key: string, actor: { role: "runner" | "architect"; id: string }, payload: Record<string, unknown>, second: number) =>
    fixture.store.append({
      runId: RUN_ID,
      type: type as never,
      occurredAt: `2026-11-13T00:00:0${second}.000Z`,
      actor,
      idempotencyKey: key,
      payload,
    });
  append("run.initialized", "run-initialized", { role: "runner", id: "runner-test" }, {}, 0);
  append("run.policy_configured", "policy", { role: "runner", id: "runtime" }, { runPolicy: "finish" }, 0);
  append("repair.policy_configured", "repair-policy", { role: "runner", id: "runtime" }, { repairPlanLimit: 2, explicit: true }, 0);
  append("plan.created", "plan", { role: "architect", id: "architect" }, {
    revision: 1,
    tasks: [{
      id: "implementation-one",
      objective: "Implement the feature",
      dependencies: [],
      status: "integrated",
      requiredCapabilities: ["code"],
      acceptanceCriteria: [{ id: "implemented", text: "The feature is implemented." }],
      acceptanceCriteriaVersion: 1,
      attempt: 1,
    }],
  }, 1);
  append("integration.revision_advanced", "integration", { role: "runner", id: "integration-manager" }, { integrationRevision: REVISION }, 2);
  append("final_verification.generation_created", "generation", { role: "runner", id: "build-runtime" }, {
    taskId: TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    planVersion: 1,
    plan: allRequiredPlan(),
    executionProfile: profileForRequiredCategories(REVISION, CATEGORIES),
  }, 3);
  return fixture;
}

function allRequiredPlan(): FinalVerificationPlan {
  return { checks: CATEGORIES.map((category) => ({ category, status: "required" as const })) };
}
