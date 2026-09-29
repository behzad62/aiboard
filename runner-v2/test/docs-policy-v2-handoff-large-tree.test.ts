import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
