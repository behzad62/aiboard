import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import {
  createDeliveryBoundaryDriver,
  createDeliveryWorkspaceSlot,
  runDeliveryCategory,
} from "../src/delivery-execution.js";
import { inspectFinalVerificationExecutionProfile } from "../src/final-verification-profile.js";
import type { GitRunner } from "../src/git-repository.js";
import type { OneShotCommandExecutor } from "../src/one-shot-command-executor.js";
import {
  PROJECT_VALIDATION_CONFIG_PATH,
  readValidationBudgetMsAtRevision,
} from "../src/project-validation-config.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import {
  getValidationBudgetUsage,
  isRunValidationBudgetScope,
} from "../src/validation-budget.js";
import { VerificationWorkspaceManager } from "../src/verification-workspace.js";
import { runGit } from "./support/git-fixture.js";

/**
 * IV-3 independent-review repair 2: focused production integration for
 * R2-F1 (explicit full outranks tiers), R2-F2 (boundary duration covers
 * the whole attempt), and R2-F3 (revision-bound budget resolver fails
 * closed). Hermetic temp state; no models, no network.
 */

function stubExecution(records?: Array<{ executable: string; args: string[] }>): OneShotCommandExecutor {
  return {
    execute: async (request) => {
      records?.push({ executable: request.executable, args: [...request.arguments] });
      const finishedAt = new Date().toISOString();
      const stream = (name: "stdout" | "stderr") => ({
        stream: name,
        tail: "",
        totalBytes: 0,
        truncated: false,
        spillBytes: 0,
        lossyBytes: 0,
      });
      return {
        process: {
          logicalProcessId: "iv3-r2-stub",
          outcome: "exited",
          exitCode: 0,
          finishedAt,
          output: [stream("stdout"), stream("stderr")],
          cleanup: { state: "verified_empty", verifiedAt: finishedAt },
        },
        enforcement: "unconfined_explicit_full",
        disclosure: "unconfined_explicit_full",
      };
    },
  };
}

async function initR2Repo(project: string, files: Record<string, string>): Promise<string> {
  mkdirSync(project, { recursive: true });
  const git = async (...args: string[]) => (await runGit({ cwd: project, args })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.email", "iv3@example.com");
  await git("config", "user.name", "iv3");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  }
  await git("add", "--all");
  await git("commit", "-m", "r2 fixture");
  return git("rev-parse", "HEAD");
}

function r2BoundarySetup(project: string, state: string, runId: string, records?: Array<{ executable: string; args: string[] }>): {
  artifacts: ArtifactStore;
  evidenceStore: SqliteEvidenceStore;
  slot: ReturnType<typeof createDeliveryWorkspaceSlot>;
  execution: OneShotCommandExecutor;
} {
  mkdirSync(state, { recursive: true });
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const evidenceStore = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const slot = createDeliveryWorkspaceSlot(
    (targetRevision?: string) =>
      new VerificationWorkspaceManager({
        execute: runGit,
        repositoryRoot: project,
        stateDirectory: state,
        runId,
        kind: "independent-verifier",
        workspaceSuffix: "delivery-boundary",
        ...(targetRevision ? { targetRevision } : {}),
      }),
  );
  return { artifacts, evidenceStore, slot, execution: stubExecution(records) };
}

// ---------------------------------------------------------------------------
// R2-F1: explicit forceFullSuite outranks ordinary tiers; milestone slow or
// full fallback; no map keeps IV-2 behavior.
// ---------------------------------------------------------------------------

