import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { FinalVerificationRuntime, type FinalVerificationCommand } from "../src/final-verification-runtime.js";
import { judgeFlakyRerun, narrowNodeTestCommand } from "../src/flaky-rerun.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { captureGitBaseline, IntegrationManager, runGit, VerificationWorkspaceManager } from "./support/git-fixture.js";
import { profileForRequiredCategories } from "./support/final-verification-profile.js";
import { createTestOneShotCommandExecutor } from "./support/one-shot-command-executor.js";

/**
 * T6b repair (B2): the owner real-counts verdict. A green exit alone never
 * proves flaky — only the rerun's own report showing the named tests
 * executed and passed does.
 */

test("a green rerun with no report is not flaky", () => {
  const verdict = judgeFlakyRerun({ checkGreen: true, reports: [], failingTestIds: ["red-one"] });
  assert.equal(verdict.flaky, false);
});

test("a green rerun that executed nothing is not flaky", () => {
  // A --test-name-pattern that matches nothing exits 0 with zero executed.
  const verdict = judgeFlakyRerun({
    checkGreen: true,
    reports: [{ failingTestIds: [], executed: 0, failed: 0 }],
    failingTestIds: ["red-one"],
  });
  assert.equal(verdict.flaky, false);
});

test("a green rerun that executed and passed the named tests is flaky", () => {
  const verdict = judgeFlakyRerun({
    checkGreen: true,
    reports: [{ failingTestIds: [], executed: 1, failed: 0 }],
    failingTestIds: ["red-one"],
  });
  assert.equal(verdict.flaky, true);
});

test("a red rerun is a consistent failure", () => {
  const verdict = judgeFlakyRerun({
    checkGreen: false,
    reports: [{ failingTestIds: ["red-one"], executed: 1, failed: 1 }],
    failingTestIds: ["red-one"],
  });
  assert.equal(verdict.flaky, false);
  assert.match(verdict.note, /same way/);
});

/**
 * T6b repair (B2): a really flaky fixture through the real
 * FinalVerificationRuntime. The fixture fails on the full run and passes
 * when narrowed to itself, so the filtered rerun is genuinely flaky by
 * real counts — not by exit code. The full run stays red even with
 * NODE_TEST_CONTEXT forced into the harness (N1): final verification
 * always strips it from the child.
 */
