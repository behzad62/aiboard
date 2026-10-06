import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { isAbsolute, dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createDeliveryDepthRunner, createDeliveryWorkspaceSlot } from "../src/delivery-execution.js";
import { createExecutionHost } from "../src/execution-host.js";
import { requireGitRunner } from "../src/git-command.js";
import type { MutationFileSystem } from "../src/mutation-probe.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import type { TaskValidationMandates } from "../src/task-validation-policy.js";
import { VerificationWorkspaceManager } from "../src/verification-workspace.js";
import type { DeliveryDepthRunner } from "../src/native-deliverable-review.js";
import { runGit } from "./support/git-fixture.js";

/**
 * IV-2 (CD-23/EP16) high-tier depth execution: the depth runner RUNS the
 * selected tests (not only records them) and the break-it probe uses that
 * same actual command, so probe scope cannot silently differ. An explicit
 * full-suite mandate forces the whole script at depth too.
 */

const RUN_ID = "run-iv2-depth";
const CALC_TEST = "packages/a/test/calc.test.mjs";
const CALC_SRC = "packages/a/src/calc.mjs";

const CALC_SRC_CONTENT = [
  "export function clamp(value) {",
  "  if (value > 9) return 9;",
  "  if (value < 0) return 0;",
  "  return value + 1 - 1;",
  "}",
  "",
].join("\n");

const DEPTH_FILES: Record<string, string> = {
  "packages/a/package.json": JSON.stringify({ name: "a", version: "1.0.0" }),
  [CALC_SRC]: CALC_SRC_CONTENT,
  [CALC_TEST]: [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { clamp } from "../src/calc.mjs";',
    'test("clamp clamps high", () => assert.equal(clamp(99), 9));',
    'test("clamp clamps low", () => assert.equal(clamp(-5), 0));',
    "",
  ].join("\n"),
  "packages/b/package.json": JSON.stringify({ name: "b", version: "1.0.0" }),
  "packages/b/src/b.mjs": "export const b = 2;\n",
  "packages/b/test/sentinel.test.mjs": [
    'import test from "node:test";',
    'test("full-only sentinel", () => { throw new Error("SENTINEL RAN: the full suite executed"); });',
    "",
  ].join("\n"),
};

const CALC_DIFF = [
  `diff --git a/${CALC_SRC} b/${CALC_SRC}`,
  `--- a/${CALC_SRC}`,
  `+++ b/${CALC_SRC}`,
  "@@ -0,0 +1,5 @@",
  "+export function clamp(value) {",
  "+  if (value > 9) return 9;",
  "+  if (value < 0) return 0;",
  "+  return value + 1 - 1;",
  "+}",
].join("\n");

interface DepthSetup {
  root: string;
  integrationRevision: string;
  artifacts: ArtifactStore;
  evidenceStore: SqliteEvidenceStore;
  close(): Promise<void>;
  runDepth(reviewId: string, mandates?: TaskValidationMandates): Promise<Awaited<ReturnType<DeliveryDepthRunner["run"]>>>;
}

