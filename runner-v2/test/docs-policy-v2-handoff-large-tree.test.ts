import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { verifyHandoffSnapshotDigest } from "../src/handoff-snapshot.js";
import {
  CLAUDE_POINTER_LINE,
  DEFAULT_AGENTS_SECTION_BODY,
  DEFAULT_README_TEMPLATE,
  DEFAULT_STATE_TEMPLATE,
} from "../src/project-docs.js";
import { runGit } from "./support/git-fixture.js";
import {
  driveHandoff,
  openFactoryPort,
  selectHandoffOwner,
  silentArchitect,
  v2PlanOnlySeed,
} from "./support/handoff-snapshot-harness.js";

/**
 * TX-2 handoff suite, file 7 of 8: slow large-tree tests.
 *
 * The 40,000-file probes live in their own file so they never hold up the
 * others; G1-flat alone takes about 12 minutes. Every test drives the
 * runtime's real snapshot step directly through the harness
 * (factory-built port, no manager pump).
 */

async function seedManyTrackedFiles(worktree: string, dir: string, count: number): Promise<void> {
  mkdirSync(join(worktree, ...dir.split("/")), { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const name = `g-${String(index).padStart(5, "0")}-padding-to-inflate-index-output-0123456789.md`;
    writeFileSync(join(worktree, ...dir.split("/"), name), `# generated ${index}\n`);
  }
  await runGit({ cwd: worktree, args: ["add", "--", dir] });
  await runGit({ cwd: worktree, args: ["commit", "-m", `seed ${count} files under ${dir}`] });
}

test("C2c repair cycle 2/probe G1: a large docs tree still commits the snapshot and v1 documents", async () => {
  const RUN = "run-c2c-r2-g1";
  const fixture = await openFactoryPort("r2g1", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    await seedManyTrackedFiles(worktree, "docs/generated", 40000);
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, `the snapshot commits despite the large docs tree (pause=${JSON.stringify(driven.projection.pauseReason)})`);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.deepEqual(payload.paths, ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    assert.ok(!("stateSkippedReason" in payload), "a committed STATE.md never carries a skip reason");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r2-g1");
    assert.equal(selected.status, "completed");
    // v1 behaves as at HEAD under the same tree: the Architect document
    // commit lands instead of throwing on the index listing.
    const before = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    const documents = await fixture.integration.commitProjectDocuments({
      writes: [
        { path: "docs/project/README.md", content: DEFAULT_README_TEMPLATE },
        { path: "AGENTS.md", content: DEFAULT_AGENTS_SECTION_BODY },
        { path: "CLAUDE.md", content: CLAUDE_POINTER_LINE },
        { path: "docs/project/STATE.md", content: DEFAULT_STATE_TEMPLATE },
      ],
      summary: "Record documents",
      runId: RUN,
      requestId: "project-doc:g1:docs/project/STATE.md",
    });
    assert.ok(documents.commit, "the v1 document commit lands");
    const after = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(after.stdout.trim(), String(Number(before.stdout.trim()) + 1), "the v1 batch commits exactly once");
  } finally {
    await fixture.close();
  }
});

test("C2c repair cycle 2/probe G1-control: a large tree outside docs still commits", async () => {
  const RUN = "run-c2c-r2-g1control";
  const fixture = await openFactoryPort("r2g1control", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    await seedManyTrackedFiles(worktree, "site/generated", 40000);
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, `the snapshot commits with a large tree elsewhere (pause=${JSON.stringify(driven.projection.pauseReason)})`);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r2-g1control");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2e/probe G1-select: a large docs tree still applies the owner's selection", async () => {
  const RUN = "run-c2e-g1select";
  const fixture = await openFactoryPort("c2eg1select", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    await seedManyTrackedFiles(worktree, "docs/generated", 40000);
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, `the snapshot commits despite the large docs tree (pause=${JSON.stringify(driven.projection.pauseReason)})`);
    // The owner's apply selection completes: the apply never buffers the
    // whole-tree diff into the capped git output (the old 4 MiB refusal is
    // gone), while conflict refusal and the audit record are unchanged.
    const selected = await selectHandoffOwner(fixture, RUN, "apply_to_project", "handoff:c2e-g1select");
    assert.equal(selected.status, "completed", "the apply selection completes on the large tree");
    assert.equal(selected.projectHandoff?.choice, "apply_to_project");
    const applied = await runGit({ cwd: fixture.project, args: ["show", "HEAD:docs/project/STATE.md"] });
    assert.equal(verifyHandoffSnapshotDigest(applied.stdout), true, "the project holds the applied snapshot");
    const generated = await runGit({ cwd: fixture.project, args: ["show", "HEAD:docs/generated/g-00000-padding-to-inflate-index-output-0123456789.md"] });
    assert.match(generated.stdout, /generated 0/, "the large tree applied with the handoff");
  } finally {
    await fixture.close();
  }
});

test("C2e repair cycle 1/probe A1: a large ignored tree never blocks a tiny apply", async () => {
  const RUN = "run-c2e-r1-a1";
  const fixture = await openFactoryPort("c2er1a1", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    // 45,000 ignored files (a node_modules-sized tree): `git status
    // --porcelain` never shows them, but the old whole-tree `ls-files
    // --others` listing buffered all 4.4 MiB and refused the apply on the
    // git output cap. The apply now checks only the paths it will write.
    const ignored = join(fixture.project, "ignored_deps");
    mkdirSync(ignored, { recursive: true });
    for (let index = 0; index < 45000; index += 1) {
      writeFileSync(join(ignored, `dep-${String(index).padStart(6, "0")}-padding-to-inflate-the-untracked-listing-0123456789-abcdefghij-klmnopqr.js`), "x\n");
    }
    appendFileSync(join(fixture.project, ".git", "info", "exclude"), "ignored_deps/\n");
    const status = await runGit({ cwd: fixture.project, args: ["status", "--porcelain", "-z", "--untracked-files=all"] });
    assert.equal(status.stdout.length, 0, "the ignored tree stays invisible to the clean-project check");
    const before = await runGit({ cwd: fixture.project, args: ["rev-parse", "HEAD"] });
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, `the snapshot commits under the ignored tree (pause=${JSON.stringify(driven.projection.pauseReason)})`);
    const selected = await selectHandoffOwner(fixture, RUN, "apply_to_project", "handoff:c2e-r1-a1");
    assert.equal(selected.status, "completed", "the tiny apply completes despite the 45,000 ignored files");
    assert.equal(selected.projectHandoff?.choice, "apply_to_project");
    const after = await runGit({ cwd: fixture.project, args: ["rev-parse", "HEAD"] });
    assert.notEqual(after.stdout.trim(), before.stdout.trim(), "the project head moves");
    const applied = await runGit({ cwd: fixture.project, args: ["show", "HEAD:docs/project/STATE.md"] });
    assert.equal(verifyHandoffSnapshotDigest(applied.stdout), true, "the project holds the applied snapshot");
  } finally {
    await fixture.close();
  }
});

