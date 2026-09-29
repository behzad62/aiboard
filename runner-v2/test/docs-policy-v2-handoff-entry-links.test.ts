import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  handoffSnapshotInputFromProjection,
  renderHandoffSnapshot,
  verifyHandoffSnapshotDigest,
} from "../src/handoff-snapshot.js";
import {
  V2_AGENTS_SECTION_BODY,
  V2_CLAUDE_POINTER_LINE,
} from "../src/project-docs.js";
import {
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerActorRole,
} from "../src/scheduler-store.js";
import { runGit } from "./support/git-fixture.js";
import {
  CLOCK,
  COMPLETION_SUMMARY,
  appendHandoffEvents,
  checkoutEntryLinkAsPlainFile,
  commitEntryLinkMode,
  driveHandoff,
  openFactoryPort,
  readHandoffLog,
  seedEvent,
  seedHandoffRequested,
  selectHandoffOwner,
  silentArchitect,
  v2PlanOnlySeed,
} from "./support/handoff-snapshot-harness.js";

/**
 * TX-2 handoff suite, file 4 of 8: entry-file links.
 *
 * AGENTS.md / CLAUDE.md layouts: splice, links, missing and outside
 * targets, commit-tree proof. Every test drives the runtime's real snapshot
 * step directly through the harness (factory-built port, no manager pump).
 */

test("C2b: a reused commit without the v2 entry lines fails instead of recording", async () => {
  const RUN = "run-c2b-stateless-reuse";
  const fixture = await openFactoryPort("stateless-reuse", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  try {
    seedHandoffRequested(fixture, RUN);
    const logged = readHandoffLog(fixture, RUN).events;
    const requested = logged.find((event) => event.type === "project.handoff_requested")!;
    const stopProjection = rebuildSchedulerProjection(logged.filter((event) => event.sequence <= requested.sequence));
    // A crashed C2a-era attempt committed STATE.md only, with the same key.
    const body = renderHandoffSnapshot(handoffSnapshotInputFromProjection(stopProjection, { stopAt: requested.occurredAt, revision: "revision_value" }));
    await fixture.integration.commitHandoffSnapshot({
      writes: [{ path: "docs/project/STATE.md", content: body }],
      summary: "crashed STATE-only attempt with the same snapshot key",
      runId: RUN,
      snapshotKey: `handoff-snapshot:${requested.sequence}`,
    });
    const architect = silentArchitect();
    const driven = await driveHandoff(fixture, RUN, { architect });
    // The reused commit is verified, not trusted: without the v2 entries the
    // snapshot pauses instead of recording a false proof.
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.match(String(driven.projection.pauseReason?.detail ?? ""), /v2 AGENTS/);
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const count = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "1", "no second commit is created");
  } finally {
    await fixture.close();
  }
});