test("a really flaky node --test isolates as flaky by real counts", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t6b-flaky-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "t6b-flaky-fixture", version: "1.0.0", type: "module" }, null, 2));
  // Order-dependent flakiness: the setup test pollutes shared state that
  // makes "t6b flaky red" fail on the full run. Narrowed to itself, the
  // red test runs alone and passes. The red test cleans up, so repeated
  // full runs stay red.
  writeFileSync(
    join(project, "test", "flaky.test.mjs"),
    'import test from "node:test";\n' +
      'import { existsSync, unlinkSync, writeFileSync } from "node:fs";\n' +
      'import { tmpdir } from "node:os";\n' +
      'import { join } from "node:path";\n' +
      'const marker = join(tmpdir(), "aiboard-t6b-flaky-marker");\n' +
      'test("t6b flaky setup", () => { writeFileSync(marker, "polluted"); });\n' +
      'test("t6b flaky red", () => {\n' +
      '  if (existsSync(marker)) { unlinkSync(marker); throw new Error("fails on the full run, passes when narrowed"); }\n' +
      "});\n",
  );
  const runId = "run-t6b-flaky-rerun";
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new IntegrationManager({ repositoryRoot: project, stateDirectory: state, runId, baselineRevision: baseline.revision });
  await integration.initialize();
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  // Force the harness leak the review found: the full run must stay red
  // because final verification strips NODE_TEST_CONTEXT from the child.
  const leaked = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = "child";
  try {
    const command: FinalVerificationCommand = {
      label: "package tests",
      executable: process.execPath,
      args: ["--test", "test/flaky.test.mjs"],
    };
    assert.ok(narrowNodeTestCommand(command, ["t6b flaky red"]) !== undefined, "the fixture command narrows");
    const plan = {
      checks: (["tests", "build", "runtime_smoke", "browser"] as const).map((category) =>
        category === "tests"
          ? { category, status: "required" as const }
          : {
              category,
              status: "not_applicable" as const,
              rationale: `No ${category} fixture is configured.`,
              repositoryInspection: { paths: ["package.json"], summary: `No ${category} fixture is configured.` },
            }),
    };
    const profile = {
      ...profileForRequiredCategories(integration.revision, ["tests"]),
      commands: { tests: [command] },
    };
    const full = new FinalVerificationRuntime({
      git: runGit,
      workspaceManager: new VerificationWorkspaceManager({ repositoryRoot: project, stateDirectory: state, runId, targetRevision: integration.revision }),
      artifacts,
      evidenceStore: evidence,
      runId,
      taskId: "flaky-task",
      generationId: "flaky-full",
      execution: createTestOneShotCommandExecutor(),
    });
    const fullRun = await full.runCategory({ plan, executionProfile: profile, commands: { tests: [command] } }, "tests");
    assert.equal(fullRun.check.green, false, "the full run fails");
    const fullReports = fullRun.check.facts.flatMap((fact) => fact.kind === "command" && fact.report ? [fact.report] : []);
    assert.equal(fullReports.length, 1);
    assert.deepEqual([...(fullReports[0]!.failingTestIds ?? [])], ["t6b flaky red"]);
    assert.ok((fullReports[0]!.executed ?? 0) >= 1);
    // The narrowed rerun passes with real counts: genuinely flaky.
    const narrowed = narrowNodeTestCommand(command, [...(fullReports[0]!.failingTestIds ?? [])])!;
    const narrowedProfile = { ...profile, commands: { tests: [narrowed] } };
    const rerun = new FinalVerificationRuntime({
      git: runGit,
      workspaceManager: new VerificationWorkspaceManager({ repositoryRoot: project, stateDirectory: state, runId, targetRevision: integration.revision }),
      artifacts,
      evidenceStore: evidence,
      runId,
      taskId: "flaky-task",
      generationId: "flaky-rerun",
      execution: createTestOneShotCommandExecutor(),
    });
    const rerunRun = await rerun.runCategory({ plan, executionProfile: narrowedProfile, commands: { tests: [narrowed] } }, "tests");
    assert.equal(rerunRun.check.green, true, "the narrowed rerun passes");
    const rerunReports = rerunRun.check.facts.flatMap((fact) => fact.kind === "command" && fact.report ? [fact.report] : []);
    const verdict = judgeFlakyRerun({ checkGreen: rerunRun.check.green, reports: rerunReports, failingTestIds: [...(fullReports[0]!.failingTestIds ?? [])] });
    assert.equal(verdict.flaky, true, `expected flaky by real counts: ${verdict.note}`);
    // The B2 trap, end to end: a pattern matching nothing exits green with
    // nothing executed, which is not flaky.
    const empty = new FinalVerificationRuntime({
      git: runGit,
      workspaceManager: new VerificationWorkspaceManager({ repositoryRoot: project, stateDirectory: state, runId, targetRevision: integration.revision }),
      artifacts,
      evidenceStore: evidence,
      runId,
      taskId: "flaky-task",
      generationId: "flaky-empty",
      execution: createTestOneShotCommandExecutor(),
    });
    const emptyCommand = { ...command, label: `${command.label} (flaky rerun)`, args: ["--test", "--test-name-pattern=^nonexistent$", "test/flaky.test.mjs"] };
    const emptyProfile = { ...profile, commands: { tests: [emptyCommand] } };
    const emptyRun = await empty.runCategory({
      plan,
      executionProfile: emptyProfile,
      commands: { tests: [emptyCommand] },
    }, "tests");
    assert.equal(emptyRun.check.green, true, "an empty pattern exits green");
    const emptyReports = emptyRun.check.facts.flatMap((fact) => fact.kind === "command" && fact.report ? [fact.report] : []);
    const emptyVerdict = judgeFlakyRerun({ checkGreen: emptyRun.check.green, reports: emptyReports, failingTestIds: ["t6b flaky red"] });
    assert.equal(emptyVerdict.flaky, false, "an empty green rerun is not flaky");
  } finally {
    if (leaked === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = leaked;
    evidence.close();
    await integration.cleanup().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