test("IV-3 R2-F1: medium/component runs tier; explicit full runs detected full; milestone slow or full", async () => {
  const root = mkdtempSync(join(tmpdir(), "iv3-r2f1-"));
  try {
    const project = join(root, "project");
    const revision = await initR2Repo(project, {
      "package.json": JSON.stringify({ name: "r2f1", scripts: { test: "node --test" } }),
      "src/a.mjs": "export const a = 1;\n",
      "test/a.test.mjs": 'import test from "node:test";\ntest("a", () => {});\n',
      [PROJECT_VALIDATION_CONFIG_PATH]: JSON.stringify({
        version: 1,
        tiers: {
          component: [{ label: "component tier", executable: "node", args: ["--test", "test/component/"] }],
          slow: [{ label: "slow tier", executable: "node", args: ["--test", "test/slow/"] }],
        },
      }),
    });
    const runId = "run_r2f1";
    const records: Array<{ executable: string; args: string[] }> = [];
    const { artifacts, evidenceStore, slot, execution } = r2BoundarySetup(project, join(root, "state"), runId, records);
    try {
      const driver = createDeliveryBoundaryDriver({
        runId,
        git: runGit,
        artifacts,
        evidenceStore,
        execution,
        boundaryWorkspace: slot,
        changedFilesFor: async () => ["src/a.mjs"],
      });
      // Medium risk + configured component tier => validation_tier component.
      records.length = 0;
      const tiered = await driver.check({
        runId,
        taskId: "task_a",
        boundaryId: "boundary:task_a:1",
        attempt: 1,
        integrationRevision: revision,
        validationTierInput: { changeRisk: "medium", isMilestoneGate: false },
      });
      assert.equal(tiered.executedScope, "validation_tier");
      assert.equal(tiered.validationTier, "component");
      assert.ok(records.some((call) => call.args.includes("test/component/")), JSON.stringify(records));
      // Explicit full + configured component tier => detected full, no tier.
      records.length = 0;
      const forced = await driver.check({
        runId,
        taskId: "task_a",
        boundaryId: "boundary:task_a:2",
        attempt: 1,
        integrationRevision: revision,
        forceFullSuite: true,
        validationTierInput: { changeRisk: "medium", isMilestoneGate: false },
      });
      assert.equal(forced.executedScope, "full_test_script");
      assert.equal(forced.validationTier, undefined);
      assert.ok(!records.some((call) => call.args.includes("test/component/")), JSON.stringify(records));
      assert.ok(records.some((call) => call.args.includes("run") && call.args.includes("test")), JSON.stringify(records));
      // Milestone + configured slow tier => validation_tier slow.
      records.length = 0;
      const milestone = await driver.check({
        runId,
        taskId: "task_a",
        boundaryId: "boundary:task_a:3",
        attempt: 1,
        integrationRevision: revision,
        validationTierInput: { changeRisk: "low", isMilestoneGate: true },
      });
      assert.equal(milestone.executedScope, "validation_tier");
      assert.equal(milestone.validationTier, "slow");
      assert.ok(records.some((call) => call.args.includes("test/slow/")), JSON.stringify(records));
      // Explicit full outranks even the milestone slow tier.
      records.length = 0;
      const explicitMilestone = await driver.check({
        runId,
        taskId: "task_a",
        boundaryId: "boundary:task_a:4",
        attempt: 1,
        integrationRevision: revision,
        forceFullSuite: true,
        validationTierInput: { changeRisk: "low", isMilestoneGate: true },
      });
      assert.equal(explicitMilestone.executedScope, "full_test_script");
      assert.equal(explicitMilestone.validationTier, undefined);
      assert.ok(!records.some((call) => call.args.includes("test/slow/")), JSON.stringify(records));
    } finally {
      await slot.cleanup().catch(() => undefined);
      evidenceStore.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IV-3 R2-F1: milestone without slow falls back to full; no map keeps IV-2 fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "iv3-r2f1-fallback-"));
  try {
    // Tiers without slow: milestone must run the detected full script (IV-2).
    const noSlow = join(root, "no-slow");
    const noSlowRevision = await initR2Repo(noSlow, {
      "package.json": JSON.stringify({ name: "r2f1noslow", scripts: { test: "node --test" } }),
      "src/a.mjs": "export const a = 1;\n",
      "test/a.test.mjs": 'import test from "node:test";\ntest("a", () => {});\n',
      [PROJECT_VALIDATION_CONFIG_PATH]: JSON.stringify({
        version: 1,
        tiers: { component: [{ label: "component tier", executable: "node", args: ["--test", "test/component/"] }] },
      }),
    });
    const runId = "run_r2f1fb";
    const records: Array<{ executable: string; args: string[] }> = [];
    const setup = r2BoundarySetup(noSlow, join(root, "state-no-slow"), runId, records);
    try {
      const driver = createDeliveryBoundaryDriver({
        runId,
        git: runGit,
        artifacts: setup.artifacts,
        evidenceStore: setup.evidenceStore,
        execution: setup.execution,
        boundaryWorkspace: setup.slot,
        changedFilesFor: async () => ["src/a.mjs"],
      });
      const milestone = await driver.check({
        runId,
        taskId: "task_a",
        boundaryId: "boundary:task_a:1",
        attempt: 1,
        integrationRevision: noSlowRevision,
        validationTierInput: { changeRisk: "low", isMilestoneGate: true },
      });
      assert.equal(milestone.executedScope, "full_test_script");
      assert.equal(milestone.validationTier, undefined);
    } finally {
      await setup.slot.cleanup().catch(() => undefined);
      setup.evidenceStore.close();
    }
    // No tier map: ordinary and milestone inputs never mint a tier scope.
    const bare = join(root, "bare");
    const bareRevision = await initR2Repo(bare, {
      "package.json": JSON.stringify({ name: "r2f1bare", scripts: { test: "node --test" } }),
      "src/a.mjs": "export const a = 1;\n",
      "test/a.test.mjs": 'import test from "node:test";\ntest("a", () => {});\n',
    });
    const bareSetup = r2BoundarySetup(bare, join(root, "state-bare"), runId, records);
    try {
      const driver = createDeliveryBoundaryDriver({
        runId,
        git: runGit,
        artifacts: bareSetup.artifacts,
        evidenceStore: bareSetup.evidenceStore,
        execution: bareSetup.execution,
        boundaryWorkspace: bareSetup.slot,
        changedFilesFor: async () => ["src/a.mjs"],
      });
      const ordinary = await driver.check({
        runId,
        taskId: "task_b",
        boundaryId: "boundary:task_b:1",
        attempt: 1,
        integrationRevision: bareRevision,
        validationTierInput: { changeRisk: "medium", isMilestoneGate: false },
      });
      assert.ok(ordinary.executedScope === "full_test_script" || ordinary.executedScope === "selected", ordinary.executedScope);
      assert.equal(ordinary.validationTier, undefined);
      const milestoneBare = await driver.check({
        runId,
        taskId: "task_b",
        boundaryId: "boundary:task_b:2",
        attempt: 1,
        integrationRevision: bareRevision,
        validationTierInput: { changeRisk: "low", isMilestoneGate: true },
      });
      assert.equal(milestoneBare.executedScope, "full_test_script");
      assert.equal(milestoneBare.validationTier, undefined);
    } finally {
      await bareSetup.slot.cleanup().catch(() => undefined);
      bareSetup.evidenceStore.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IV-3 R2-F1: runDeliveryCategory explicit full ignores tier override (depth shares this path)", async () => {
  const root = mkdtempSync(join(tmpdir(), "iv3-r2f1-cat-"));
  try {
    const project = join(root, "project");
    const revision = await initR2Repo(project, {
      "package.json": JSON.stringify({ name: "r2f1cat", scripts: { test: "node --test" } }),
      "src/a.mjs": "export const a = 1;\n",
      "test/a.test.mjs": 'import test from "node:test";\ntest("a", () => {});\n',
    });
    const state = join(root, "state");
    mkdirSync(state, { recursive: true });
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    const evidenceStore = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
    const slot = createDeliveryWorkspaceSlot(
      (targetRevision?: string) =>
        new VerificationWorkspaceManager({
          execute: runGit,
          repositoryRoot: project,
          stateDirectory: state,
          runId: "run_r2f1cat",
          kind: "independent-verifier",
          workspaceSuffix: "delivery-category",
          ...(targetRevision ? { targetRevision } : {}),
        }),
    );
    const created = await slot.create(revision);
    try {
      const profile = await inspectFinalVerificationExecutionProfile({
        repositoryRoot: created.path,
        targetRevision: revision,
        execute: runGit,
      });
      const tierCommands = [{ label: "component tier", executable: "node", args: ["--test", "test/component/"] }];
      const selection = { rung: "module_graph", widened: false, tests: ["test/a.test.mjs"] as readonly string[] };
      // Tier without explicit full => validation_tier.
      const tiered = await runDeliveryCategory({
        category: "tests",
        profile,
        manager: created.manager,
        runId: "run_r2f1cat",
        evidenceTaskId: "delivery:T1",
        generationId: "r2f1cat:tier",
        git: runGit,
        artifacts,
        evidenceStore,
        execution: stubExecution(),
        selection,
        tierCommands,
        validationTier: "component",
      });
      assert.equal(tiered.executedScope, "validation_tier");
      assert.equal(tiered.validationTier, "component");
      assert.ok(tiered.args.includes("test/component/"), JSON.stringify(tiered.args));
      // Same tier with explicit full => detected full script, no tier.
      // The high-tier depth runner shares this path (it passes its explicit
      // mandate through), so depth explicit full + tier also runs full.
      const forced = await runDeliveryCategory({
        category: "tests",
        profile,
        manager: created.manager,
        runId: "run_r2f1cat",
        evidenceTaskId: "delivery:T1",
        generationId: "r2f1cat:forced",
        git: runGit,
        artifacts,
        evidenceStore,
        execution: stubExecution(),
        selection,
        forceFullSuite: true,
        tierCommands,
        validationTier: "component",
      });
      assert.equal(forced.executedScope, "full_test_script");
      assert.equal(forced.validationTier, undefined);
      assert.ok(!forced.args.includes("test/component/"), JSON.stringify(forced.args));
      assert.ok(forced.args.includes("run") && forced.args.includes("test"), JSON.stringify(forced.args));
    } finally {
      await slot.cleanup().catch(() => undefined);
      evidenceStore.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R2-F2: boundary duration covers the whole real attempt.
// ---------------------------------------------------------------------------

test("IV-3 R2-F2: pre-execution failure records once; cleanup skipped; retry adds zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "iv3-r2f2-"));
  const ledger = new SqliteBudgetLedger(join(root, "budget.sqlite"), {
    limitsFor: (scopeId: string) => {
      if (scopeId === "run_r2f2") return { maxToolCalls: 1000 };
      if (isRunValidationBudgetScope(scopeId, "run_r2f2")) return {};
      throw new Error(`Unknown budget scope ${scopeId}.`);
    },
  });
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  try {
    let now = Date.parse("2026-10-06T00:00:00.000Z");
    const clock = () => {
      const iso = new Date(now).toISOString();
      now += 100;
      return iso;
    };
    const unreachableGit = (async () => {
      throw new Error("git should not run before workspace");
    }) as unknown as GitRunner;
    const unreachableExecution = {
      execute: async () => {
        throw new Error("execution should not run");
      },
    } as unknown as OneShotCommandExecutor;
    let cleanups = 0;
    const driver = createDeliveryBoundaryDriver({
      runId: "run_r2f2",
      git: unreachableGit,
      artifacts,
      evidenceStore,
      execution: unreachableExecution,
      boundaryWorkspace: {
        create: async () => {
          throw new Error("injected workspace failure");
        },
        current: () => undefined,
        cleanup: async () => {
          cleanups += 1;
        },
      },
      changedFilesFor: async () => ["src/a.mjs"],
      validationAccounting: { ledger, clock },
    });
    await assert.rejects(
      driver.check({
        runId: "run_r2f2",
        taskId: "task_a",
        boundaryId: "boundary:task_a:1",
        attempt: 1,
        integrationRevision: "r".repeat(40),
      }),
      /injected workspace failure/,
    );
    assert.equal(cleanups, 0, "cleanup runs only if workspace creation succeeded");
    assert.equal(
      getValidationBudgetUsage(ledger, "run_r2f2", "task_a").usedMs,
      100,
      "pre-execution failure records its duration once",
    );
    await assert.rejects(
      driver.check({
        runId: "run_r2f2",
        taskId: "task_a",
        boundaryId: "boundary:task_a:1",
        attempt: 1,
        integrationRevision: "r".repeat(40),
      }),
      /injected workspace failure/,
    );
    assert.equal(
      getValidationBudgetUsage(ledger, "run_r2f2", "task_a").usedMs,
      100,
      "retry of the same boundaryId+attempt adds zero",
    );
    assert.equal(cleanups, 0);
    // changedFilesFor failure (also pre-workspace) records once, no cleanup.
    const driver2 = createDeliveryBoundaryDriver({
      runId: "run_r2f2",
      git: unreachableGit,
      artifacts,
      evidenceStore,
      execution: unreachableExecution,
      boundaryWorkspace: {
        create: async () => {
          throw new Error("workspace create should not run");
        },
        current: () => undefined,
        cleanup: async () => {
          cleanups += 1;
        },
      },
      changedFilesFor: async () => {
        throw new Error("injected changed-files failure");
      },
      validationAccounting: { ledger, clock },
    });
    await assert.rejects(
      driver2.check({
        runId: "run_r2f2",
        taskId: "task_b",
        boundaryId: "boundary:task_b:1",
        attempt: 1,
        integrationRevision: "r".repeat(40),
      }),
      /injected changed-files failure/,
    );
    assert.equal(cleanups, 0);
    assert.equal(getValidationBudgetUsage(ledger, "run_r2f2", "task_b").usedMs, 100);
  } finally {
    evidenceStore.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("IV-3 R2-F2: boundary success records its duration exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "iv3-r2f2-ok-"));
  try {
    const project = join(root, "project");
    const revision = await initR2Repo(project, {
      "package.json": JSON.stringify({ name: "r2f2ok", scripts: { test: "node --test" } }),
      "src/a.mjs": "export const a = 1;\n",
      "test/a.test.mjs": 'import test from "node:test";\ntest("a", () => {});\n',
    });
    const runId = "run_r2f2ok";
    const state = join(root, "state");
    mkdirSync(state, { recursive: true });
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    const evidenceStore = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
    const ledger = new SqliteBudgetLedger(join(state, "budget.sqlite"), {
      limitsFor: (scopeId: string) => {
        if (scopeId === runId) return { maxToolCalls: 1000 };
        if (isRunValidationBudgetScope(scopeId, runId)) return {};
        throw new Error(`Unknown budget scope ${scopeId}.`);
      },
    });
    let now = Date.parse("2026-10-06T00:00:00.000Z");
    const clock = () => {
      const iso = new Date(now).toISOString();
      now += 100;
      return iso;
    };
    const slot = createDeliveryWorkspaceSlot(
      (targetRevision?: string) =>
        new VerificationWorkspaceManager({
          execute: runGit,
          repositoryRoot: project,
          stateDirectory: state,
          runId,
          kind: "independent-verifier",
          workspaceSuffix: "delivery-boundary",
          ...(targetRevision ? { targetRevision } : {}),
        }),
    );
    try {
      const driver = createDeliveryBoundaryDriver({
        runId,
        git: runGit,
        artifacts,
        evidenceStore,
        execution: stubExecution(),
        boundaryWorkspace: slot,
        changedFilesFor: async () => ["src/a.mjs"],
        validationAccounting: { ledger, clock },
      });
      const outcome = await driver.check({
        runId,
        taskId: "task_a",
        boundaryId: "boundary:task_a:1",
        attempt: 1,
        integrationRevision: revision,
      });
      assert.ok(outcome.checks.length > 0);
      const usage = getValidationBudgetUsage(ledger, runId, "task_a");
      assert.equal(usage.segments.length, 1, "success records exactly one boundary segment");
      assert.equal(usage.usedMs, 100, "success records its duration once");
    } finally {
      await slot.cleanup().catch(() => undefined);
      evidenceStore.close();
      ledger.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R2-F3: revision-bound budget resolver fails closed.
// ---------------------------------------------------------------------------

test("IV-3 R2-F3: budget resolver fails closed on invalid revision and Git failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "iv3-r2f3-"));
  const git = async (...args: string[]) => (await runGit({ cwd: root, args })).stdout.trim();
  try {
    await git("init", "-b", "main");
    await git("config", "user.email", "iv3@example.com");
    await git("config", "user.name", "iv3");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "r2f3" }));
    await git("add", "--all");
    await git("commit", "-m", "base");
    const base = await git("rev-parse", "HEAD");
    assert.equal(await readValidationBudgetMsAtRevision({ git: runGit, cwd: root, revision: base }), 600_000);
    writeFileSync(join(root, PROJECT_VALIDATION_CONFIG_PATH), JSON.stringify({ version: 1, validationBudgetMs: 50 }));
    await git("add", "--all");
    await git("commit", "-m", "override");
    const override = await git("rev-parse", "HEAD");
    assert.equal(await readValidationBudgetMsAtRevision({ git: runGit, cwd: root, revision: override }), 50);
    await assert.rejects(
      readValidationBudgetMsAtRevision({
        git: runGit,
        cwd: root,
        revision: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
      /invalid or unresolvable/,
    );
    writeFileSync(join(root, PROJECT_VALIDATION_CONFIG_PATH), "{ not json");
    await git("add", "--all");
    await git("commit", "-m", "bad json");
    const badJson = await git("rev-parse", "HEAD");
    await assert.rejects(
      readValidationBudgetMsAtRevision({ git: runGit, cwd: root, revision: badJson }),
      /not valid JSON/,
    );
    const throwingGit: GitRunner = async () => {
      throw new Error("injected git boom");
    };
    await assert.rejects(
      readValidationBudgetMsAtRevision({ git: throwingGit, cwd: root, revision: base }),
      /unresolvable|boom/,
    );
    const lsFail: GitRunner = async (options) => {
      if (options.args[0] === "rev-parse") return { exitCode: 0, stdout: `${base}\n`, stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "injected ls-tree failure" };
    };
    await assert.rejects(
      readValidationBudgetMsAtRevision({ git: lsFail, cwd: root, revision: base }),
      /Git read failed/,
    );
    const showFail: GitRunner = async (options) => {
      if (options.args[0] === "rev-parse") return { exitCode: 0, stdout: `${base}\n`, stderr: "" };
      if (options.args[0] === "ls-tree") {
        return { exitCode: 0, stdout: `100644 blob ${"a".repeat(40)}\t${PROJECT_VALIDATION_CONFIG_PATH}\n`, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "injected show failure" };
    };
    await assert.rejects(
      readValidationBudgetMsAtRevision({ git: showFail, cwd: root, revision: base }),
      /present but unreadable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
