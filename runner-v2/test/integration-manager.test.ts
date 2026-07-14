import assert from "node:assert/strict";
import {
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import { ArtifactStore } from "../src/artifact-store.js";
import { createChangeSet } from "../src/change-set.js";
import { captureGitBaseline } from "../src/git-baseline.js";
import { runGit } from "../src/git-command.js";
import type { GitRunner } from "../src/git-repository.js";
import { IntegrationManager } from "../src/integration-manager.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

test("change sets integrate serially and retries do not duplicate commits", async () => {
  const fixture = await createFixture("ordered");
  try {
    const alphaWorkspace = await fixture.workspaces.createTaskWorkspace("alpha");
    const betaWorkspace = await fixture.workspaces.createTaskWorkspace("beta");
    writeFileSync(join(alphaWorkspace.path, "alpha.txt"), "alpha\n");
    writeFileSync(join(betaWorkspace.path, "beta.txt"), "beta\n");
    const alphaCommit = await fixture.workspaces.commitTask("alpha", "Add alpha");
    const betaCommit = await fixture.workspaces.commitTask("beta", "Add beta");
    await assert.rejects(
      () => createChangeSet({
        workspacePath: alphaWorkspace.path,
        taskCommit: alphaCommit,
        artifacts: fixture.artifacts,
      }),
      /durable evidence/i
    );
    const alpha = await createChangeSet({
      workspacePath: alphaWorkspace.path,
      taskCommit: alphaCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    const beta = await createChangeSet({
      workspacePath: betaWorkspace.path,
      taskCommit: betaCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
      unresolvedConcerns: ["None"],
    });
    assert.match((await fixture.artifacts.get(alpha.diffArtifactHash)).toString(), /alpha\.txt/);

    const first = await fixture.integration.integrate(alpha);
    assert.equal(first.status, "integrated");
    const repeated = await fixture.integration.integrate(alpha);
    assert.deepEqual(repeated, first);

    const appliedRefs = (
      await gitText(fixture.project, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/aiboard/runs",
      ])
    )
      .split("\n")
      .filter((ref) => ref.includes("/integrated/"));
    assert.equal(appliedRefs.length, 1);
    await runGit({
      cwd: fixture.project,
      args: ["update-ref", "-d", appliedRefs[0]],
    });
    const recoveredManager = new IntegrationManager({
      repositoryRoot: fixture.project,
      stateDirectory: fixture.state,
      runId: "run_ordered",
      baselineRevision: fixture.baseline.revision,
    });
    await recoveredManager.initialize();
    const recovered = await recoveredManager.integrate(alpha);
    assert.deepEqual(recovered, first);
    assert.equal(
      await gitText(fixture.integration.path, [
        "rev-list",
        "--count",
        `${fixture.baseline.revision}..HEAD`,
      ]),
      "1"
    );

    const second = await fixture.integration.integrate(beta);
    assert.equal(second.status, "integrated");
    assert.notEqual(second.integrationRevision, first.integrationRevision);
    const history = await fixture.integration.history(10);
    assert.equal(history[0].revision, second.integrationRevision);
    assert.match(history[0].subject, /Add beta/);
    assert.equal(history.some((commit) => commit.revision === first.integrationRevision), true);
    assert.equal(
      readFileSync(join(fixture.integration.path, "alpha.txt"), "utf8").trim(),
      "alpha"
    );
    assert.equal(
      readFileSync(join(fixture.integration.path, "beta.txt"), "utf8").trim(),
      "beta"
    );
    assert.equal(readFileSync(join(fixture.project, "shared.txt"), "utf8"), "baseline\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("integration conflicts are mechanical results and leave canonical integration clean", async () => {
  const fixture = await createFixture("conflict");
  try {
    const firstWorkspace = await fixture.workspaces.createTaskWorkspace("first");
    const secondWorkspace = await fixture.workspaces.createTaskWorkspace("second");
    writeFileSync(join(firstWorkspace.path, "shared.txt"), "first\n");
    writeFileSync(join(secondWorkspace.path, "shared.txt"), "second\n");
    const firstCommit = await fixture.workspaces.commitTask("first", "First version");
    const secondCommit = await fixture.workspaces.commitTask("second", "Second version");
    const first = await createChangeSet({
      workspacePath: firstWorkspace.path,
      taskCommit: firstCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    const second = await createChangeSet({
      workspacePath: secondWorkspace.path,
      taskCommit: secondCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    const integrated = await fixture.integration.integrate(first);
    assert.equal(integrated.status, "integrated");
    const revisionBefore = fixture.integration.revision;
    const conflict = await fixture.integration.integrate(second);
    assert.equal(conflict.status, "conflict");
    assert.deepEqual(conflict.conflictPaths, ["shared.txt"]);
    assert.equal(fixture.integration.revision, revisionBefore);
    assert.equal(
      readFileSync(join(fixture.integration.path, "shared.txt"), "utf8").trim(),
      "first"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a later attempt can integrate from the current integration revision", async () => {
  const fixture = await createFixture("attempt-base");
  try {
    const firstWorkspace = await fixture.workspaces.createTaskWorkspace("first");
    writeFileSync(join(firstWorkspace.path, "first.txt"), "integrated first\n");
    const firstCommit = await fixture.workspaces.commitTask("first", "Add first");
    const firstChangeSet = await createChangeSet({
      workspacePath: firstWorkspace.path,
      taskCommit: firstCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    const first = await fixture.integration.integrate(firstChangeSet);
    assert.equal(first.status, "integrated");

    const retryWorkspace = await fixture.workspaces.createTaskWorkspace("retry", {
      workspaceId: "retry:attempt:2",
      baselineRevision: first.integrationRevision,
    });
    assert.equal(
      readFileSync(join(retryWorkspace.path, "first.txt"), "utf8").trim(),
      "integrated first"
    );
    writeFileSync(join(retryWorkspace.path, "retry.txt"), "fresh retry\n");
    const retryCommit = await fixture.workspaces.commitWorkspace(
      retryWorkspace,
      "Add retry"
    );
    const retryChangeSet = await createChangeSet({
      workspacePath: retryWorkspace.path,
      taskCommit: retryCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    const integrated = await fixture.integration.integrate(retryChangeSet);
    assert.equal(integrated.status, "integrated");
    assert.equal(
      readFileSync(join(fixture.integration.path, "retry.txt"), "utf8").trim(),
      "fresh retry"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("evidence-backed no-change tasks integrate without fabricating commits", async () => {
  const fixture = await createFixture("no-change");
  try {
    const workspace = await fixture.workspaces.createTaskWorkspace("inspection");
    const evidence = await fixture.artifacts.put(
      Buffer.from("inspection passed"),
      "text/plain",
      "Inspection evidence"
    );
    const taskCommit = {
      runId: "run_no-change",
      taskId: "inspection",
      revision: fixture.baseline.revision,
      baselineRevision: fixture.baseline.revision,
      commits: [],
      changedPaths: [],
    };
    await assert.rejects(
      () => createChangeSet({
        workspacePath: workspace.path,
        taskCommit,
        artifacts: fixture.artifacts,
      }),
      /durable evidence/i
    );
    const changeSet = await createChangeSet({
      workspacePath: workspace.path,
      taskCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [evidence.hash],
    });
    assert.deepEqual(changeSet.commits, []);
    const before = fixture.integration.revision;
    const result = await fixture.integration.integrate(changeSet);
    assert.equal(result.status, "integrated");
    assert.equal(result.integrationRevision, before);
    assert.deepEqual(result.changedPaths, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("final handoff applies the integrated diff only after a successful dry run", async () => {
  const fixture = await createFixture("handoff-apply");
  try {
    const projectBefore = await gitText(fixture.project, ["rev-parse", "HEAD"]);
    const workspace = await fixture.workspaces.createTaskWorkspace("feature");
    writeFileSync(join(workspace.path, "feature.txt"), "integrated\n");
    writeFileSync(join(workspace.path, "binary.bin"), Buffer.from([0, 1, 2, 255]));
    const taskCommit = await fixture.workspaces.commitTask("feature", "Add feature");
    const changeSet = await createChangeSet({
      workspacePath: workspace.path,
      taskCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    await fixture.integration.integrate(changeSet);

    const result = await fixture.integration.applyToProject();
    assert.equal(result.appliedToProject, true);
    assert.equal(result.integrationRevision, fixture.integration.revision);
    assert.match(result.integrationBranch, /^aiboard\//);
    assert.ok(result.projectRevision);
    assert.notEqual(result.projectRevision, projectBefore);
    assert.equal(
      await gitText(fixture.project, ["rev-parse", "HEAD"]),
      result.projectRevision
    );
    assert.equal(
      await gitText(fixture.project, [
        "rev-list",
        "--count",
        `${projectBefore}..HEAD`,
      ]),
      "1"
    );
    assert.equal(
      await gitText(fixture.project, [
        "diff",
        "--name-only",
        "HEAD",
        result.integrationRevision,
      ]),
      ""
    );
    assert.equal(await gitText(fixture.project, ["status", "--porcelain=v1"]), "");
    assert.match(
      await gitText(fixture.project, [
        "show",
        "-s",
        "--format=%an <%ae>%n%cn <%ce>%n%B",
        "HEAD",
      ]),
      new RegExp(
        `^AIBoard Integrator <integrator@aiboard\\.local>\\n` +
        `AIBoard Integrator <integrator@aiboard\\.local>\\n` +
        `Apply completed AIBoard build\\n\\n` +
        `AIBoard-Run: run_handoff-apply\\n` +
        `AIBoard-Integration: ${result.integrationRevision}\\n` +
        `AIBoard-Transition: [0-9a-f-]{36}$`
      )
    );
    assert.equal(
      readFileSync(join(fixture.project, "feature.txt"), "utf8").trim(),
      "integrated"
    );
    assert.deepEqual(
      readFileSync(join(fixture.project, "binary.bin")),
      Buffer.from([0, 1, 2, 255])
    );
    const replay = await fixture.integration.applyToProject();
    assert.equal(replay.projectRevision, result.projectRevision);
    assert.equal(await gitText(fixture.project, ["rev-parse", "HEAD"]), result.projectRevision);
    assert.equal(
      await gitText(fixture.project, ["rev-list", "--count", `${projectBefore}..HEAD`]),
      "1"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("final handoff rejects dirty projects without changing their worktree, index, or revision", async () => {
  const fixture = await createFixture("handoff-dirty");
  try {
    const workspace = await fixture.workspaces.createTaskWorkspace("feature");
    writeFileSync(join(workspace.path, "shared.txt"), "integrated\n");
    const taskCommit = await fixture.workspaces.commitTask("feature", "Change shared");
    const changeSet = await createChangeSet({
      workspacePath: workspace.path,
      taskCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    await fixture.integration.integrate(changeSet);
    writeFileSync(join(fixture.project, "shared.txt"), "user changed this\n");
    writeFileSync(join(fixture.project, "staged.txt"), "staged by user\n");
    await runGit({ cwd: fixture.project, args: ["add", "staged.txt"] });
    writeFileSync(join(fixture.project, "untracked.txt"), "untracked by user\n");
    const before = await projectState(fixture.project);

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /clean project worktree and index/i
    );
    assert.deepEqual(await projectState(fixture.project), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a fresh manager repairs the exact journaled post-ref crash state", async () => {
  const fixture = await createFixture("handoff-crash-repair");
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const applied = await fixture.integration.applyToProject();
    const target = applied.projectRevision!;
    const parent = await gitText(fixture.project, ["rev-parse", `${target}^`]);
    const branch = await gitText(fixture.project, ["symbolic-ref", "HEAD"]);
    await writeApplyJournal(fixture, { branch, parent, target });
    await runGit({ cwd: fixture.project, args: ["read-tree", "--reset", "-u", parent] });

    const recovered = freshIntegration(fixture);
    const result = await recovered.applyToProject();
    assert.equal(result.projectRevision, target);
    assert.equal(readFileSync(join(fixture.project, "feature.txt"), "utf8").trim(), "integrated");
    assert.equal(await gitText(fixture.project, ["status", "--porcelain=v1"]), "");
    assert.equal(existsSync(applyJournalPath(fixture)), false);

    const repeated = freshIntegration(fixture);
    assert.equal((await repeated.applyToProject()).projectRevision, target);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the real apply path leaves a recoverable journal when the process dies after update-ref", async () => {
  const fixture = await createFixture("handoff-real-crash");
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    let journalExistedBeforeRef = false;
    const execute: GitRunner = async (options) => {
      if (
        options.args[0] === "update-ref" &&
        options.args[1]?.startsWith("refs/heads/") &&
        options.args.length === 4
      ) {
        journalExistedBeforeRef = applyJournalPaths(fixture).length === 1;
      }
      return await runGit(options);
    };
    const crashing = freshIntegration(fixture, {
      execute,
      afterProjectRefAdvanced: async () => {
        throw new Error("simulated abrupt process termination");
      },
    });
    await crashing.initialize();

    await assert.rejects(
      () => crashing.applyToProject(),
      /simulated abrupt process termination/i
    );
    assert.equal(journalExistedBeforeRef, true, "the durable journal precedes the ref CAS");
    assert.equal(applyJournalPaths(fixture).length, 1);
    const target = await gitText(fixture.project, ["rev-parse", "HEAD"]);
    assert.equal(existsSync(join(fixture.project, "feature.txt")), false);

    const recovered = freshIntegration(fixture);
    await recovered.initialize();
    assert.equal((await recovered.applyToProject()).projectRevision, target);
    assert.equal(readFileSync(join(fixture.project, "feature.txt"), "utf8").trim(), "integrated");
    assert.equal(applyJournalPaths(fixture).length, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("crash recovery never overwrites an ignored untracked target path", async () => {
  const fixture = await createFixture("handoff-ignored-crash");
  try {
    writeFileSync(join(fixture.project, ".gitignore"), "secret.txt\n");
    await runGit({ cwd: fixture.project, args: ["add", ".gitignore"] });
    await runGit({ cwd: fixture.project, args: ["commit", "-m", "Ignore secret"] });
    await integrateFeature(fixture, "secret.txt", "integrated secret\n");
    const crashing = freshIntegration(fixture, {
      afterProjectRefAdvanced: async () => {
        writeFileSync(join(fixture.project, "secret.txt"), "user secret\n");
        throw new Error("simulated abrupt process termination");
      },
    });
    await crashing.initialize();

    await assert.rejects(() => crashing.applyToProject(), /simulated abrupt/i);
    const before = readFileSync(join(fixture.project, "secret.txt"), "utf8");
    const recovered = freshIntegration(fixture);
    await recovered.initialize();
    await assert.rejects(
      () => recovered.applyToProject(),
      /journaled automatic handoff.*unrelated|cannot be recovered safely/i
    );
    assert.equal(readFileSync(join(fixture.project, "secret.txt"), "utf8"), before);
    assert.equal(applyJournalPaths(fixture).length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the live checkout rechecks ignored target paths after advancing the ref", async () => {
  const fixture = await createFixture("handoff-ignored-race");
  try {
    writeFileSync(join(fixture.project, ".gitignore"), "secret.txt\n");
    await runGit({ cwd: fixture.project, args: ["add", ".gitignore"] });
    await runGit({ cwd: fixture.project, args: ["commit", "-m", "Ignore secret"] });
    const parent = await gitText(fixture.project, ["rev-parse", "HEAD"]);
    await integrateFeature(fixture, "secret.txt", "integrated secret\n");
    const racing = freshIntegration(fixture, {
      afterProjectRefAdvanced: () => {
        writeFileSync(join(fixture.project, "secret.txt"), "user secret\n");
      },
    });
    await racing.initialize();

    await assert.rejects(
      () => racing.applyToProject(),
      /overwrite.*untracked|untracked or ignored/i
    );
    assert.equal(await gitText(fixture.project, ["rev-parse", "HEAD"]), parent);
    assert.equal(readFileSync(join(fixture.project, "secret.txt"), "utf8"), "user secret\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("concurrent managers cannot delete the winning post-ref crash journal", async () => {
  const fixture = await createFixture("handoff-concurrent-journals");
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    let releaseWinner!: () => void;
    const winnerAdvanced = new Promise<void>((resolve) => { releaseWinner = resolve; });
    let releaseLoser!: () => void;
    const loserAttempted = new Promise<void>((resolve) => { releaseLoser = resolve; });
    let commitCount = 0;
    let releaseCommits!: () => void;
    const bothCommitsCreated = new Promise<void>((resolve) => { releaseCommits = resolve; });
    const createCommitTogether = async (options: Parameters<GitRunner>[0]) => {
      const result = await runGit(options);
      commitCount += 1;
      if (commitCount === 2) releaseCommits();
      await Promise.race([
        bothCommitsCreated,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error(`only ${commitCount} concurrent commit-tree calls arrived`)),
          5_000
        )),
      ]);
      return result;
    };
    const waitForTwoJournals = async (): Promise<boolean> => {
      const deadline = Date.now() + 2_000;
      while (applyJournalPaths(fixture).length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return applyJournalPaths(fixture).length === 2;
    };
    const winnerExecute: GitRunner = async (options) => {
      if (options.args[0] === "commit-tree") return await createCommitTogether(options);
      if (
        options.args[0] === "update-ref" &&
        options.args[1]?.startsWith("refs/heads/") &&
        options.args.length === 4
      ) {
        if (!await waitForTwoJournals()) {
          releaseWinner();
          releaseLoser();
          assert.fail(`each transition must own a journal: ${applyJournalPaths(fixture).join(", ")}`);
        }
        const result = await runGit(options);
        releaseWinner();
        return result;
      }
      return await runGit(options);
    };
    const loserExecute: GitRunner = async (options) => {
      if (options.args[0] === "commit-tree") return await createCommitTogether(options);
      if (
        options.args[0] === "update-ref" &&
        options.args[1]?.startsWith("refs/heads/") &&
        options.args.length === 4
      ) {
        if (!await waitForTwoJournals()) {
          releaseWinner();
          releaseLoser();
          assert.fail(`each transition must own a journal: ${applyJournalPaths(fixture).join(", ")}`);
        }
        await winnerAdvanced;
        const result = await runGit(options);
        releaseLoser();
        return result;
      }
      return await runGit(options);
    };
    const winner = freshIntegration(fixture, {
      execute: winnerExecute,
      afterProjectRefAdvanced: async () => {
        await loserAttempted;
        throw new Error("winner terminated before checkout");
      },
    });
    const loser = freshIntegration(fixture, { execute: loserExecute });
    await Promise.all([winner.initialize(), loser.initialize()]);

    const [winnerResult, loserResult] = await Promise.allSettled([
      winner.applyToProject(),
      loser.applyToProject(),
    ]);
    assert.equal(winnerResult.status, "rejected");
    assert.match(String((winnerResult as PromiseRejectedResult).reason), /winner terminated/i);
    assert.equal(loserResult.status, "rejected");
    assert.match(String((loserResult as PromiseRejectedResult).reason), /project changed/i);
    assert.equal(applyJournalPaths(fixture).length, 1, "only the winning journal survives");

    const target = await gitText(fixture.project, ["rev-parse", "HEAD"]);
    const recovered = freshIntegration(fixture);
    await recovered.initialize();
    assert.equal((await recovered.applyToProject()).projectRevision, target);
    assert.equal(readFileSync(join(fixture.project, "feature.txt"), "utf8").trim(), "integrated");
    assert.equal(applyJournalPaths(fixture).length, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("recovery retires an abandoned pre-CAS transition beside a crashed winner", async () => {
  const fixture = await createFixture("handoff-abandoned-and-winner");
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const abandoned = freshIntegration(fixture, {
      afterProjectApplyJournalWritten: async () => {
        throw new Error("abandoned before project ref CAS");
      },
    });
    await abandoned.initialize();
    await assert.rejects(() => abandoned.applyToProject(), /abandoned before/i);
    assert.equal(applyJournalPaths(fixture).length, 1);

    const winner = freshIntegration(fixture, {
      afterProjectRefAdvanced: async () => {
        throw new Error("winner terminated after project ref CAS");
      },
    });
    await winner.initialize();
    await assert.rejects(() => winner.applyToProject(), /winner terminated/i);
    assert.equal(applyJournalPaths(fixture).length, 2);
    const target = await gitText(fixture.project, ["rev-parse", "HEAD"]);
    assert.equal(existsSync(join(fixture.project, "feature.txt")), false);

    const recovered = freshIntegration(fixture);
    await recovered.initialize();
    assert.equal((await recovered.applyToProject()).projectRevision, target);
    assert.equal(readFileSync(join(fixture.project, "feature.txt"), "utf8").trim(), "integrated");
    assert.equal(applyJournalPaths(fixture).length, 0, "winner and abandoned journals retire");
    assert.equal(await handoffRefCount(fixture), 0, "transition ownership refs retire");
    assert.equal((await recovered.applyToProject()).projectRevision, target);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a standalone abandoned pre-CAS journal does not block the next apply", async () => {
  const fixture = await createFixture("handoff-standalone-abandoned");
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const abandoned = freshIntegration(fixture, {
      afterProjectApplyJournalWritten: async () => {
        throw new Error("standalone pre-CAS death");
      },
    });
    await abandoned.initialize();
    await assert.rejects(() => abandoned.applyToProject(), /standalone pre-CAS death/i);
    assert.equal(applyJournalPaths(fixture).length, 1);

    const replacement = freshIntegration(fixture);
    await replacement.initialize();
    const applied = await replacement.applyToProject();
    assert.ok(applied.projectRevision);
    assert.equal(readFileSync(join(fixture.project, "feature.txt"), "utf8").trim(), "integrated");
    assert.equal(applyJournalPaths(fixture).length, 0);
    assert.equal(await handoffRefCount(fixture), 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("retiring an abandoned transition resumes after its ownership ref was released", async () => {
  const fixture = await createFixture("handoff-retirement-resume");
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const abandoned = freshIntegration(fixture, {
      afterProjectApplyJournalWritten: async () => {
        throw new Error("die before project ref CAS");
      },
    });
    await abandoned.initialize();
    await assert.rejects(() => abandoned.applyToProject(), /die before project ref CAS/i);

    const journalPath = applyJournalPaths(fixture)[0]!;
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      state: string;
      expectedParent: string;
      transitionRef: string;
      retiringOwnershipRevision?: string;
    };
    journal.state = "retiring";
    journal.retiringOwnershipRevision = journal.expectedParent;
    Object.assign(journal, { retirementKind: "abandoned" });
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
    await runGit({
      cwd: fixture.project,
      args: ["update-ref", "-d", journal.transitionRef, journal.expectedParent],
    });

    const replacement = freshIntegration(fixture);
    await replacement.initialize();
    const applied = await replacement.applyToProject();
    assert.ok(applied.projectRevision);
    assert.equal(readFileSync(join(fixture.project, "feature.txt"), "utf8").trim(), "integrated");
    assert.equal(applyJournalPaths(fixture).length, 0);
    assert.equal(await handoffRefCount(fixture), 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("winner journal survives death after adjacent abandoned transitions retire", async () => {
  const fixture = await createFixture("handoff-winner-anchor");
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const abandoned = freshIntegration(fixture, {
      afterProjectApplyJournalWritten: async () => {
        throw new Error("leave adjacent abandoned transition");
      },
    });
    await abandoned.initialize();
    await assert.rejects(
      () => abandoned.applyToProject(),
      /leave adjacent abandoned transition/i
    );

    const winner = freshIntegration(fixture, {
      afterAbandonedProjectAppliesRetired: async () => {
        throw new Error("die before winning transition cleanup");
      },
    });
    await winner.initialize();
    await assert.rejects(
      () => winner.applyToProject(),
      /die before winning transition cleanup/i
    );
    const target = await gitText(fixture.project, ["rev-parse", "HEAD"]);
    assert.equal(readFileSync(join(fixture.project, "feature.txt"), "utf8").trim(), "integrated");
    assert.equal(applyJournalPaths(fixture).length, 1, "only the winning journal remains");
    assert.equal(await handoffRefCount(fixture), 1, "winning ownership remains durable");

    const recovered = freshIntegration(fixture);
    await recovered.initialize();
    assert.equal((await recovered.applyToProject()).projectRevision, target);
    assert.equal(applyJournalPaths(fixture).length, 0);
    assert.equal(await handoffRefCount(fixture), 0);
    assert.equal((await recovered.applyToProject()).projectRevision, target);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("winner cleanup resumes after death immediately after ownership release", async () => {
  const fixture = await createFixture("handoff-winner-release-death");
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const winner = freshIntegration(fixture, {
      afterProjectApplyOwnershipReleased: async ({
        expectedOwnershipRevision,
        targetCommit,
      }) => {
        if (expectedOwnershipRevision === targetCommit) {
          throw new Error("die after winning ownership release");
        }
      },
    });
    await winner.initialize();
    await assert.rejects(
      () => winner.applyToProject(),
      /die after winning ownership release/i
    );
    const target = await gitText(fixture.project, ["rev-parse", "HEAD"]);
    assert.equal(readFileSync(join(fixture.project, "feature.txt"), "utf8").trim(), "integrated");
    assert.equal(applyJournalPaths(fixture).length, 1);
    assert.equal(await handoffRefCount(fixture), 0, "ownership release completed before death");

    const recovered = freshIntegration(fixture);
    await recovered.initialize();
    assert.equal((await recovered.applyToProject()).projectRevision, target);
    assert.equal(applyJournalPaths(fixture).length, 0);
    assert.equal(await handoffRefCount(fixture), 0);
    assert.equal((await recovered.applyToProject()).projectRevision, target);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("winner classification survives branch-CAS death and cleanup-release death", async () => {
  const fixture = await createFixture("handoff-winner-parent-ownership");
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const branchCasCrash = freshIntegration(fixture, {
      afterProjectBranchAdvanced: async () => {
        throw new Error("die after branch CAS before ownership advance");
      },
    });
    await branchCasCrash.initialize();
    await assert.rejects(
      () => branchCasCrash.applyToProject(),
      /die after branch CAS before ownership advance/i
    );
    const target = await gitText(fixture.project, ["rev-parse", "HEAD"]);
    assert.equal(existsSync(join(fixture.project, "feature.txt")), false);
    assert.equal(applyJournalPaths(fixture).length, 1);
    assert.equal(await handoffRefCount(fixture), 1);

    const cleanupCrash = freshIntegration(fixture, {
      afterProjectApplyOwnershipReleased: async ({ retirementKind }) => {
        if (retirementKind === "winner") {
          throw new Error("die after parent ownership release during winner cleanup");
        }
      },
    });
    await cleanupCrash.initialize();
    await assert.rejects(
      () => cleanupCrash.applyToProject(),
      /die after parent ownership release during winner cleanup/i
    );
    assert.equal(readFileSync(join(fixture.project, "feature.txt"), "utf8").trim(), "integrated");
    assert.equal(applyJournalPaths(fixture).length, 1);
    assert.equal(await handoffRefCount(fixture), 0);

    const journalPath = applyJournalPaths(fixture)[0]!;
    const winnerJournal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    const parent = await gitText(fixture.project, ["rev-parse", `${target}^`]);
    assert.equal(winnerJournal.state, "retiring");
    assert.equal(winnerJournal.retirementKind, "winner");
    assert.equal(winnerJournal.winningRevision, target);
    assert.equal(winnerJournal.retiringOwnershipRevision, parent);

    writeFileSync(journalPath, `${JSON.stringify({
      ...winnerJournal,
      winningRevision: parent,
    })}\n`);
    await assert.rejects(
      () => freshIntegration(fixture).applyToProject(),
      /transition ownership metadata is invalid/i
    );

    const forgedLoser: Record<string, unknown> = {
      ...winnerJournal,
      retirementKind: "abandoned",
    };
    delete forgedLoser.winningRevision;
    writeFileSync(journalPath, `${JSON.stringify(forgedLoser)}\n`);
    await assert.rejects(
      () => freshIntegration(fixture).applyToProject(),
      /retiring abandoned transition unexpectedly became the project head/i
    );
    writeFileSync(journalPath, `${JSON.stringify(winnerJournal)}\n`);

    const recovered = freshIntegration(fixture);
    await recovered.initialize();
    assert.equal((await recovered.applyToProject()).projectRevision, target);
    assert.equal(applyJournalPaths(fixture).length, 0);
    assert.equal(await handoffRefCount(fixture), 0);
    assert.equal((await recovered.applyToProject()).projectRevision, target);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("journal recovery blocks mismatches and preserves post-crash user edits", async () => {
  const fixture = await createFixture("handoff-crash-mismatch");
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const applied = await fixture.integration.applyToProject();
    const target = applied.projectRevision!;
    const parent = await gitText(fixture.project, ["rev-parse", `${target}^`]);
    const branch = await gitText(fixture.project, ["symbolic-ref", "HEAD"]);
    await writeApplyJournal(fixture, { branch, parent, target });
    await runGit({ cwd: fixture.project, args: ["read-tree", "--reset", "-u", parent] });
    writeFileSync(join(fixture.project, "user-after-crash.txt"), "preserve me\n");
    const before = await projectState(fixture.project);

    await assert.rejects(
      () => freshIntegration(fixture).applyToProject(),
      /journaled automatic handoff.*does not match|cannot be recovered safely/i
    );
    assert.deepEqual(await projectState(fixture.project), before);
    assert.equal(readFileSync(join(fixture.project, "user-after-crash.txt"), "utf8"), "preserve me\n");
    assert.equal(existsSync(applyJournalPath(fixture)), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("journal recovery never mutates a branch whose ref moved elsewhere", async () => {
  const fixture = await createFixture("handoff-crash-ref-moved");
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const applied = await fixture.integration.applyToProject();
    const target = applied.projectRevision!;
    const parent = await gitText(fixture.project, ["rev-parse", `${target}^`]);
    const branch = await gitText(fixture.project, ["symbolic-ref", "HEAD"]);
    await writeApplyJournal(fixture, { branch, parent, target });
    const alternate = (await runGit({
      cwd: fixture.project,
      args: [
        "commit-tree",
        `${parent}^{tree}`,
        "-p",
        parent,
        "-m",
        "Unrelated ref movement",
      ],
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@example.com",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@example.com",
      },
    })).stdout.trim();
    await runGit({ cwd: fixture.project, args: ["update-ref", branch, alternate, target] });
    await runGit({ cwd: fixture.project, args: ["read-tree", "--reset", "-u", alternate] });
    const before = await projectState(fixture.project);

    await assert.rejects(
      () => freshIntegration(fixture).applyToProject(),
      /project ref moved/i
    );
    assert.deepEqual(await projectState(fixture.project), before);
    assert.equal(existsSync(applyJournalPath(fixture)), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("normal success clears its apply journal and unjournaled dirty state stays blocked", async () => {
  const fixture = await createFixture("handoff-journal-lifecycle");
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const result = await fixture.integration.applyToProject();
    assert.ok(result.projectRevision);
    assert.equal(existsSync(applyJournalPath(fixture)), false);

    writeFileSync(join(fixture.project, "user.txt"), "unrelated\n");
    const before = await projectState(fixture.project);
    await assert.rejects(
      () => freshIntegration(fixture).applyToProject(),
      /clean project worktree and index/i
    );
    assert.deepEqual(await projectState(fixture.project), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("final handoff rejects a detached project without changing it", async () => {
  const fixture = await createFixture("handoff-detached");
  try {
    const workspace = await fixture.workspaces.createTaskWorkspace("feature");
    writeFileSync(join(workspace.path, "feature.txt"), "integrated\n");
    const taskCommit = await fixture.workspaces.commitTask("feature", "Add feature");
    const changeSet = await createChangeSet({
      workspacePath: workspace.path,
      taskCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    await fixture.integration.integrate(changeSet);
    await runGit({ cwd: fixture.project, args: ["checkout", "--detach", "HEAD"] });
    const before = await projectState(fixture.project);

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /named branch/i
    );
    assert.deepEqual(await projectState(fixture.project), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("final handoff conflicts leave a clean project branch unchanged", async () => {
  const fixture = await createFixture("handoff-conflict");
  try {
    const workspace = await fixture.workspaces.createTaskWorkspace("feature");
    writeFileSync(join(workspace.path, "shared.txt"), "integrated\n");
    const taskCommit = await fixture.workspaces.commitTask("feature", "Change shared");
    const changeSet = await createChangeSet({
      workspacePath: workspace.path,
      taskCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    await fixture.integration.integrate(changeSet);
    writeFileSync(join(fixture.project, "shared.txt"), "user committed this\n");
    await runGit({ cwd: fixture.project, args: ["add", "shared.txt"] });
    await runGit({
      cwd: fixture.project,
      args: ["commit", "-m", "User change"],
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    const before = await projectState(fixture.project);

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /cannot be applied safely/i
    );
    assert.deepEqual(await projectState(fixture.project), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed project commit rolls back only the Runner patch", async () => {
  const execute: GitRunner = async (options) => {
    if (
      (options.args[0] === "commit" || options.args[0] === "commit-tree") &&
      options.env?.GIT_AUTHOR_NAME === "AIBoard Integrator"
    ) {
      writeFileSync(join(options.cwd, "user-during-commit.txt"), "preserve me\n");
      return { exitCode: 1, stdout: "", stderr: "commit rejected" };
    }
    return await runGit(options);
  };
  const fixture = await createFixture("handoff-rollback", execute);
  try {
    const workspace = await fixture.workspaces.createTaskWorkspace("feature");
    writeFileSync(join(workspace.path, "feature.txt"), "integrated\n");
    const taskCommit = await fixture.workspaces.commitTask("feature", "Add feature");
    const changeSet = await createChangeSet({
      workspacePath: workspace.path,
      taskCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    await fixture.integration.integrate(changeSet);
    const beforeRevision = await gitText(fixture.project, ["rev-parse", "HEAD"]);

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /could not be committed[\s\S]*commit rejected/i
    );
    assert.equal(
      await gitText(fixture.project, ["rev-parse", "HEAD"]),
      beforeRevision
    );
    assert.equal(existsSync(join(fixture.project, "feature.txt")), false);
    assert.equal(
      readFileSync(join(fixture.project, "user-during-commit.txt"), "utf8"),
      "preserve me\n"
    );
    assert.equal(
      (await runGit({
        cwd: fixture.project,
        args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      })).stdout,
      "?? user-during-commit.txt\u0000"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("concurrent staged user changes are not swept into the AIBoard commit", async () => {
  let raced = false;
  const execute: GitRunner = async (options) => {
    if (
      !raced &&
      (options.args[0] === "commit" || options.args[0] === "commit-tree") &&
      options.env?.GIT_AUTHOR_NAME === "AIBoard Integrator"
    ) {
      raced = true;
      writeFileSync(join(options.cwd, "user-staged.txt"), "user staged\n");
      await runGit({ cwd: options.cwd, args: ["add", "user-staged.txt"] });
    }
    return await runGit(options);
  };
  const fixture = await createFixture("handoff-stage-race", execute);
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const beforeRevision = await gitText(fixture.project, ["rev-parse", "HEAD"]);

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /project changed during automatic handoff/i
    );
    assert.equal(await gitText(fixture.project, ["rev-parse", "HEAD"]), beforeRevision);
    assert.equal(existsSync(join(fixture.project, "feature.txt")), false);
    assert.equal(
      (await runGit({ cwd: fixture.project, args: ["diff", "--cached", "--name-only"] }))
        .stdout.trim(),
      "user-staged.txt"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a concurrent project commit wins the branch compare-and-swap", async () => {
  let raced = false;
  const execute: GitRunner = async (options) => {
    if (
      !raced &&
      (options.args[0] === "commit" || options.args[0] === "commit-tree") &&
      options.env?.GIT_AUTHOR_NAME === "AIBoard Integrator"
    ) {
      raced = true;
      writeFileSync(join(options.cwd, "user-commit.txt"), "user commit\n");
      await runGit({ cwd: options.cwd, args: ["add", "user-commit.txt"] });
      await runGit({
        cwd: options.cwd,
        args: ["commit", "-m", "Concurrent user commit"],
        env: {
          GIT_AUTHOR_NAME: "User",
          GIT_AUTHOR_EMAIL: "user@example.com",
          GIT_COMMITTER_NAME: "User",
          GIT_COMMITTER_EMAIL: "user@example.com",
        },
      });
    }
    return await runGit(options);
  };
  const fixture = await createFixture("handoff-ref-race", execute);
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const beforeRevision = await gitText(fixture.project, ["rev-parse", "HEAD"]);

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /project changed during automatic handoff/i
    );
    assert.notEqual(await gitText(fixture.project, ["rev-parse", "HEAD"]), beforeRevision);
    assert.equal(
      await gitText(fixture.project, ["show", "-s", "--format=%s", "HEAD"]),
      "Concurrent user commit"
    );
    assert.equal(existsSync(join(fixture.project, "feature.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a thrown commit executor leaves the project unchanged", async () => {
  const execute: GitRunner = async (options) => {
    if (
      (options.args[0] === "commit" || options.args[0] === "commit-tree") &&
      options.env?.GIT_AUTHOR_NAME === "AIBoard Integrator"
    ) {
      throw new Error("executor exploded");
    }
    return await runGit(options);
  };
  const fixture = await createFixture("handoff-throw", execute);
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const before = await projectState(fixture.project);

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /executor exploded/i
    );
    assert.deepEqual(await projectState(fixture.project), before);
    assert.equal(existsSync(join(fixture.project, "feature.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("files returns bounded tracked UTF-8 content from the integration revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-integration-files-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "00-readable.txt"), "hello, revision\n");
  writeFileSync(join(project, "01-binary.bin"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(project, "02-oversized.txt"), "x".repeat(1024 * 1024 + 1));
  writeFileSync(join(project, "03-valid-replacement.txt"), "kept \uFFFD\n");
  writeFileSync(join(project, "04-invalid-utf8.txt"), Buffer.from([0xc3, 0x28]));
  for (let index = 0; index < 11; index += 1) {
    writeFileSync(
      join(project, `budget-${String(index).padStart(2, "0")}.txt`),
      "b".repeat(1024 * 1024)
    );
  }
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_files",
    });
    const integration = new IntegrationManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_files",
      baselineRevision: baseline.revision,
    });
    await integration.initialize();

    const snapshot = await integration.files("integration");

    assert.equal(snapshot.source, "integration");
    assert.equal(snapshot.revision, integration.revision);
    assert.equal(snapshot.appliedToProject, false);
    assert.deepEqual(
      snapshot.files.find((file) => file.path === "00-readable.txt"),
      { path: "00-readable.txt", content: "hello, revision\n" }
    );
    assert.equal(snapshot.files.some((file) => file.path === "01-binary.bin"), false);
    assert.equal(
      snapshot.files.some((file) => file.path === "02-oversized.txt"),
      false
    );
    assert.deepEqual(
      snapshot.files.find((file) => file.path === "03-valid-replacement.txt"),
      { path: "03-valid-replacement.txt", content: "kept \uFFFD\n" }
    );
    assert.equal(
      snapshot.files.some((file) => file.path === "04-invalid-utf8.txt"),
      false
    );
    assert.equal(
      snapshot.files.some((file) => file.path === "budget-09.txt"),
      false
    );
    assert.equal(
      snapshot.files.some((file) => file.path === "budget-10.txt"),
      false
    );
    assert.equal(snapshot.omittedFileCount, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("files budgets the serialized JSON envelope including control-character escaping", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-integration-json-budget-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "control-a.txt"), Buffer.alloc(1024 * 1024, 1));
  writeFileSync(join(project, "control-b.txt"), Buffer.alloc(1024 * 1024, 1));
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_json_budget",
    });
    const integration = new IntegrationManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_json_budget",
      baselineRevision: baseline.revision,
    });
    await integration.initialize();

    const snapshot = await integration.files("integration");

    assert.equal(
      snapshot.files.filter((file) => file.path.startsWith("control-")).length,
      1
    );
    assert.equal(snapshot.omittedFileCount, 1);
    assert.equal(
      Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 10 * 1024 * 1024,
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("files reads the committed project revision when project is the source", async () => {
  const fixture = await createFixture("project-files");
  try {
    writeFileSync(join(fixture.project, "project-only.txt"), "applied result\n");
    await runGit({ cwd: fixture.project, args: ["add", "project-only.txt"] });
    await runGit({
      cwd: fixture.project,
      args: ["commit", "-m", "Apply result"],
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    const projectRevision = await gitText(fixture.project, ["rev-parse", "HEAD"]);

    const snapshot = await fixture.integration.files("project");

    assert.equal(snapshot.source, "project");
    assert.equal(snapshot.revision, projectRevision);
    assert.equal(snapshot.appliedToProject, true);
    assert.deepEqual(
      snapshot.files.find((file) => file.path === "project-only.txt"),
      { path: "project-only.txt", content: "applied result\n" }
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("files reads the exact applied project revision when the project has additional history", async () => {
  const fixture = await createFixture("project-files-pinned");
  try {
    const workspace = await fixture.workspaces.createTaskWorkspace("feature");
    writeFileSync(join(workspace.path, "feature.txt"), "integrated\n");
    const taskCommit = await fixture.workspaces.commitTask("feature", "Add feature");
    const changeSet = await createChangeSet({
      workspacePath: workspace.path,
      taskCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    await fixture.integration.integrate(changeSet);

    writeFileSync(join(fixture.project, "user-history.txt"), "preserved\n");
    await runGit({ cwd: fixture.project, args: ["add", "user-history.txt"] });
    await runGit({
      cwd: fixture.project,
      args: ["commit", "-m", "User history"],
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    const handoff = await fixture.integration.applyToProject();
    assert.ok(handoff.projectRevision);
    writeFileSync(join(fixture.project, "user-history.txt"), "later\n");
    await runGit({ cwd: fixture.project, args: ["add", "user-history.txt"] });
    await runGit({
      cwd: fixture.project,
      args: ["commit", "-m", "Later project work"],
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

    const snapshot = await fixture.integration.files("project", handoff.projectRevision);
    assert.equal(snapshot.revision, handoff.projectRevision);
    assert.deepEqual(
      snapshot.files.find((file) => file.path === "user-history.txt"),
      { path: "user-history.txt", content: "preserved\n" }
    );
    assert.deepEqual(
      snapshot.files.find((file) => file.path === "feature.txt"),
      { path: "feature.txt", content: "integrated\n" }
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("cleanup removes the owned integration worktree but retains its audit branch", async () => {
  const fixture = await createFixture("cleanup");
  try {
    const revision = fixture.integration.revision;
    const branch = fixture.integration.integrationBranch;

    await fixture.integration.cleanup();

    assert.equal(existsSync(fixture.integration.path), false);
    assert.equal(
      await gitText(fixture.project, ["rev-parse", "--verify", branch]),
      revision
    );
    await fixture.integration.cleanup();
    assert.equal(existsSync(fixture.integration.path), false);
    assert.equal(
      await gitText(fixture.project, ["rev-parse", "--verify", branch]),
      revision
    );
    const history = await fixture.integration.history();
    assert.deepEqual(history, []);
    assert.equal(existsSync(fixture.integration.path), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("cleanup removes an exact empty integration directory without a prunable marker", async () => {
  const executeWithoutPrunableMarker: GitRunner = async (options) => {
    const result = await runGit(options);
    if (
      options.args[0] === "worktree" &&
      options.args[1] === "list" &&
      options.args.includes("--porcelain")
    ) {
      return {
        ...result,
        stdout: result.stdout.replace(/prunable(?: [^\0]*)?\0/g, ""),
      };
    }
    return result;
  };
  const fixture = await createFixture(
    "cleanup-empty-stale-unmarked",
    executeWithoutPrunableMarker
  );
  try {
    const revision = fixture.integration.revision;
    const branch = fixture.integration.integrationBranch;
    rmSync(fixture.integration.path, { recursive: true, force: true });
    mkdirSync(fixture.integration.path);

    await fixture.integration.cleanup();

    assert.equal(existsSync(fixture.integration.path), false);
    assert.equal(
      await gitText(fixture.project, ["rev-parse", "--verify", branch]),
      revision
    );
    assert.equal(
      (await gitText(fixture.project, ["worktree", "list", "--porcelain"]))
        .replaceAll("\\", "/")
        .includes(fixture.integration.path.replaceAll("\\", "/")),
      false
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("cleanup refuses a nonempty invalid integration directory with a stale worktree record", async () => {
  const fixture = await createFixture("cleanup-nonempty-stale");
  try {
    const revision = fixture.integration.revision;
    const branch = fixture.integration.integrationBranch;
    rmSync(fixture.integration.path, { recursive: true, force: true });
    mkdirSync(fixture.integration.path);
    writeFileSync(join(fixture.integration.path, "user.txt"), "preserve me\n");

    await assert.rejects(fixture.integration.cleanup());

    assert.equal(
      readFileSync(join(fixture.integration.path, "user.txt"), "utf8"),
      "preserve me\n"
    );
    assert.equal(
      await gitText(fixture.project, ["rev-parse", "--verify", branch]),
      revision
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("cleanup refuses an integration worktree associated with an unexpected path", async () => {
  const fixture = await createFixture("cleanup-unexpected-path");
  const unexpectedPath = join(fixture.root, "unexpected-integration-path");
  try {
    const revision = fixture.integration.revision;
    const branch = fixture.integration.integrationBranch;
    await runGit({
      cwd: fixture.project,
      args: ["worktree", "move", fixture.integration.path, unexpectedPath],
    });

    await assert.rejects(fixture.integration.cleanup(), /unexpected worktree path/i);

    assert.equal(existsSync(unexpectedPath), true);
    assert.equal(
      await gitText(fixture.project, ["rev-parse", "--verify", branch]),
      revision
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(label: string, execute?: GitRunner) {
  const root = mkdtempSync(join(tmpdir(), `aiboard-integration-${label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  const runId = `run_${label}`;
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  const baseline = await captureGitBaseline({
    projectPath: project,
    stateDirectory: state,
    runId,
  });
  const workspaces = new WorkspaceManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
  });
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const evidence = await artifacts.put(
    Buffer.from("mechanical verification evidence"),
    "text/plain",
    "Fixture evidence"
  );
  const integration = new IntegrationManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
    ...(execute ? { execute } : {}),
  });
  await integration.initialize();
  return {
    root,
    project,
    state,
    runId,
    baseline,
    workspaces,
    artifacts,
    evidence,
    integration,
  };
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await runGit({ cwd, args })).stdout.trim();
}

async function integrateFeature(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  path: string,
  content: string
): Promise<void> {
  const workspace = await fixture.workspaces.createTaskWorkspace("feature");
  writeFileSync(join(workspace.path, path), content);
  const taskCommit = await fixture.workspaces.commitTask("feature", "Add feature");
  const changeSet = await createChangeSet({
    workspacePath: workspace.path,
    taskCommit,
    artifacts: fixture.artifacts,
    evidenceArtifactHashes: [fixture.evidence.hash],
  });
  await fixture.integration.integrate(changeSet);
}

function freshIntegration(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  overrides: Partial<ConstructorParameters<typeof IntegrationManager>[0]> = {}
) {
  return new IntegrationManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    baselineRevision: fixture.baseline.revision,
    ...overrides,
  });
}

function applyJournalPaths(
  fixture: Awaited<ReturnType<typeof createFixture>>
): string[] {
  const directory = join(fixture.state, "handoff");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".apply.json"))
    .map((name) => join(directory, name));
}

async function handoffRefCount(
  fixture: Awaited<ReturnType<typeof createFixture>>
): Promise<number> {
  return (await gitText(fixture.project, [
    "for-each-ref",
    "--format=%(refname)",
    `refs/aiboard/runs/${fixture.integration.integrationBranch.split("/")[1]}/handoff/`,
  ])).split(/\r?\n/).filter(Boolean).length;
}

function applyJournalPath(fixture: Awaited<ReturnType<typeof createFixture>>): string {
  const runId = fixture.integration.integrationBranch.split("/")[1];
  return join(fixture.state, "handoff", `${runId}.apply.json`);
}

async function writeApplyJournal(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  revisions: { branch: string; parent: string; target: string }
): Promise<void> {
  const gitDirectory = await gitText(fixture.project, ["rev-parse", "--absolute-git-dir"]);
  const projectIdentity = createHash("sha256")
    .update(`${fixture.project}\0${gitDirectory}`)
    .digest("hex");
  mkdirSync(join(fixture.state, "handoff"), { recursive: true });
  writeFileSync(
    applyJournalPath(fixture),
    `${JSON.stringify({
      version: 1,
      runId: fixture.runId,
      projectIdentity,
      projectBranch: revisions.branch,
      expectedParent: revisions.parent,
      targetCommit: revisions.target,
      integrationRevision: fixture.integration.revision,
    })}\n`
  );
}

async function projectState(cwd: string) {
  return {
    head: await gitText(cwd, ["rev-parse", "HEAD"]),
    branch: (await runGit({
      cwd,
      args: ["symbolic-ref", "--quiet", "HEAD"],
      allowFailure: true,
    })).stdout,
    status: (await runGit({
      cwd,
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    })).stdout,
    unstaged: (await runGit({ cwd, args: ["diff", "--binary", "--full-index"] })).stdout,
    staged: (await runGit({
      cwd,
      args: ["diff", "--cached", "--binary", "--full-index"],
    })).stdout,
    shared: readFileSync(join(cwd, "shared.txt")),
    stagedFile: existsSync(join(cwd, "staged.txt"))
      ? readFileSync(join(cwd, "staged.txt"))
      : undefined,
    untrackedFile: existsSync(join(cwd, "untracked.txt"))
      ? readFileSync(join(cwd, "untracked.txt"))
      : undefined,
  };
}