async function setupDepth(): Promise<DepthSetup> {
  const root = mkdtempSync(join(tmpdir(), "aiboard iv2 depth "));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "iv2-depth-fixture",
      version: "1.0.0",
      type: "module",
      packageManager: "npm@11.0.0",
      scripts: { test: "node --test" },
      workspaces: ["packages/a", "packages/b"],
    }, null, 2),
  );
  for (const [path, text] of Object.entries(DEPTH_FILES)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  }
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const lock = spawnSync(process.execPath, [npmCli, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: project, encoding: "utf8" });
  assert.equal(lock.status, 0, lock.stderr);
  await runGit({ cwd: project, args: ["init", "-b", "main"] });
  await runGit({ cwd: project, args: ["add", "-A"] });
  await runGit({ cwd: project, args: ["commit", "-m", "integrated T1"] });
  const head = await runGit({ cwd: project, args: ["rev-parse", "HEAD"] });
  const integrationRevision = head.stdout.trim();
  assert.match(integrationRevision, /^[a-f0-9]{40}$/);

  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts,
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
  });
  const binding = await executionHost.bindRun({
    runId: RUN_ID,
    permissionProfile: "full",
    capabilityContract: { digest: "f".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  });
  const ambientNodeOptions = (): string | undefined => {
    const source = executionHost.filteredEnvironmentSource();
    const name = Object.keys(source).find((key) => key.toUpperCase() === "NODE_OPTIONS");
    return name ? source[name] : undefined;
  };
  const deliveryGit = requireGitRunner(binding.git).lifecycle("verification").run;
  const evidenceStore = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const reviewWorkspace = createDeliveryWorkspaceSlot(
    (targetRevision?: string) =>
      new VerificationWorkspaceManager({
        execute: deliveryGit,
        repositoryRoot: project,
        stateDirectory: state,
        runId: RUN_ID,
        kind: "independent-verifier",
        workspaceSuffix: "delivery-review",
        ...(targetRevision ? { targetRevision } : {}),
      }),
  );
  const checkout = await reviewWorkspace.create(integrationRevision);
  // Same file-system semantics as the factory's deliveryProbeFileSystem.
  const probeFileSystem = (workspacePath: string): MutationFileSystem => ({
    readFile: (path) => readFileSync(isAbsolute(path) ? path : join(workspacePath, path), "utf8"),
    writeFile: (path, content) => writeFileSync(path, content, "utf8"),
    createDisposableCopy: () => workspacePath,
    cleanupDisposableCopy: () => undefined,
    join: (rootPath, path) => join(rootPath, path),
  });

  return {
    root,
    integrationRevision,
    artifacts,
    evidenceStore,
    close: async () => {
      await reviewWorkspace.cleanup().catch(() => undefined);
      evidenceStore.close();
      await binding.close();
      await executionHost.close();
      rmSync(root, { recursive: true, force: true });
    },
    runDepth: async (reviewId, mandates) => {
      const runner = createDeliveryDepthRunner({
        runId: RUN_ID,
        git: deliveryGit,
        artifacts,
        evidenceStore,
        execution: binding.commandExecution,
        reviewWorkspace,
        ambientNodeOptions,
        probeFileSystem,
        ...(mandates ? { validationMandates: mandates } : {}),
      });
      return runner.run({
        runId: RUN_ID,
        taskId: "T1",
        reviewId,
        sessionId: "session:T1",
        reviewerRuntimeId: "reviewer-runtime",
        workspacePath: checkout.path,
        taskRevision: integrationRevision,
        baselineRevision: "b".repeat(40),
        changedFiles: [CALC_SRC],
        diffText: CALC_DIFF,
      });
    },
  };
}

test("IV-2 depth runs the selected tests and probes with the same actual command", async () => {
  const setup = await setupDepth();
  try {
    const { affectedTests, probe } = await setup.runDepth("review_T1_selected");
    assert.equal(affectedTests.executedScope, "selected");
    assert.equal(affectedTests.selectionRung, "module_graph");
    assert.deepEqual(affectedTests.selectedTests, [CALC_TEST]);
    assert.equal(affectedTests.widened, false);
    assert.deepEqual(affectedTests.args.slice(-2), ["--", CALC_TEST]);
    assert.equal(affectedTests.outcome, "passed", "the failing sentinel never ran");
    assert.deepEqual(affectedTests.report.counts, { selected: 2, passed: 2, failed: 0, skipped: 0 });
    assert.ok(affectedTests.evidenceIds.length > 0);
    assert.ok(probe.mutantsGenerated >= 1, `expected generated mutants, got ${probe.mutantsGenerated}`);
    assert.ok(probe.mutantsExecuted >= 1, `expected executed mutants, got ${probe.mutantsExecuted}`);
    // Every probe execution names the exact selected argv — probe scope cannot silently differ.
    assert.ok(probe.evidenceIds.length > 0);
    const probeFacts = setup.evidenceStore.getByIds({ runId: RUN_ID, ids: probe.evidenceIds });
    assert.equal(probeFacts.length, probe.evidenceIds.length);
    for (const record of probeFacts) {
      const fact = record.fact;
      assert.equal(fact.kind, "command");
      if (fact.kind !== "command") throw new Error("probe evidence must be command evidence");
      assert.equal(fact.command, affectedTests.command);
      assert.deepEqual(fact.args, affectedTests.args);
    }
  } finally {
    await setup.close();
  }
});

test("IV-2 depth honors an explicit full-suite mandate", async () => {
  const setup = await setupDepth();
  try {
    const { affectedTests, probe } = await setup.runDepth("review_T1_forced", {
      sourceMandates: [{ id: "mandate_full", gate: "full_suite", scope: "affected", source: "source", description: "Release gate requires the full suite." }],
      projectMandates: [],
    });
    assert.equal(affectedTests.executedScope, "full_test_script");
    assert.deepEqual(affectedTests.args.slice(-2), ["run", "test"]);
    assert.equal(affectedTests.outcome, "failed", "the full run executes the failing sentinel");
    assert.equal(probe.rung, "builtin_mutator");
  } finally {
    await setup.close();
  }
});
