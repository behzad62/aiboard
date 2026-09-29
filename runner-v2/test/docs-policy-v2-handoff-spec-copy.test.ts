import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { runGit } from "./support/git-fixture.js";
import {
  SOURCE_TEXT,
  driveHandoff,
  openFactoryPort,
  selectHandoffOwner,
  silentArchitect,
  v2PlanOnlySeed,
  withRunOptions,
} from "./support/handoff-snapshot-harness.js";

/**
 * TX-2 handoff suite, file 5 of 8: spec copy.
 *
 * The verbatim spec copy and its skip reasons. Every test drives the
 * runtime's real snapshot step directly through the harness
 * (factory-built port, no manager pump).
 */

test("C2b: the verbatim spec copy is committed when due", async () => {
  const RUN = "run-c2b-speccopy";
  const fixture = await openFactoryPort("speccopy", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  // The approved source's bytes live in the artifact store under the
  // manifest artifact digest (the T7a provisioning path in miniature).
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  const architect = silentArchitect();
  try {
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.specPath, "docs/project/specs/source_value.md");
    assert.equal(payload.specCopied, true);
    const commit = String(payload.commit);
    const copy = await runGit({ cwd: fixture.integration.path, args: ["show", `${commit}:docs/project/specs/source_value.md`] });
    assert.equal(copy.stdout, SOURCE_TEXT, "the copy holds the approved verbatim bytes");
    const state = await runGit({ cwd: fixture.integration.path, args: ["show", `${commit}:docs/project/STATE.md`] });
    assert.ok(state.stdout.includes("spec: docs/project/specs/source_value.md"), "the snapshot names the copy path");
  } finally {
    await fixture.close();
  }
});

test("C2b: the spec copy is skipped when the run opts out", async () => {
  const RUN = "run-c2b-specoptout";
  const fixture = await openFactoryPort("specoptout", RUN, (runId) => withRunOptions(v2PlanOnlySeed(runId), { specCopy: false }), "plan_only", { specCopy: false });
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  const architect = silentArchitect();
  try {
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts, specCopy: false });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.ok(!("specPath" in payload), "no spec path is recorded");
    assert.ok(!("specCopied" in payload), "no spec copy is recorded");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: fixture.integration.path, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    // The opt-out skips only the copy: the snapshot still gates completion.
    // The recorded specCopy:false option must ride along: the runtime
    // re-checks scheduler options against the recorded run policy.
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2b-specoptout", { specCopy: false });
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2b: export_only writes nothing at handoff and completes", async () => {
  const RUN = "run-c2b-exportonly";
  const fixture = await openFactoryPort("exportonly", RUN, (runId) => withRunOptions(v2PlanOnlySeed(runId), { handoffFiles: "export_only" }), "plan_only", { handoffFiles: "export_only" });
  const architect = silentArchitect();
  try {
    const driven = await driveHandoff(fixture, RUN, { architect, handoffFiles: "export_only" });
    assert.equal(driven.projection.projectHandoff?.status, "requested");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const count = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "0", "export_only writes no file at handoff");
    // The recorded option satisfies the gate: the owner's selection completes.
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2b-exportonly", { handoffFiles: "export_only" });
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2b: the spec copy is skipped when the source is already a repository file", async () => {
  const RUN = "run-c2b-specinrepo";
  const fixture = await openFactoryPort("specinrepo", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  // The approved bytes already live in the repo under another path.
  mkdirSync(join(fixture.integration.path, "brief"), { recursive: true });
  writeFileSync(join(fixture.integration.path, "brief", "spec.md"), SOURCE_TEXT);
  await runGit({ cwd: fixture.integration.path, args: ["add", "--", "brief/spec.md"] });
  await runGit({ cwd: fixture.integration.path, args: ["commit", "-m", "approved spec already in the repo"] });
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  const architect = silentArchitect();
  try {
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.specPath, "brief/spec.md", "the existing repo path is recorded");
    assert.ok(!("specCopied" in payload), "no copy is written");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: fixture.integration.path, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
  } finally {
    await fixture.close();
  }
});