test("C2e repair cycle 1/probe A3: an ignored file at an added path still refuses the apply", async () => {
  const RUN = "run-c2e-r1-a3";
  const fixture = await openFactoryPort("c2er1a3", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    // The project ignores a path the integration adds: the apply must
    // refuse with the exact untracked-or-ignored collision, leaving the
    // head, the status and the user's file untouched. The check runs on
    // the written paths alone now, so this refusal proves it stayed
    // exactly as strong without the whole-tree listing.
    writeFileSync(join(fixture.project, ".gitignore"), "site/generated.md\n");
    mkdirSync(join(fixture.project, "site"), { recursive: true });
    writeFileSync(join(fixture.project, "site", "generated.md"), "user ignored file\n");
    await runGit({ cwd: fixture.project, args: ["add", "--", ".gitignore"] });
    await runGit({ cwd: fixture.project, args: ["commit", "-m", "seed an ignored path"] });
    const worktree = fixture.integration.path;
    mkdirSync(join(worktree, "site"), { recursive: true });
    writeFileSync(join(worktree, "site", "generated.md"), "integration file\n");
    await runGit({ cwd: worktree, args: ["add", "--", "site/generated.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "add the path the project ignores"] });
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, `the snapshot commits (pause=${JSON.stringify(driven.projection.pauseReason)})`);
    const before = await runGit({ cwd: fixture.project, args: ["rev-parse", "HEAD"] });
    await assert.rejects(
      () => selectHandoffOwner(fixture, RUN, "apply_to_project", "handoff:c2e-r1-a3"),
      /would overwrite the untracked or ignored path site\/generated\.md/,
      "the apply refuses the ignored-path collision",
    );
    const after = await runGit({ cwd: fixture.project, args: ["rev-parse", "HEAD"] });
    assert.equal(after.stdout.trim(), before.stdout.trim(), "the project head does not move");
    assert.equal(readFileSync(join(fixture.project, "site", "generated.md"), "utf8"), "user ignored file\n", "the user's ignored file is untouched");
    const status = await runGit({ cwd: fixture.project, args: ["status", "--porcelain"] });
    assert.equal(status.stdout.trim(), "", "the project stays clean");
  } finally {
    await fixture.close();
  }
});

test("C2c round 3/probe G1-flat: 40,000 files directly under docs still commit the snapshot and v1 documents", async () => {
  const RUN = "run-c2c-r3-g1flat";
  const fixture = await openFactoryPort("r3g1flat", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    await seedManyTrackedFiles(worktree, "docs", 40000);
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, `the commit-tree walk never lists the whole docs directory (pause=${JSON.stringify(driven.projection.pauseReason)})`);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r3-g1flat");
    assert.equal(selected.status, "completed");
    const documents = await fixture.integration.commitProjectDocuments({
      writes: [{ path: "docs/project/STATE.md", content: DEFAULT_STATE_TEMPLATE }],
      summary: "Record documents",
      runId: RUN,
      requestId: "project-doc:g1flat:docs/project/STATE.md",
    });
    assert.ok(documents.commit, "the v1 document commit lands and returns");
  } finally {
    await fixture.close();
  }
});