test("C2b: a hand-edited STATE.md is detected and named in the next snapshot", async () => {
  const RUN = "run-c2b-handedit";
  const fixture = await openFactoryPort("handedit", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    let driven = await driveHandoff(fixture, RUN, { architect });
    // Snapshot 1: a CRLF/BOM-free clean chain is not flagged.
    const first = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(first.length, 1);
    const firstPayload = first[0]!.payload as Record<string, unknown>;
    assert.equal(firstPayload.previousSnapshotEdited, false);
    const firstBody = await runGit({ cwd: fixture.integration.path, args: ["show", `${String(firstPayload.commit)}:docs/project/STATE.md`] });
    assert.equal(firstBody.stdout.includes("edited outside AIBoard"), false);
    // A hand edit lands in a commit outside AIBoard.
    writeFileSync(join(fixture.integration.path, "docs", "project", "STATE.md"), `${firstBody.stdout}hand-edited outside AIBoard\n`);
    await runGit({ cwd: fixture.integration.path, args: ["add", "--", "docs/project/STATE.md"] });
    await runGit({ cwd: fixture.integration.path, args: ["commit", "-m", "hand edit outside AIBoard"] });
    // Guidance withdraws the handoff; the Architect re-requests (stop 2).
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    const acknowledgementEvidence = fixture.evidence.record({
      runId: RUN,
      taskId: "architect",
      actor: { role: "architect", id: "architect" },
      fact: {
        kind: "browser_screenshot",
        label: "the plan already incorporates the withdrawing guidance",
        capturedAt: CLOCK,
        screenshotArtifactHash: "c".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      },
      createdAt: CLOCK,
      idempotencyKey: "guidance-stale-stop:evidence",
    });
    appendHandoffEvents(fixture, RUN, [
      e("user.guidance_submitted", "guidance-1", "user", "local-user", {
        guidanceId: "guidance-1",
        text: "Hold the handoff and re-verify the plan.",
        version: 1,
        interruptionProtocolVersion: 1,
      }),
      e("user.guidance_interruption_completed", "guidance-1:interruption", "runner", "build-manager", {
        guidanceId: "guidance-1",
        expectedVersion: 1,
      }),
      e("user.guidance_acknowledged", "guidance-1:ack", "architect", "architect", {
        guidanceId: "guidance-1",
        expectedVersion: 1,
        resolution: {
          type: "no_plan_change",
          rationale: "The initial plan already incorporates the durable guidance.",
          evidenceIds: [acknowledgementEvidence.id],
        },
      }),
      e("project.handoff_requested", "handoff-2", "architect", "architect", { summary: COMPLETION_SUMMARY }),
    ]);
    driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 2);
    const second = snapshots[1]!.payload as Record<string, unknown>;
    assert.equal(second.previousSnapshotEdited, true);
    const secondBody = await runGit({ cwd: fixture.integration.path, args: ["show", `${String(second.commit)}:docs/project/STATE.md`] });
    assert.ok(secondBody.stdout.includes("The previous snapshot was edited outside AIBoard; see this file's git history."));
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2b-handedit");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2b repair m5: a committed CLAUDE.md link to AGENTS.md satisfies the line without writing through it", async () => {
  const RUN = "run-c2b-claudelink";
  const fixture = await openFactoryPort("claudelink", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  try {
    const worktree = fixture.integration.path;
    // A common layout: CLAUDE.md is a link to AGENTS.md. C2c NF-3: the link
    // is COMMITTED (the realistic layout) -- the gate reads the fact from
    // the commit tree alone, never the live checkout.
    writeFileSync(join(worktree, "AGENTS.md"), "pre-existing agents\n");
    symlinkSync("AGENTS.md", join(worktree, "CLAUDE.md"), "file");
    await runGit({ cwd: worktree, args: ["add", "--", "AGENTS.md", "CLAUDE.md"] });
    const staged = await runGit({ cwd: worktree, args: ["ls-files", "-s", "--", "CLAUDE.md"] });
    assert.match(staged.stdout.trim(), /^120000 /);
    await runGit({ cwd: worktree, args: ["commit", "-m", "link CLAUDE.md to AGENTS.md"] });
    const architect = silentArchitect();
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the link layout completes instead of failing every snapshot");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.claudeLineCommitted, true);
    assert.equal(payload.claudeLineViaLink, "CLAUDE.md is a symbolic link to AGENTS.md");
    assert.ok(lstatSync(join(worktree, "CLAUDE.md")).isSymbolicLink(), "never written through the link");
    // The commit keeps the link: the gate read the fact from the commit tree.
    const mode = await runGit({ cwd: worktree, args: ["ls-tree", String(payload.commit), "--", "CLAUDE.md"] });
    assert.match(mode.stdout.trim(), /^120000 blob/);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2b-claudelink");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2b repair m3: a non-UTF-8 AGENTS.md survives the kernel splice byte-for-byte", async () => {
  const RUN = "run-c2b-latin1";
  const fixture = await openFactoryPort("latin1", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  // Probe J shape: pre-existing Latin-1 bytes outside any markers.
  const latin1 = Buffer.from([0x23, 0x20, 0x52, 0xe9, 0x67, 0x6c, 0x65, 0x73, 0x0a]);
  writeFileSync(join(fixture.integration.path, "AGENTS.md"), latin1);
  const architect = silentArchitect();
  try {
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, true);
    const staged = readFileSync(join(fixture.integration.path, "AGENTS.md"));
    assert.ok(staged.subarray(0, latin1.length).equals(latin1), "bytes outside the markers are kept exactly");
    assert.ok(staged.includes(V2_AGENTS_SECTION_BODY));
  } finally {
    await fixture.close();
  }
});

test("C2b repair B3/probe L: a link-mode CLAUDE.md under core.symlinks=false is never written", async () => {
  const RUN = "run-c2b-linkmode";
  const fixture = await openFactoryPort("linkmode", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  try {
    const worktree = fixture.integration.path;
    // Store CLAUDE.md as a link entry (mode 120000) without touching a real
    // symlink: hash the target text, then index it as a link.
    writeFileSync(join(worktree, "AGENTS.md"), "pre-existing agents\n");
    await runGit({ cwd: worktree, args: ["add", "--", "AGENTS.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed agents file"] });
    writeFileSync(join(worktree, "link-target.txt"), "AGENTS.md");
    const hashed = await runGit({ cwd: worktree, args: ["hash-object", "-w", "link-target.txt"] });
    const blob = hashed.stdout.trim();
    assert.match(blob, /^[a-f0-9]{40}$/);
    rmSync(join(worktree, "link-target.txt"), { force: true });
    await runGit({ cwd: worktree, args: ["update-index", "--add", "--cacheinfo", `120000,${blob},CLAUDE.md`] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "link CLAUDE.md to AGENTS.md"] });
    // The Windows default: links check out as plain files holding the target.
    await runGit({ cwd: worktree, args: ["config", "core.symlinks", "false"] });
    rmSync(join(worktree, "CLAUDE.md"), { force: true });
    await runGit({ cwd: worktree, args: ["checkout", "--", "CLAUDE.md"] });
    // Fixture shape: a plain file in the worktree, a link in the index.
    assert.equal(lstatSync(join(worktree, "CLAUDE.md")).isSymbolicLink(), false);
    const staged = await runGit({ cwd: worktree, args: ["ls-files", "-s", "--", "CLAUDE.md"] });
    assert.match(staged.stdout.trim(), /^120000 /);
    assert.equal(readFileSync(join(worktree, "CLAUDE.md"), "utf8"), "AGENTS.md");
    const architect = silentArchitect();
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the link layout completes instead of failing every snapshot");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.claudeLineCommitted, true);
    assert.equal(payload.claudeLineViaLink, "CLAUDE.md is a symbolic link to AGENTS.md");
    assert.equal(readFileSync(join(worktree, "CLAUDE.md"), "utf8"), "AGENTS.md", "never written through the link");
    assert.equal(lstatSync(join(worktree, "CLAUDE.md")).isSymbolicLink(), false);
    // The commit keeps the link: the gate read the fact from the commit tree.
    const mode = await runGit({ cwd: worktree, args: ["ls-tree", String(payload.commit), "--", "CLAUDE.md"] });
    assert.match(mode.stdout.trim(), /^120000 blob/);
    const target = await runGit({ cwd: worktree, args: ["show", `${String(payload.commit)}:CLAUDE.md`] });
    assert.equal(target.stdout, "AGENTS.md");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2b-linkmode");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c NF-2/probe L2: a link-mode AGENTS.md to CLAUDE.md writes the section into the target", async () => {
  const RUN = "run-c2c-agentslink";
  const fixture = await openFactoryPort("agentslink", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    writeFileSync(join(worktree, "CLAUDE.md"), "pre-existing claude rules\n");
    await runGit({ cwd: worktree, args: ["add", "--", "CLAUDE.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed claude file"] });
    await commitEntryLinkMode(worktree, "AGENTS.md", "CLAUDE.md");
    await checkoutEntryLinkAsPlainFile(worktree, "AGENTS.md", "CLAUDE.md");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the link layout completes instead of failing every snapshot");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, true);
    assert.equal(payload.agentsSectionViaLink, "AGENTS.md is a symbolic link to CLAUDE.md; the section is written into CLAUDE.md.");
    assert.equal(payload.claudeLineCommitted, true, "the CLAUDE.md line counts as committed through the AGENTS.md redirect");
    assert.match(String(payload.claudeLineViaLink), /CLAUDE\.md pointer omitted: AGENTS\.md resolves to CLAUDE\.md/, "the self-import omission is recorded");
    // Never written through the link: the worktree entry file still holds
    // the target text, and the target holds the AGENTS.md section -- with
    // no @AGENTS.md self-import (M-6: it would import the file into itself).
    assert.equal(readFileSync(join(worktree, "AGENTS.md"), "utf8"), "CLAUDE.md");
    const target = readFileSync(join(worktree, "CLAUDE.md"), "utf8");
    assert.ok(target.includes(V2_AGENTS_SECTION_BODY), "the target holds the AGENTS.md section");
    assert.ok(!target.split("\n").some((line) => line.trim() === V2_CLAUDE_POINTER_LINE), "the merged section carries no self-import");
    assert.ok(target.includes("pre-existing claude rules"), "the target's own bytes survive");
    const commit = String(payload.commit);
    const mode = await runGit({ cwd: worktree, args: ["ls-tree", commit, "--", "AGENTS.md"] });
    assert.match(mode.stdout.trim(), /^120000 blob/);
    const linkTarget = await runGit({ cwd: worktree, args: ["show", `${commit}:AGENTS.md`] });
    assert.equal(linkTarget.stdout, "CLAUDE.md");
    const committedTarget = await runGit({ cwd: worktree, args: ["show", `${commit}:CLAUDE.md`] });
    assert.ok(committedTarget.stdout.includes(V2_AGENTS_SECTION_BODY));
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["CLAUDE.md", "docs/project/STATE.md"]);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-agentslink");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c NF-2/probe L2-real: a real AGENTS.md link to CLAUDE.md writes the section into the target", async () => {
  const RUN = "run-c2c-agentslink-real";
  const fixture = await openFactoryPort("agentslinkreal", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    writeFileSync(join(worktree, "CLAUDE.md"), "pre-existing claude rules\n");
    symlinkSync("CLAUDE.md", join(worktree, "AGENTS.md"), "file");
    await runGit({ cwd: worktree, args: ["add", "--", "AGENTS.md", "CLAUDE.md"] });
    const staged = await runGit({ cwd: worktree, args: ["ls-files", "-s", "--", "AGENTS.md"] });
    assert.match(staged.stdout.trim(), /^120000 /);
    await runGit({ cwd: worktree, args: ["commit", "-m", "link AGENTS.md to CLAUDE.md"] });
    assert.ok(lstatSync(join(worktree, "AGENTS.md")).isSymbolicLink());
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the real-link layout completes instead of failing every snapshot");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, true);
    assert.equal(payload.agentsSectionViaLink, "AGENTS.md is a symbolic link to CLAUDE.md; the section is written into CLAUDE.md.");
    assert.ok(lstatSync(join(worktree, "AGENTS.md")).isSymbolicLink(), "never written through the link");
    assert.equal(readlinkSync(join(worktree, "AGENTS.md")).replace(/\\/g, "/"), "CLAUDE.md");
    assert.match(String(payload.claudeLineViaLink), /CLAUDE\.md pointer omitted: AGENTS\.md resolves to CLAUDE\.md/, "the self-import omission is recorded");
    const committedTarget = await runGit({ cwd: worktree, args: ["show", `${String(payload.commit)}:CLAUDE.md`] });
    assert.ok(committedTarget.stdout.includes(V2_AGENTS_SECTION_BODY), "the section is in the target, not through the link");
    assert.ok(!committedTarget.stdout.split("\n").some((line) => line.trim() === V2_CLAUDE_POINTER_LINE), "the merged section carries no self-import");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-agentslink-real");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c NF-2/probe L3: a CLAUDE.md link to another regular file writes the line into that target", async () => {
  const RUN = "run-c2c-claudetarget";
  const fixture = await openFactoryPort("claudetarget", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    writeFileSync(join(worktree, "NOTES.md"), "# team notes\n");
    await runGit({ cwd: worktree, args: ["add", "--", "NOTES.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed notes file"] });
    await commitEntryLinkMode(worktree, "CLAUDE.md", "NOTES.md");
    await checkoutEntryLinkAsPlainFile(worktree, "CLAUDE.md", "NOTES.md");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the link layout completes instead of failing every snapshot");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.claudeLineCommitted, true);
    assert.equal(payload.claudeLineViaLink, "CLAUDE.md is a symbolic link to NOTES.md; the section is written into NOTES.md.");
    assert.equal(payload.agentsSectionCommitted, true);
    assert.ok(!("agentsSectionViaLink" in payload), "the regular AGENTS.md write needs no link reason");
    assert.equal(readFileSync(join(worktree, "CLAUDE.md"), "utf8"), "NOTES.md", "never written through the link");
    const target = readFileSync(join(worktree, "NOTES.md"), "utf8");
    assert.ok(target.split("\n").some((line) => line.trim() === V2_CLAUDE_POINTER_LINE), "the target holds the line");
    assert.ok(target.includes("# team notes"), "the target's own bytes survive");
    const commit = String(payload.commit);
    const mode = await runGit({ cwd: worktree, args: ["ls-tree", commit, "--", "CLAUDE.md"] });
    assert.match(mode.stdout.trim(), /^120000 blob/);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "NOTES.md", "docs/project/STATE.md"]);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-claudetarget");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c NF-2: an AGENTS.md link to a missing target is skipped with a reason, and the handoff completes", async () => {
  const RUN = "run-c2c-agentsmissing";
  const fixture = await openFactoryPort("agentsmissing", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    await commitEntryLinkMode(worktree, "AGENTS.md", "MISSING.md");
    await checkoutEntryLinkAsPlainFile(worktree, "AGENTS.md", "MISSING.md");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "no layout leaves the run unable to hand off");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, false);
    assert.match(String(payload.agentsSectionViaLink), /AGENTS\.md is a symbolic link to MISSING\.md.*not a regular tracked file/);
    assert.equal(payload.claudeLineCommitted, true);
    assert.equal(readFileSync(join(worktree, "AGENTS.md"), "utf8"), "MISSING.md", "the link is never touched");
    const commit = String(payload.commit);
    const mode = await runGit({ cwd: worktree, args: ["ls-tree", commit, "--", "AGENTS.md"] });
    assert.match(mode.stdout.trim(), /^120000 blob/);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["CLAUDE.md", "docs/project/STATE.md"]);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-agentsmissing");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c NF-2: an AGENTS.md link to an outside target is skipped with a reason, and the handoff completes", async () => {
  const RUN = "run-c2c-agentsoutside";
  const fixture = await openFactoryPort("agentsoutside", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    await commitEntryLinkMode(worktree, "AGENTS.md", "../outside.md");
    await checkoutEntryLinkAsPlainFile(worktree, "AGENTS.md", "../outside.md");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "no layout leaves the run unable to hand off");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, false);
    assert.match(String(payload.agentsSectionViaLink), /AGENTS\.md is a symbolic link to .*outside the repository/);
    assert.equal(payload.claudeLineCommitted, true);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-agentsoutside");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c NF-3/probe U1: a commit tree without the CLAUDE.md line is refused despite a live worktree link", async () => {
  const RUN = "run-c2c-uplink-uncommitted";
  const fixture = await openFactoryPort("uplinkuncommitted", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    // The old m5 layout: an UNTRACKED worktree symlink the commit tree
    // never holds. The gate reads the commit tree alone, so it refuses.
    symlinkSync("AGENTS.md", join(worktree, "CLAUDE.md"), "file");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 0, "no snapshot is recorded without commit-tree proof");
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    await assert.rejects(
      selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-uplink-uncommitted"),
      /kernel handoff snapshot/,
      "the owner's selection is refused while the proof is missing",
    );
  } finally {
    rmSync(join(fixture.integration.path, "CLAUDE.md"), { force: true });
    await fixture.close();
  }
});

test("C2c NF-3/probe U2: a commit tree holding a lineless CLAUDE.md is refused despite a live worktree link", async () => {
  const RUN = "run-c2c-uplink-replaced";
  const fixture = await openFactoryPort("uplinkreplaced", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    // A tracked regular CLAUDE.md with no pointer, replaced in the
    // worktree by an UNCOMMITTED symlink. The commit tree holds 100644
    // with no line, so the gate refuses even though the live checkout
    // links to AGENTS.md.
    writeFileSync(join(worktree, "CLAUDE.md"), "# user rules, no pointer\n");
    await runGit({ cwd: worktree, args: ["add", "--", "CLAUDE.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed regular claude file"] });
    rmSync(join(worktree, "CLAUDE.md"), { force: true });
    symlinkSync("AGENTS.md", join(worktree, "CLAUDE.md"), "file");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 0, "no snapshot is recorded without commit-tree proof");
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.ok(lstatSync(join(worktree, "CLAUDE.md")).isSymbolicLink(), "never written through the link");
    await assert.rejects(
      selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-uplink-replaced"),
      /kernel handoff snapshot/,
      "the owner's selection is refused while the proof is missing",
    );
  } finally {
    rmSync(join(fixture.integration.path, "CLAUDE.md"), { force: true });
    await fixture.close();
  }
});

test("C2c repair M-2/probe C9: a backslash link target from the index blob writes the section into the tracked target", async () => {
  const RUN = "run-c2c-repair-c9";
  const fixture = await openFactoryPort("repairbackslash", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    mkdirSync(join(worktree, "docs"), { recursive: true });
    writeFileSync(join(worktree, "docs", "notes.md"), "pre-existing notes\n");
    await runGit({ cwd: worktree, args: ["add", "--", "docs/notes.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed docs notes file"] });
    // Git for Windows stores a real-link target with a backslash; the
    // runner takes it from the index blob and normalizes it.
    await commitEntryLinkMode(worktree, "AGENTS.md", "docs\\notes.md");
    await checkoutEntryLinkAsPlainFile(worktree, "AGENTS.md", "docs\\notes.md");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the backslash-target layout completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, true);
    assert.equal(payload.agentsSectionViaLink, "AGENTS.md is a symbolic link to docs/notes.md; the section is written into docs/notes.md.");
    assert.equal(readFileSync(join(worktree, "AGENTS.md"), "utf8"), "docs\\notes.md", "the link entry is never touched");
    const target = readFileSync(join(worktree, "docs", "notes.md"), "utf8");
    assert.ok(target.includes(V2_AGENTS_SECTION_BODY), "the section is written into the regular tracked target");
    assert.ok(target.includes("pre-existing notes"), "the target's own bytes survive");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["CLAUDE.md", "docs/notes.md", "docs/project/STATE.md"]);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-repair-c9");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c repair M-5/probe C11: a dot-dot target that resolves inside is skipped with the real reason", async () => {
  const RUN = "run-c2c-repair-c11";
  const fixture = await openFactoryPort("repairdotdot", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    mkdirSync(join(worktree, "sub"), { recursive: true });
    await commitEntryLinkMode(worktree, "AGENTS.md", "sub/../CLAUDE.md");
    await checkoutEntryLinkAsPlainFile(worktree, "AGENTS.md", "sub/../CLAUDE.md");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "no layout leaves the run unable to hand off");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, false);
    assert.match(String(payload.agentsSectionViaLink), /uses "\.\." and is never followed \(it resolves inside the repository\)/, "the skip names the real reason");
    assert.equal(payload.claudeLineCommitted, true);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-repair-c11");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c repair M-5/probe C7: a kernel-owned redirect target is skipped with the real reason", async () => {
  const RUN = "run-c2c-repair-c7";
  const fixture = await openFactoryPort("repairkernelowned", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    mkdirSync(join(worktree, "docs", "project"), { recursive: true });
    writeFileSync(join(worktree, "docs", "project", "STATE.md"), "a user-owned state file\n");
    await runGit({ cwd: worktree, args: ["add", "--", "docs/project/STATE.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed a tracked STATE.md"] });
    await commitEntryLinkMode(worktree, "AGENTS.md", "docs/project/STATE.md");
    await checkoutEntryLinkAsPlainFile(worktree, "AGENTS.md", "docs/project/STATE.md");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "no layout leaves the run unable to hand off");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, false);
    assert.match(String(payload.agentsSectionViaLink), /target docs\/project\/STATE\.md is kernel-owned/, "the skip names the real reason");
    assert.equal(payload.claudeLineCommitted, true);
    const commit = String(payload.commit);
    const state = await runGit({ cwd: worktree, args: ["show", `${commit}:docs/project/STATE.md`] });
    assert.ok(verifyHandoffSnapshotDigest(state.stdout), "the kernel still writes its own STATE.md");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-repair-c7");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c repair cycle 4/probe RD-case: a link to notes.md when the index holds NOTES.md is refused and skipped", async () => {
  const RUN = "run-c2c-r4-rdcase";
  const fixture = await openFactoryPort("r4rdcase", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    writeFileSync(join(worktree, "NOTES.md"), "# team notes\n");
    await runGit({ cwd: worktree, args: ["add", "--", "NOTES.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed notes file"] });
    await commitEntryLinkMode(worktree, "AGENTS.md", "notes.md");
    await checkoutEntryLinkAsPlainFile(worktree, "AGENTS.md", "notes.md");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the case-variant redirect refusal still commits and completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, false);
    assert.match(String(payload.agentsSectionViaLink), /AGENTS\.md is a symbolic link to notes\.md.*not a regular tracked file/);
    assert.equal(payload.claudeLineCommitted, true);
    assert.equal(readFileSync(join(worktree, "AGENTS.md"), "utf8"), "notes.md", "the link is never touched");
    assert.equal(readFileSync(join(worktree, "NOTES.md"), "utf8"), "# team notes\n", "the case-variant target is never written");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["CLAUDE.md", "docs/project/STATE.md"]);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r4-rdcase");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c repair cycle 4/probe RD-case-real: a real link to notes.md when the index holds NOTES.md is refused and skipped", async () => {
  const RUN = "run-c2c-r4-rdcasereal";
  const fixture = await openFactoryPort("r4rdcasereal", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    writeFileSync(join(worktree, "NOTES.md"), "# team notes\n");
    await runGit({ cwd: worktree, args: ["config", "core.symlinks", "true"] });
    symlinkSync("notes.md", join(worktree, "AGENTS.md"), "file");
    await runGit({ cwd: worktree, args: ["add", "--", "AGENTS.md", "NOTES.md"] });
    const staged = await runGit({ cwd: worktree, args: ["ls-files", "-s", "--", "AGENTS.md"] });
    assert.match(staged.stdout.trim(), /^120000 /);
    await runGit({ cwd: worktree, args: ["commit", "-m", "link AGENTS.md to notes.md"] });
    assert.ok(lstatSync(join(worktree, "AGENTS.md")).isSymbolicLink());
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the case-variant redirect refusal still commits and completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, false);
    assert.match(String(payload.agentsSectionViaLink), /AGENTS\.md is a symbolic link to notes\.md.*not a regular tracked file/);
    assert.equal(payload.claudeLineCommitted, true);
    assert.ok(lstatSync(join(worktree, "AGENTS.md")).isSymbolicLink(), "never written through the link");
    assert.equal(readFileSync(join(worktree, "NOTES.md"), "utf8"), "# team notes\n", "the case-variant target is never written");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r4-rdcasereal");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});
