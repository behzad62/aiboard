import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { captureGitBaseline } from "../src/git-baseline.js";
import { runGit } from "../src/git-command.js";
import { IntegrationManager } from "../src/integration-manager.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import {
  FinalVerificationRuntime,
  type FinalVerificationCommand,
  type FinalVerificationPlan,
} from "../src/final-verification-runtime.js";
import { VerificationWorkspaceManager } from "../src/verification-workspace.js";
import { createProductionOneShotCommandFixture, createTestOneShotCommandExecutor } from "./support/one-shot-command-executor.js";
import type { OneShotCommandExecutor } from "../src/one-shot-command-executor.js";

test("final verification ingests runtime spill output and log volume alone stays green", async () => {
  const fixture = await createFixture("spill-output");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "spill-evidence.sqlite"));
  const workspace = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  const complete = Buffer.from("complete-final-verification-spill");
  const spill = await artifacts.put(complete, "application/octet-stream", "spill");
  const execution: OneShotCommandExecutor = {
    execute: async () => ({
      process: {
        logicalProcessId: "final-spill",
        outcome: "exited",
        exitCode: 0,
        finishedAt: new Date().toISOString(),
        output: [
          { stream: "stdout", tail: "bounded-tail", totalBytes: 70 * 1024 * 1024, truncated: true, spillArtifactId: spill.hash, spillBytes: complete.byteLength, lossyBytes: 6 * 1024 * 1024 },
          { stream: "stderr", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
        ],
        cleanup: { state: "verified_empty", verifiedAt: new Date().toISOString() },
      },
      enforcement: "unconfined_explicit_full",
      disclosure: "unconfined_explicit_full",
    }),
  };
  const runtime = new FinalVerificationRuntime({
    workspaceManager: workspace,
    artifacts,
    evidenceStore: evidence,
    runId: fixture.runId,
    integrationRevision: () => fixture.integration.revision,
    execution,
  });
  try {
    const commands = { build: [{ label: "large logs", executable: "fixture", args: [] }] };
    const run = await runtime.run({
      plan: buildOnlyPlan(),
      executionProfile: commandProfile(fixture.integration.revision, commands),
      commands,
    });
    assert.equal(run.green, true, run.checks[0]?.issues.join("\n"));
    const fact = commandFacts(run.checks[0]!)[0];
    assert.equal(fact.outputLossy, true);
    assert.deepEqual(await artifacts.get(fact.stdoutArtifactHash), complete);
  } finally {
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("final verification falls back to bounded tails for missing or corrupt spills", async (t) => {
  for (const mode of ["missing", "corrupt"] as const) {
    await t.test(mode, async () => {
      const fixture = await createFixture(`spill-${mode}`);
      const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
      const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
      const workspace = new VerificationWorkspaceManager({
        repositoryRoot: fixture.project, stateDirectory: fixture.state, runId: fixture.runId,
        targetRevision: fixture.integration.revision,
      });
      try {
        let spill = { hash: "b".repeat(64) };
        if (mode === "corrupt") {
          const created = await artifacts.put(Buffer.from("complete spill"), "text/plain", "spill");
          writeFileSync(created.path, "corrupt bytes");
          spill = { hash: created.hash };
        }
        const execution: OneShotCommandExecutor = { execute: async () => ({
          process: {
            logicalProcessId: `final-${mode}`, outcome: "exited", exitCode: 0,
            finishedAt: new Date().toISOString(),
            output: [
              { stream: "stdout", tail: `bounded-${mode}`, totalBytes: 256 * 1024, truncated: true, spillArtifactId: spill.hash, spillBytes: 128 * 1024, lossyBytes: 0 },
              { stream: "stderr", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
            ],
            cleanup: { state: "verified_empty", verifiedAt: new Date().toISOString() },
          },
          enforcement: "unconfined_explicit_full", disclosure: "unconfined_explicit_full",
        }) };
        const runtime = new FinalVerificationRuntime({
          workspaceManager: workspace, artifacts, evidenceStore: evidence, runId: fixture.runId,
          integrationRevision: () => fixture.integration.revision, execution,
        });
        const commands = { build: [{ label: mode, executable: "fixture", args: [] }] };
        const run = await runtime.run({ plan: buildOnlyPlan(), executionProfile: commandProfile(fixture.integration.revision, commands), commands });
        assert.equal(run.green, true, run.checks[0]?.issues.join("\n"));
        const fact = commandFacts(run.checks[0]!)[0];
        assert.equal(fact.outputLossy, true);
        assert.equal((await artifacts.get(fact.stdoutArtifactHash)).toString(), `bounded-${mode}`);
      } finally {
        evidence.close();
        await workspace.cleanup().catch(() => undefined);
        await closeFixture(fixture);
      }
    });
  }
});

test("final verification preserves stable isolation and runtime failure codes", async (t) => {
  for (const code of ["isolation_capability_unavailable", "isolation_revocation_failed", "outcome_unknown"] as const) {
    await t.test(code, async () => {
      const fixture = await createFixture(`typed-${code}`);
      const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
      const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
      const workspace = new VerificationWorkspaceManager({
        repositoryRoot: fixture.project, stateDirectory: fixture.state, runId: fixture.runId,
        targetRevision: fixture.integration.revision,
      });
      try {
        const runtime = new FinalVerificationRuntime({
          workspaceManager: workspace, artifacts, evidenceStore: evidence, runId: fixture.runId,
          integrationRevision: () => fixture.integration.revision,
          execution: { execute: async () => { throw Object.assign(new Error(code), { code }); } },
        });
        const commands = { build: [{ label: code, executable: "fixture", args: [] }] };
        const run = await runtime.run({ plan: buildOnlyPlan(), executionProfile: commandProfile(fixture.integration.revision, commands), commands });
        assert.equal(run.green, false);
        const fact = commandFacts(run.checks[0]!)[0];
        assert.equal(fact.errorCode, code);
        assert.equal(run.checks[0]?.issues.some((issue) => issue.includes(code)), true);
      } finally {
        evidence.close();
        await workspace.cleanup().catch(() => undefined);
        await closeFixture(fixture);
      }
    });
  }
});

test("final-verification production graph scrubs inherited secrets and survives output beyond spill capacity", async (t) => {
  const fixture = await createFixture("production-output-matrix");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const workspace = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project, stateDirectory: fixture.state, runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  const secretName = "RUNNER_MATRIX_INHERITED_SECRET";
  const previous = process.env[secretName];
  process.env[secretName] = "must-not-reach-final-child";
  const graph = createProductionOneShotCommandFixture(t, { artifacts });
  try {
    const runtime = new FinalVerificationRuntime({
      workspaceManager: workspace, artifacts, evidenceStore: evidence, runId: fixture.runId,
      integrationRevision: () => fixture.integration.revision, execution: graph.execution,
    });
    const commands = { build: [{
      label: "large", executable: process.execPath, timeoutMs: 25_000,
      args: ["-e", `const marker=String(process.env.${secretName} ?? "absent"); process.stdout.write(marker+"|"); process.stdout.write("x".repeat(65*1024*1024)); process.stdout.write("|"+marker);`],
    }] };
    const run = await runtime.run({ plan: buildOnlyPlan(), executionProfile: commandProfile(fixture.integration.revision, commands), commands });
    assert.equal(run.green, true, run.checks[0]?.issues.join("\n"));
    const fact = commandFacts(run.checks[0]!)[0];
    const output = await artifacts.get(fact.stdoutArtifactHash);
    assert.equal(output.includes(Buffer.from("must-not-reach-final-child")), false);
    assert.equal(output.includes(Buffer.from("absent")), true);
    assert.equal(fact.outputLossy, true);
  } finally {
    if (previous === undefined) delete process.env[secretName]; else process.env[secretName] = previous;
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("final-verification production graph stays mechanically green on spill setup failure", async (t) => {
  const fixture = await createFixture("production-spill-fault");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const workspace = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project, stateDirectory: fixture.state, runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  const graph = createProductionOneShotCommandFixture(t, { artifacts, spillFault: true });
  try {
    const runtime = new FinalVerificationRuntime({
      workspaceManager: workspace, artifacts, evidenceStore: evidence, runId: fixture.runId,
      integrationRevision: () => fixture.integration.revision, execution: graph.execution,
    });
    const commands = { build: [{ label: "spill fault", executable: process.execPath, args: ["-e", "process.stdout.write('z'.repeat(256*1024))"] }] };
    const run = await runtime.run({ plan: buildOnlyPlan(), executionProfile: commandProfile(fixture.integration.revision, commands), commands });
    assert.equal(run.green, true, run.checks[0]?.issues.join("\n"));
    const fact = commandFacts(run.checks[0]!)[0];
    assert.equal(fact.outputLossy, true);
    assert.match((await artifacts.get(fact.stdoutArtifactHash)).toString(), /runner output lossy/);
  } finally {
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("runs build and test commands in the pinned workspace and records immutable evidence", async (t) => {
  const fixture = await createFixture("success");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const workspace = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  const runtime = new FinalVerificationRuntime({
    workspaceManager: workspace,
    artifacts,
    evidenceStore: evidence,
    runId: fixture.runId,
    taskId: "final-verification",
    integrationRevision: () => fixture.integration.revision,
    execution: createTestOneShotCommandExecutor(t, { artifacts }),
  });
  try {
    const projectBefore = await projectState(fixture.project);
    const commands = {
      build: [{
        label: "build command",
        executable: process.execPath,
        args: [
          "-e",
          "const fs=require('node:fs'); fs.writeFileSync('generated-by-build.txt', 'temporary\\n'); process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2]);",
          "stdout ; & spaces",
          "stderr ; & spaces",
        ],
      }],
      tests: [{
        label: "test command",
        executable: process.execPath,
        args: ["-e", "process.stdout.write('tests passed')"],
      }],
    };
    const run = await runtime.run({
      plan: buildTestPlan(),
      executionProfile: commandProfile(fixture.integration.revision, commands),
      commands,
    });

    assert.equal(run.green, true);
    assert.equal(run.targetRevision, fixture.integration.revision);
    assert.equal(run.checks.length, 4);
    assert.deepEqual(
      run.checks.map((check) => [check.category, check.status, check.green]),
      [
        ["build", "required", true],
        ["tests", "required", true],
        ["runtime_smoke", "not_applicable", true],
        ["browser", "not_applicable", true],
      ],
    );
    const buildFact = commandFacts(run.checks[0])[0];
    assert.equal(buildFact.executable, process.execPath);
    assert.deepEqual(buildFact.args, [
      "-e",
      "const fs=require('node:fs'); fs.writeFileSync('generated-by-build.txt', 'temporary\\n'); process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2]);",
      "stdout ; & spaces",
      "stderr ; & spaces",
    ]);
    assert.equal(buildFact.cwd, run.workspacePath);
    assert.equal(buildFact.targetRevision, fixture.integration.revision);
    assert.equal(buildFact.startState.revision, fixture.integration.revision);
    assert.equal(buildFact.endState.revision, fixture.integration.revision);
    assert.match(buildFact.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(buildFact.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match((await artifacts.get(buildFact.stdoutArtifactHash)).toString(), /stdout ; & spaces$/);
    assert.match((await artifacts.get(buildFact.stderrArtifactHash)).toString(), /stderr ; & spaces$/);
    assert.equal(existsSync(join(run.workspacePath, "generated-by-build.txt")), true);
    assert.equal("changeSet" in run, false);

    const records = evidence.list({ runId: fixture.runId, taskId: "final-verification" });
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((record) => record.id),
      run.checks.flatMap((check) => check.evidenceIds),
    );
    assert.equal(new Set(records.map((record) => record.id)).size, records.length);
    assert.equal(fixture.integration.revision, run.targetRevision);
    assert.deepEqual(await projectState(fixture.project), projectBefore);
    assert.equal(
      readFileSync(join(fixture.integration.path, "README.md"), "utf8").replaceAll("\r\n", "\n"),
      "baseline\n",
    );
  } finally {
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("provisions dependencies in the disposable workspace before project commands", async (t) => {
  const fixture = await createFixture("dependency-provisioning");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const workspace = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  const runtime = new FinalVerificationRuntime({
    workspaceManager: workspace,
    artifacts,
    evidenceStore: evidence,
    runId: fixture.runId,
    integrationRevision: () => fixture.integration.revision,
    execution: createTestOneShotCommandExecutor(t, { artifacts }),
  });
  const build = {
    label: "build requiring installed package",
    executable: process.execPath,
    args: ["-e", "process.stdout.write(require('local-package'))"],
  };
  const provisioning = {
    manager: "npm" as const,
    lockfile: "package-lock.json",
    command: {
      label: "install dependencies",
      executable: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');fs.mkdirSync('node_modules/local-package',{recursive:true});" +
          "fs.writeFileSync('node_modules/local-package/package.json',JSON.stringify({main:'index.js'}));" +
          "fs.writeFileSync('node_modules/local-package/index.js','module.exports=\"installed\"');",
      ],
    },
  };
  try {
    const run = await runtime.run({
      plan: buildOnlyPlan(),
      executionProfile: {
        ...commandProfile(fixture.integration.revision, { build: [build] }),
        provisioning,
      },
      commands: { build: [build] },
    });
    assert.equal(run.green, true, run.checks[0]?.issues.join("\n"));
    assert.match(
      (await artifacts.get(commandFacts(run.checks[0]!).at(0)!.stdoutArtifactHash)).toString(),
      /installed/,
    );
  } finally {
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("executes one scheduler-selected category with the durable generation identity", async (t) => {
  const fixture = await createFixture("single-category");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const workspace = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    integrationManager: fixture.integration,
  });
  const runtime = new FinalVerificationRuntime({
    workspaceManager: workspace,
    artifacts,
    evidenceStore: evidence,
    runId: fixture.runId,
    taskId: "final-verification-task",
    generationId: "durable-generation",
    attempt: 1,
    currentIntegrationRevision: () => fixture.integration.revision,
    execution: createTestOneShotCommandExecutor(t, { artifacts }),
  });
  try {
    const commands = { tests: [{
      label: "selected test command",
      executable: process.execPath,
      args: ["-e", "process.stdout.write('selected tests passed')"],
    }] };
    const category = await runtime.runCategory({
      plan: buildTestPlan(),
      executionProfile: commandProfile(fixture.integration.revision, commands),
      commands,
    }, "tests");
    assert.equal(category.generationId, "durable-generation");
    assert.equal(category.check.category, "tests");
    assert.equal(category.check.green, true);
    assert.equal(evidence.list({ runId: fixture.runId }).length, 1);
    assert.match(evidence.list({ runId: fixture.runId })[0]!.idempotencyKey,
      /^durable-generation:1:tests:0$/);
  } finally {
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("nonzero, timeout, and cancellation outcomes are mechanically non-green", async (t) => {
  const fixture = await createFixture("failures");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const workspace = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  const runtime = new FinalVerificationRuntime({
    workspaceManager: workspace,
    artifacts,
    evidenceStore: evidence,
    runId: fixture.runId,
    taskId: "final-verification",
    integrationRevision: () => fixture.integration.revision,
    execution: createTestOneShotCommandExecutor(t, { artifacts }),
  });
  try {
    const failingCommands = { build: [{
      label: "failing build",
      executable: process.execPath,
      args: ["-e", "process.stderr.write('failed'); process.exit(7)"],
    }] };
    const failed = await runtime.run({
      plan: buildOnlyPlan(),
      executionProfile: commandProfile(fixture.integration.revision, failingCommands),
      commands: failingCommands,
    });
    const failedFact = commandFacts(failed.checks[0])[0];
    assert.equal(failed.green, false);
    assert.equal(failed.checks[0].green, false);
    assert.equal(failedFact.exitCode, 7);
    assert.equal(failedFact.timedOut, false);
    assert.equal(failedFact.cancelled, false);
    assert.match(failed.checks[0].issues.join(" "), /non-zero|nonzero|exit/i);

    const timedCommands = { build: [{
      label: "timed build",
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000)"],
      timeoutMs: 100,
    }] };
    const timedOut = await runtime.run({
      plan: buildOnlyPlan(),
      executionProfile: commandProfile(fixture.integration.revision, timedCommands),
      commands: timedCommands,
    });
    const timedFact = commandFacts(timedOut.checks[0])[0];
    assert.equal(timedOut.green, false);
    assert.equal(timedFact.timedOut, true);
    assert.equal(timedFact.cancelled, false);

    const controller = new AbortController();
    const cancelledCommands = { build: [{
      label: "cancelled build",
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000)"],
    }] };
    const cancelledPromise = runtime.run({
      plan: buildOnlyPlan(),
      executionProfile: commandProfile(fixture.integration.revision, cancelledCommands),
      signal: controller.signal,
      commands: cancelledCommands,
    });
    setTimeout(() => controller.abort(), 100).unref();
    const cancelled = await cancelledPromise;
    const cancelledFact = commandFacts(cancelled.checks[0])[0];
    assert.equal(cancelled.green, false);
    assert.equal(cancelledFact.cancelled, true);
    assert.equal(cancelledFact.timedOut, false);
  } finally {
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("cancellation terminates descendant processes and leaves no late process output", async (t) => {
  const fixture = await createFixture("process-tree");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const workspace = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  const runtime = new FinalVerificationRuntime({
    workspaceManager: workspace,
    artifacts,
    runId: fixture.runId,
    taskId: "final-verification",
    integrationRevision: () => fixture.integration.revision,
    execution: createTestOneShotCommandExecutor(t, { artifacts }),
  });
  const marker = "late-descendant-output.txt";
  const childPid = "descendant.pid";
  try {
    await workspace.create();
    const controller = new AbortController();
    const childScript = "const fs=require('node:fs'); setTimeout(() => fs.writeFileSync(process.argv[1], 'late'), 1500);";
    const launcherScript = [
      "const fs=require('node:fs');",
      "const {spawn}=require('node:child_process');",
      `const child=spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(childScript)}, process.argv[1]], {stdio:'ignore'});`,
      "fs.writeFileSync(process.argv[2], String(child.pid));",
      "setTimeout(() => {}, 10000);",
    ].join(" ");
    const commands = { build: [{
      label: "tree build",
      executable: process.execPath,
      args: ["-e", launcherScript, marker, childPid],
    }] };
    const promise = runtime.run({
      plan: buildOnlyPlan(),
      executionProfile: commandProfile(fixture.integration.revision, commands),
      signal: controller.signal,
      commands,
    });
    await waitFor(() => existsSync(join(workspace.path, childPid)), 5_000);
    controller.abort();
    const run = await promise;
    const fact = commandFacts(run.checks[0])[0];
    assert.equal(run.green, false);
    assert.equal(fact.cancelled, true);
    assert.equal(existsSync(join(run.workspacePath, childPid)), true);
    await delay(1800);
    assert.equal(existsSync(join(run.workspacePath, marker)), false);
    rmSync(join(run.workspacePath, childPid), { force: true });
  } finally {
    await workspace.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("rejects a workspace that is stale relative to the current integration revision", async (t) => {
  const fixture = await createFixture("stale");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const workspace = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  const currentRevision = async () =>
    (await runGit({ cwd: fixture.integration.path, args: ["rev-parse", "HEAD"] })).stdout.trim();
  const runtime = new FinalVerificationRuntime({
    workspaceManager: workspace,
    artifacts,
    runId: fixture.runId,
    taskId: "final-verification",
    integrationRevision: currentRevision,
    execution: createTestOneShotCommandExecutor(t, { artifacts }),
  });
  try {
    await workspace.create();
    writeFileSync(join(fixture.integration.path, "advanced.txt"), "advanced\n");
    await runGit({ cwd: fixture.integration.path, args: ["add", "advanced.txt"] });
    await runGit({
      cwd: fixture.integration.path,
      args: ["commit", "-m", "Advance integration"],
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    await assert.rejects(
      () => runtime.run({
        plan: buildOnlyPlan(),
        executionProfile: commandProfile(fixture.integration.revision, {}),
        commands: { build: [] },
      }),
      /stale|integration revision|target revision/i,
    );
  } finally {
    await workspace.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

function buildTestPlan(): FinalVerificationPlan {
  return {
    checks: [
      { category: "build", status: "required" },
      { category: "tests", status: "required" },
      notApplicable("runtime_smoke", "No runtime command is present.", "package.json"),
      notApplicable("browser", "No browser surface is present.", "package.json"),
    ],
  };
}

function commandProfile(
  targetRevision: string,
  commands: { build?: readonly FinalVerificationCommand[]; tests?: readonly FinalVerificationCommand[] },
) {
  return {
    version: 1 as const,
    targetRevision,
    inspectedPaths: ["package.json"],
    detectedSignals: (["build", "tests"] as const)
      .filter((category) => Boolean(commands[category]?.length))
      .map((category) => ({ category, source: "fixture", detail: category })),
    commands: {
      ...(commands.build?.length ? { build: commands.build.map((command) => ({ ...command, args: [...command.args] })) } : {}),
      ...(commands.tests?.length ? { tests: commands.tests.map((command) => ({ ...command, args: [...command.args] })) } : {}),
    },
  };
}

function buildOnlyPlan(): FinalVerificationPlan {
  return {
    checks: [
      { category: "build", status: "required" },
      notApplicable("tests", "No test command is configured.", "package.json"),
      notApplicable("runtime_smoke", "No runtime command is present.", "package.json"),
      notApplicable("browser", "No browser surface is present.", "package.json"),
    ],
  };
}

function notApplicable(
  category: "runtime_smoke" | "browser" | "tests",
  rationale: string,
  path: string,
) {
  return {
    category,
    status: "not_applicable" as const,
    rationale,
    repositoryInspection: { paths: [path], summary: rationale },
  };
}

function commandFacts(check: { facts: readonly { kind: string }[] }) {
  const facts = check.facts.filter((fact) => fact.kind === "command");
  assert.equal(facts.length, 1);
  return [facts[0] as unknown as {
    executable: string;
    args: string[];
    cwd: string;
    targetRevision: string;
    startState: { revision: string };
    endState: { revision: string };
    startedAt: string;
    finishedAt: string;
    stdoutArtifactHash: string;
    stderrArtifactHash: string;
    exitCode: number | null;
    timedOut: boolean;
    cancelled: boolean;
    outputLossy: boolean;
    errorCode?: string;
  }];
}

interface Fixture {
  root: string;
  project: string;
  state: string;
  runId: string;
  integration: IntegrationManager;
}

async function createFixture(name: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-final-verification-${name}-`));
  const project = join(root, "user checkout");
  const state = join(root, "runner state & data");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "README.md"), "baseline\n");
  const runId = `run_final_${name}`;
  const baseline = await captureGitBaseline({
    projectPath: project,
    stateDirectory: state,
    runId,
  });
  const integration = new IntegrationManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
  });
  await integration.initialize();
  return { root, project, state, runId, integration };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.integration.cleanup().catch(() => undefined);
  await runGit({
    cwd: fixture.project,
    args: ["worktree", "prune", "--expire", "now"],
    allowFailure: true,
  }).catch(() => undefined);
  rmSync(fixture.root, { recursive: true, force: true });
}

async function projectState(project: string): Promise<{ revision: string; status: string }> {
  return {
    revision: (await runGit({ cwd: project, args: ["rev-parse", "HEAD"] })).stdout.trim(),
    status: (await runGit({
      cwd: project,
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    })).stdout,
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs} ms.`);
    await delay(25);
  }
}
