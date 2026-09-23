import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { captureGitBaseline } from "./support/git-fixture.js";
import { runGit } from "./support/git-fixture.js";
import { IntegrationManager } from "./support/git-fixture.js";
import { VerificationWorkspaceManager } from "./support/git-fixture.js";

test("creates a detached verification worktree at the exact integration revision", async () => {
  const fixture = await createFixture(
    "create exact",
    "run/long verification id with spaces & punctuation " + "x".repeat(80),
  );
  const commands: string[][] = [];
  const manager = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
    execute: async (options) => {
      commands.push([...options.args]);
      return await runGit(options);
    },
  });

  try {
    const projectBefore = await projectState(fixture.project);
    const workspace = await manager.create();
    assert.equal(workspace.targetRevision, fixture.integration.revision);
    assert.equal(await gitText(workspace.path, ["rev-parse", "HEAD"]), fixture.integration.revision);
    assert.notEqual(
      (await runGit({
        cwd: workspace.path,
        args: ["symbolic-ref", "--quiet", "HEAD"],
        allowFailure: true,
      })).exitCode,
      0,
    );
    assert.equal(relative(fixture.state, workspace.path).startsWith(".."), false);
    assert.equal(relative(fixture.project, workspace.path).startsWith(".."), true);
    assert.ok(workspace.path.split(/[\\/]/).at(-1)!.length <= 24);

    const metadata = JSON.parse(readFileSync(workspace.metadataPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(metadata, {
      version: 1,
      kind: "final-verification",
      runId: fixture.runId,
      workspaceId: workspace.workspaceId,
      path: workspace.path,
      repositoryRoot: fixture.project,
      targetRevision: fixture.integration.revision,
      canonicalRevision: projectBefore.revision,
    });
    assert.deepEqual(await projectState(fixture.project), projectBefore);
    assert.equal(
      commands.some((args) =>
        args[0] === "worktree" &&
        args[1] === "add" &&
        args.includes("--detach") &&
        args.includes(workspace.path) &&
        args.includes(fixture.integration.revision)
      ),
      true,
    );
  } finally {
    await manager.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("independent verifier owns a clean workspace separate from final verification", async () => {
  const fixture = await createFixture("independent-verifier");
  const finalManager = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  const verifierManager = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
    kind: "independent-verifier",
  });
  try {
    const finalWorkspace = await finalManager.create();
    writeFileSync(join(finalWorkspace.path, "generated-by-tests.txt"), "dirty\n");
    const verifierWorkspace = await verifierManager.create();

    assert.notEqual(verifierWorkspace.path, finalWorkspace.path);
    assert.equal(existsSync(join(verifierWorkspace.path, "generated-by-tests.txt")), false);
    assert.equal(
      await gitText(verifierWorkspace.path, ["rev-parse", "HEAD"]),
      fixture.integration.revision
    );
    const metadata = JSON.parse(
      readFileSync(verifierWorkspace.metadataPath, "utf8")
    ) as Record<string, unknown>;
    assert.equal(metadata.kind, "independent-verifier");
  } finally {
    await verifierManager.cleanup().catch(() => undefined);
    await finalManager.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("reopens the same valid workspace and rejects dirty or wrong-revision workspaces", async () => {
  const fixture = await createFixture("reopen");
  const manager = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  try {
    const created = await manager.create();
    assert.deepEqual(await manager.reopen(), created);
    const recovered = new VerificationWorkspaceManager({
      repositoryRoot: fixture.project,
      stateDirectory: fixture.state,
      runId: fixture.runId,
      targetRevision: fixture.integration.revision,
    });
    assert.deepEqual(await recovered.create(), created);

    writeFileSync(join(created.path, "verification-output.txt"), "generated\n");
    await assert.rejects(
      () => recovered.reopen(),
      /verification workspace.*dirty/i,
    );
    assert.deepEqual(await recovered.resumeForNextCheck(), created);
    writeFileSync(join(fixture.project, "canonical-mutation.txt"), "unsafe\n");
    await assert.rejects(
      () => recovered.resumeForNextCheck(),
      /canonical.*dirty/i,
    );
    rmSync(join(fixture.project, "canonical-mutation.txt"), { force: true });
    rmSync(join(created.path, "verification-output.txt"), { force: true });

    await runGit({ cwd: created.path, args: ["reset", "--hard", "HEAD"] });
    writeFileSync(join(created.path, "wrong-revision.txt"), "wrong\n");
    await runGit({ cwd: created.path, args: ["add", "wrong-revision.txt"] });
    await runGit({
      cwd: created.path,
      args: ["commit", "-m", "Wrong verification revision"],
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    await assert.rejects(
      () => recovered.reopen(),
      /target revision/i,
    );
  } finally {
    await manager.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("rejects a symlink, path escape, and unexpected existing verification directory", async () => {
  const fixture = await createFixture("containment");
  const manager = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  try {
    mkdirSync(dirname(manager.path), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "aiboard-verification-outside-"));
    try {
      symlinkSync(outside, manager.path, "junction");
      await assert.rejects(() => manager.create(), /symlink|symbolic|ownership/i);
    } finally {
      rmSync(manager.path, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }

    mkdirSync(manager.path, { recursive: true });
    writeFileSync(join(manager.path, "unexpected.txt"), "do not remove\n");
    await assert.rejects(() => manager.create(), /unexpected.*directory|ownership/i);
    assert.equal(existsSync(join(manager.path, "unexpected.txt")), true);
    rmSync(manager.path, { recursive: true, force: true });

    const projectStateManager = new VerificationWorkspaceManager({
      repositoryRoot: fixture.project,
      stateDirectory: join(fixture.project, "runner state inside checkout"),
      runId: "run_escape",
      targetRevision: fixture.integration.revision,
    });
    await assert.rejects(
      () => projectStateManager.create(),
      /state directory.*project|outside.*checkout/i,
    );
  } finally {
    await manager.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("refuses a dirty canonical checkout before creating verification state", async () => {
  const fixture = await createFixture("dirty-canonical");
  const manager = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  try {
    writeFileSync(join(fixture.project, "user-change.txt"), "preserve me\n");
    await assert.rejects(
      () => manager.create(),
      /canonical.*checkout.*dirty|canonical.*dirty/i,
    );
    assert.equal(existsSync(manager.path), false);
  } finally {
    await closeFixture(fixture);
  }
});

test("baseline suffix isolates an independent-verifier worktree at a different revision", async () => {
  const fixture = await createFixture("baseline-suffix");
  const baselineRevision = await gitText(fixture.project, ["rev-parse", "HEAD"]);
  writeFileSync(join(fixture.project, "second.txt"), "second\n");
  await runGit({ cwd: fixture.project, args: ["add", "second.txt"] });
  await runGit({ cwd: fixture.project, args: ["commit", "-m", "Second revision"] });
  const integrationRevision = await gitText(fixture.project, ["rev-parse", "HEAD"]);
  assert.notEqual(baselineRevision, integrationRevision);

  const integrationManager = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    kind: "independent-verifier",
    targetRevision: integrationRevision,
  });
  const baselineManager = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    kind: "independent-verifier",
    workspaceSuffix: "baseline",
    targetRevision: baselineRevision,
  });
  try {
    const integrationWorkspace = await integrationManager.create();
    const baselineWorkspace = await baselineManager.create();
    assert.notEqual(baselineWorkspace.path, integrationWorkspace.path);
    assert.notEqual(baselineWorkspace.metadataPath, integrationWorkspace.metadataPath);
    const integrationMetadata = JSON.parse(readFileSync(integrationWorkspace.metadataPath, "utf8")) as {
      targetRevision: string;
    };
    const baselineMetadata = JSON.parse(readFileSync(baselineWorkspace.metadataPath, "utf8")) as {
      targetRevision: string;
    };
    assert.equal(integrationMetadata.targetRevision, integrationRevision);
    assert.equal(baselineMetadata.targetRevision, baselineRevision);
    assert.equal(await gitText(integrationWorkspace.path, ["rev-parse", "HEAD"]), integrationRevision);
    assert.equal(await gitText(baselineWorkspace.path, ["rev-parse", "HEAD"]), baselineRevision);

    await baselineManager.cleanup();
    assert.equal(existsSync(baselineWorkspace.path), false);
    assert.equal(existsSync(baselineWorkspace.metadataPath), false);
    assert.equal(existsSync(integrationWorkspace.path), true);
    assert.equal(existsSync(integrationWorkspace.metadataPath), true);
    assert.equal(await gitText(integrationWorkspace.path, ["rev-parse", "HEAD"]), integrationRevision);
  } finally {
    await baselineManager.cleanup().catch(() => undefined);
    await integrationManager.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("cleanup removes only the owned verification worktree and preserves integration history", async () => {
  const fixture = await createFixture("cleanup");
  const manager = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  try {
    const workspace = await manager.create();
    const integrationPath = fixture.integration.path;
    const integrationRevision = fixture.integration.revision;
    const integrationHistory = await fixture.integration.history();
    const projectBefore = await projectState(fixture.project);
    writeFileSync(join(workspace.path, "generated.txt"), "temporary\n");

    await manager.cleanup();

    assert.equal(existsSync(workspace.path), false);
    assert.equal(existsSync(workspace.metadataPath), false);
    assert.equal(existsSync(integrationPath), true);
    assert.equal(fixture.integration.revision, integrationRevision);
    assert.deepEqual(await fixture.integration.history(), integrationHistory);
    assert.deepEqual(await projectState(fixture.project), projectBefore);
    assert.equal(
      (await gitText(fixture.project, ["worktree", "list", "--porcelain"])).includes(workspace.path),
      false,
    );

    await manager.cleanup();
    assert.equal(existsSync(workspace.path), false);
  } finally {
    await closeFixture(fixture);
  }
});

interface Fixture {
  root: string;
  project: string;
  state: string;
  runId: string;
  integration: IntegrationManager;
}

async function createFixture(name: string, runId = `run_${name}`): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-verification-${name}-`));
  const project = join(root, "user checkout");
  const state = join(root, "runner state & data");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "README.md"), "baseline\n");
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

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await runGit({ cwd, args })).stdout.trim();
}

async function projectState(project: string): Promise<{ revision: string; status: string }> {
  return {
    revision: await gitText(project, ["rev-parse", "HEAD"]),
    status: await gitText(project, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  };
}