test("C2b repair m4: a spec-copy search failure skips the copy, never the commit", async () => {
  const RUN = "run-c2b-spectracked-fail";
  const fixture = await openFactoryPort("spectracked-fail", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  // The tracked-file search fails on the factory's own integration (the
  // port keeps delegating to it): the copy is skipped, never the commit.
  fixture.integration.findTrackedFileWithDigest = async () => {
    throw new Error("Injected tracked search failure.");
  };
  const architect = silentArchitect();
  try {
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the conditional copy never fails the snapshot commit");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.specCopySkipped, "tracked_search_failed");
    assert.ok(!("specCopied" in payload), "no copy is claimed");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: fixture.integration.path, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
  } finally {
    await fixture.close();
  }
});

test("C2b repair N-1/probe K: a blocked spec directory never fails the snapshot", async () => {
  const RUN = "run-c2b-specblock";
  const fixture = await openFactoryPort("specblock", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  // A tracked FILE where the spec directory belongs: every spec mkdir fails.
  mkdirSync(join(fixture.integration.path, "docs", "project"), { recursive: true });
  writeFileSync(join(fixture.integration.path, "docs", "project", "specs"), "blocking file\n");
  await runGit({ cwd: fixture.integration.path, args: ["add", "--", "docs/project/specs"] });
  await runGit({ cwd: fixture.integration.path, args: ["commit", "-m", "blocking file at the spec directory"] });
  const architect = silentArchitect();
  try {
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the blocked copy never fails the snapshot commit");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.specCopySkipped, "write_failed");
    assert.ok(!("specCopied" in payload), "no copy is claimed");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: fixture.integration.path, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2b-specblock");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2b repair N-2/probe K2: a user's own spec-path file is never overwritten", async () => {
  const RUN = "run-c2b-specown";
  const fixture = await openFactoryPort("specown", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  // The user's own tracked file at the copy's path, holding other bytes.
  mkdirSync(join(fixture.integration.path, "docs", "project", "specs"), { recursive: true });
  writeFileSync(join(fixture.integration.path, "docs", "project", "specs", "source_value.md"), "user's own notes\n");
  await runGit({ cwd: fixture.integration.path, args: ["add", "--", "docs/project/specs/source_value.md"] });
  await runGit({ cwd: fixture.integration.path, args: ["commit", "-m", "user's own spec-path file"] });
  const architect = silentArchitect();
  try {
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    const digest = createHash("sha256").update(SOURCE_TEXT, "utf8").digest("hex").slice(0, 16);
    const expected = `docs/project/specs/source_value-${digest}.md`;
    assert.equal(payload.specCopied, true);
    assert.equal(payload.specPath, expected);
    assert.equal(
      readFileSync(join(fixture.integration.path, "docs", "project", "specs", "source_value.md"), "utf8"),
      "user's own notes\n",
      "the user's file survives byte-for-byte",
    );
    const commit = String(payload.commit);
    const files = await runGit({ cwd: fixture.integration.path, args: ["show", "--name-only", "--format=", commit] });
    assert.ok(files.stdout.split("\n").map((line) => line.trim()).includes(expected), "the copy lands under the digest-suffixed name");
    const blob = await runGit({ cwd: fixture.integration.path, args: ["show", `${commit}:${expected}`] });
    assert.equal(blob.stdout, SOURCE_TEXT);
    const state = await runGit({ cwd: fixture.integration.path, args: ["show", `${commit}:docs/project/STATE.md`] });
    assert.ok(state.stdout.includes(`spec: ${expected}`), "the snapshot names the real copy, not the occupied target");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2b-specown");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c NF-1/probe K-ignored: a gitignored specs directory never fails the snapshot", async () => {
  const RUN = "run-c2c-specignored";
  const fixture = await openFactoryPort("specignored", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  // The specs directory is gitignored, so the spec `git add` refuses it.
  writeFileSync(join(fixture.integration.path, ".gitignore"), "docs/project/specs/\n");
  await runGit({ cwd: fixture.integration.path, args: ["add", "--", ".gitignore"] });
  await runGit({ cwd: fixture.integration.path, args: ["commit", "-m", "ignore the specs directory"] });
  const architect = silentArchitect();
  try {
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the ignored copy never fails the snapshot commit");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.specCopySkipped, "write_failed");
    assert.ok(!("specCopied" in payload), "no copy is claimed");
    assert.ok(!("specPath" in payload), "no copy path is recorded");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: fixture.integration.path, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    // C2c NF-1 residual: the port's pre-render stageability check omits the
    // spec path from the facts, so the line says "not recorded".
    const state = await runGit({ cwd: fixture.integration.path, args: ["show", `${commit}:docs/project/STATE.md`] });
    assert.ok(state.stdout.includes("spec: not recorded"), "the snapshot names no spec path the commit does not hold");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-specignored");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c NF-4/probe K2b: an occupied target and sibling skip the copy as path_occupied", async () => {
  const RUN = "run-c2c-specboth";
  const fixture = await openFactoryPort("specboth", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  // Both the copy path and its digest sibling hold other bytes.
  const digest = createHash("sha256").update(SOURCE_TEXT, "utf8").digest("hex").slice(0, 16);
  const sibling = `source_value-${digest}.md`;
  mkdirSync(join(fixture.integration.path, "docs", "project", "specs"), { recursive: true });
  writeFileSync(join(fixture.integration.path, "docs", "project", "specs", "source_value.md"), "user's own notes\n");
  writeFileSync(join(fixture.integration.path, "docs", "project", "specs", sibling), "other notes\n");
  await runGit({ cwd: fixture.integration.path, args: ["add", "--", "docs/project/specs/source_value.md", `docs/project/specs/${sibling}`] });
  await runGit({ cwd: fixture.integration.path, args: ["commit", "-m", "both spec paths occupied"] });
  const architect = silentArchitect();
  try {
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.specCopySkipped, "path_occupied");
    assert.ok(!("specCopied" in payload), "no copy is claimed");
    assert.ok(!("specPath" in payload), "no copy path is recorded");
    const commit = String(payload.commit);
    const state = await runGit({ cwd: fixture.integration.path, args: ["show", `${commit}:docs/project/STATE.md`] });
    assert.ok(state.stdout.includes("spec: not recorded"), "the snapshot records no spec path");
    const files = await runGit({ cwd: fixture.integration.path, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-specboth");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c NF-4: an unreadable spec tip skips the copy instead of failing the snapshot", async () => {
  const RUN = "run-c2c-spectip";
  const fixture = await openFactoryPort("spectip", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  // The STATE.md tip read works (hand-edit detection runs), but every spec
  // tip read throws: the copy is skipped with a reason, never a failure.
  const origReadTip = fixture.integration.readIntegrationTipFile.bind(fixture.integration);
  fixture.integration.readIntegrationTipFile = async (input: { path: string }) => {
    if (input.path.startsWith("docs/project/specs/")) throw new Error("Injected spec tip read failure.");
    return origReadTip(input);
  };
  const architect = silentArchitect();
  try {
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the unreadable tip never fails the snapshot commit");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.specCopySkipped, "spec_tip_unreadable");
    assert.ok(!("specCopied" in payload), "no copy is claimed");
    assert.ok(!("specPath" in payload), "no copy path is recorded");
    const commit = String(payload.commit);
    const state = await runGit({ cwd: fixture.integration.path, args: ["show", `${commit}:docs/project/STATE.md`] });
    assert.ok(state.stdout.includes("spec: not recorded"), "the snapshot records no spec path");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-spectip");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c repair E1/E2: the stageability check stages nothing and leaves nothing behind", async () => {
  const RUN = "run-c2c-repair-check";
  const fixture = await openFactoryPort("repaircheck", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  try {
    const worktree = fixture.integration.path;
    writeFileSync(join(worktree, ".gitignore"), "docs/project/specs/\n");
    await runGit({ cwd: worktree, args: ["add", "--", ".gitignore"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "ignore the specs directory"] });
    const status = await runGit({ cwd: worktree, args: ["status", "--porcelain", "--ignored"] });
    // An ignored path is unstageable, a normal absent path is stageable --
    // and neither answer writes, stages, or leaves anything behind.
    assert.equal((await fixture.port.canStageSpecPath({ path: "docs/project/specs/source_value.md", content: "spec bytes\n" })).stageable, false);
    assert.equal((await fixture.port.canStageSpecPath({ path: "docs/project/normal-b.md", content: "spec bytes\n" })).stageable, true);
    assert.equal(existsSync(join(worktree, "docs", "project", "specs", "source_value.md")), false, "no preview file is written");
    assert.equal(existsSync(join(worktree, "docs", "project", "normal-b.md")), false, "no preview file is written");
    const after = await runGit({ cwd: worktree, args: ["status", "--porcelain", "--ignored"] });
    assert.equal(after.stdout, status.stdout, "the check leaves no ?? or !! entries behind");
    const cached = await runGit({ cwd: worktree, args: ["diff", "--cached", "--name-only"] });
    assert.equal(cached.stdout.trim(), "", "the check stages nothing");
  } finally {
    await fixture.close();
  }
});

test("C2c repair M-4/probe E3: an untracked occupant at the target keeps spec: matching the commit", async () => {
  const RUN = "run-c2c-repair-e3";
  const fixture = await openFactoryPort("repairoccupant", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    // An UNTRACKED file with other bytes sits at the copy target: the tip
    // has no such blob, so the resolver names the target -- but the copy
    // can never land there, so the pre-render check skips it.
    mkdirSync(join(worktree, "docs", "project", "specs"), { recursive: true });
    writeFileSync(join(worktree, "docs", "project", "specs", "source_value.md"), "untracked other bytes\n");
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.specCopySkipped, "path_occupied", "the occupant is recorded as the real cause");
    assert.ok(!("specCopied" in payload), "no copy is claimed");
    assert.ok(!("specPath" in payload), "no copy path is recorded");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    const state = await runGit({ cwd: worktree, args: ["show", `${commit}:docs/project/STATE.md`] });
    assert.ok(state.stdout.includes("spec: not recorded"), "the snapshot names no spec path the commit does not hold");
    assert.equal(
      readFileSync(join(worktree, "docs", "project", "specs", "source_value.md"), "utf8"),
      "untracked other bytes\n",
      "the occupant survives byte-for-byte",
    );
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-repair-e3");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});
