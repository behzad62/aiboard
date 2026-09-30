import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import type { IndependentVerifierDriver } from "../src/build-runtime.js";
import { verifyHandoffSnapshotDigest } from "../src/handoff-snapshot.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import {
  DEFAULT_STATE_TEMPLATE,
  V2_AGENTS_SECTION_BODY,
  V2_CLAUDE_POINTER_LINE,
  describeSnapshotCommitFacts,
  handoffStateBlockerSkipReason,
  handoffStateSkipReason,
  spliceMarkedArchitectSectionBytes,
} from "../src/project-docs.js";
import {
  type NewSchedulerEvent,
  type SchedulerActorRole,
  type SchedulerProjection,
} from "../src/scheduler-store.js";
import { deriveNativeVerifierRiskInput } from "../src/native-build-factory.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { runGit } from "./support/git-fixture.js";
import { acceptFinalVerificationProfile } from "./support/final-verification-profile.js";
import {
  CLOCK,
  SOURCE_TEXT,
  advancingClock,
  appendHandoffEvents,
  applyAutomaticHandoff,
  buildRuntimeForHandoff,
  checkoutDirLinkAsRealLink,
  checkoutEntryLinkAsPlainFile,
  commitEntryLinkMode,
  driveHandoff,
  failNextSnapshotReadOnce,
  fvRerunSeed,
  lowRiskSeed,
  managedHandle,
  managerSpec,
  openFactoryPort,
  openHandoffStore,
  readHandoffLog,
  safeSegment,
  seedEvent,
  selectHandoffOwner,
  silentArchitect,
  v2FinishSeed,
  v2PlanOnlySeed,
} from "./support/handoff-snapshot-harness.js";

/**
 * TX-2 handoff suite, file 6 of 8: folder links and case variants.
 *
 * Committed docs/project links, case variants, all-skip commits and the
 * withdrawn-stop reconciliation. The kept C2b B1-R/G2-prod end-to-end test
 * runs the full production manager (withdrawn-stop reconciliation plus
 * risk re-assessment); every other test drives the runtime's real snapshot
 * step directly through the harness (factory-built port, no manager pump).
 * The W-CI probes use the factory-built port like every other test.
 */

/**
 * FX-1: production-shaped independent verifier for the kept G2-prod
 * end-to-end test. Risk comes from the real kernel derivation
 * (deriveNativeVerifierRiskInput); low risk never reaches verify. The
 * factory already configured the risk_based policy with these candidates,
 * so the driver matches it exactly.
 */
function productionRiskVerifier(
  runId: string,
  store: () => SqliteSchedulerStore,
  counter: { calls: number },
): IndependentVerifierDriver {
  return {
    candidateRuntimeIds: ["rev:reviewer"],
    alwaysRequireIndependentVerifier: false,
    assessRisk: async ({ projection }) => {
      counter.calls += 1;
      return deriveNativeVerifierRiskInput({
        projection,
        sessions: [],
        schedulerEvents: store().readRun(runId),
        toolEvents: [],
        stricterQualification: false,
      });
    },
    verify: async () => {
      throw new Error("A low-risk run must never reach independent verification.");
    },
  };
}

/**
 * FX-1: step until the runtime records the post-guidance re-assessment (or
 * the bound runs out). The assessment precedes any completion turn, so the
 * bounded walk never reaches a second Architect turn.
 */
async function stepUntilRiskReassessed(
  manager: NativeBuildManager,
  runId: string,
  maxSteps = 10,
): Promise<void> {
  for (let index = 0; index < maxSteps; index += 1) {
    if (manager.events(runId).filter((event) => event.type === "build.risk_assessed").length >= 2) return;
    await manager.step(runId);
  }
}

test("C2b repair B1-R/G2-prod: the G2 flow through the production manager with the factory's port", async () => {
  const RUN = "run-c2b-g2prod";
  // KEY LESSON: the port below is read off the factory-built runtime, never
  // hand-built -- this is the round-1 G2 probe through the production
  // manager with the factory's own wiring.
  // The factory re-validates final-verification profiles against its audit
  // archive on read, so FV events land after create through the harness
  // store (which accepts the fixture profile); the factory store never
  // re-reads once its runtime is built.
  const preSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(runId, baseline).filter((event) => !event.type.startsWith("final_verification."));
  const fvSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(runId, baseline).filter((event) => event.type.startsWith("final_verification."));
  const fixture = await openFactoryPort("g2prod", RUN, preSeed, "finish");
  // The stop-1 commit lands, then the read-back fails: a transient failure
  // after the commit (or a crash before the append).
  failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
  const architect = silentArchitect("The build is complete and verified.");
  // FX-1: the harness runtime re-assesses through the real kernel
  // derivation after the FV re-run (no seeded re-assessment).
  const verifierCalls = { calls: 0 };
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  const order: string[] = [];
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(fixture.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(join(fixture.state, "builds", safeSegment(RUN), "scheduler.sqlite"), {
          evidenceStore: fixture.evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: fixture.port,
          architect, clock: advancingClock(), runPolicy: "finish", evidenceStore: fixture.evidence,
          independentVerifier: productionRiskVerifier(RUN, () => store!, verifierCalls),
        });
        return managedHandle(runtime, async () => {
          order.push(`projectHandoff:${manager!.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length}`);
          const result = await fixture.integration.applyToProject();
          order.push("applied");
          return result;
        }, RUN);
      },
    });
    await manager.create(managerSpec(RUN, "finish"));
    assert.ok(store);
    for (const input of fvSeed(RUN, fixture.baselineRevision)) store.append(input);
    // The factory's risk_based verifier policy is already in the shared log
    // (factory.create); qualify the green FV generation before completion.
    for (const input of lowRiskSeed(RUN, fixture.baselineRevision)) store.append(input);
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    assert.deepEqual(order, [], "no project mutation precedes the kernel record");
    assert.equal(existsSync(join(fixture.project, "docs", "project", "STATE.md")), false, "the project is untouched");
    const landed = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), "1", "the stop-1 kernel commit landed");
    const stop1 = manager.events(RUN).find((event) => event.type === "project.handoff_requested")!.sequence;
    // The owner submits guidance instead of resuming: the handoff is
    // withdrawn. The Architect acknowledges with no plan change.
    assert.ok(store);
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    store.append(e("user.guidance_submitted", "guidance-1", "user", "local-user", {
      guidanceId: "guidance-1",
      text: "Hold the handoff and re-verify the plan.",
      version: 1,
      interruptionProtocolVersion: 1,
    }));
    store.append(e("user.guidance_interruption_completed", "guidance-1:interruption", "runner", "build-manager", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
    }));
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
    store.append(e("user.guidance_acknowledged", "guidance-1:ack", "architect", "architect", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
      resolution: {
        type: "no_plan_change",
        rationale: "The initial plan already incorporates the durable guidance.",
        evidenceIds: [acknowledgementEvidence.id],
      },
    }));
    const withdrawn = manager.projection(RUN);
    assert.equal(withdrawn.projectHandoff, undefined, "guidance withdrew the handoff");
    assert.equal((withdrawn.projectHandoffHistory ?? []).length, 1);
    // Final verification re-runs green on the unchanged canonical revision.
    for (const input of fvRerunSeed(RUN, fixture.baselineRevision)) store.append(input);
    // FX-1: guidance invalidated the stop-1 assessment; the runtime
    // re-assesses through the real derivation before the Architect
    // re-requests (stop 2).
    await stepUntilRiskReassessed(manager, RUN);
    const risks = manager.events(RUN).filter((event) => event.type === "build.risk_assessed");
    assert.equal(risks.length, 2, "production re-assesses after the invalidation");
    assert.equal(
      risks[1]!.idempotencyKey,
      `build-risk:${fixture.baselineRevision}:generation-c2a-finish-rerun`,
      "the re-assessment is keyed by the re-run generation",
    );
    assert.ok(verifierCalls.calls <= 3, `no assessRisk spin (${verifierCalls.calls} calls)`);
    // FX-2: the Architect's real second complete_run records stop 2 (no
    // seeded re-request); the run then reconciles and completes.
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // The withdrawn stop's landed commit was recorded as history before the
    // next stop committed: two snapshot events, one chain.
    const restop = manager.events(RUN).filter((event) => event.type === "project.handoff_requested");
    assert.equal(restop.length, 2, "the second complete_run records a new request");
    assert.equal(restop[0]!.idempotencyKey, "project-handoff-requested");
    assert.equal(restop[1]!.idempotencyKey, "project-handoff-requested:1");
    assert.equal(architect.calls(), 2, "stop 1 plus the real re-request; the kernel snapshot itself makes no model call");
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 2);
    const first = snapshots[0]!.payload as Record<string, unknown>;
    const second = snapshots[1]!.payload as Record<string, unknown>;
    assert.equal(first.stopSequence, stop1, "the withdrawn stop is recorded first, as history");
    assert.equal(second.stopSequence, restop[restop.length - 1]!.sequence, "the second record belongs to the re-request");
    assert.equal(second.parent, first.commit, "the new snapshot continues the withdrawn commit");
    assert.equal(manager.projection(RUN).projectDocs?.documentTip, second.commit);
    const projection = manager.projection(RUN);
    assert.equal(projection.status, "completed", "the handoff succeeds after reconciliation");
    assert.equal(projection.projectHandoff?.choice, "apply_to_project");
    assert.deepEqual(order, ["projectHandoff:2", "applied"], "the project changes only after the kernel accepts");
    const stateShow = await runGit({ cwd: fixture.integration.path, args: ["show", `${String(second.commit)}:docs/project/STATE.md`] });
    const applied = await runGit({ cwd: fixture.project, args: ["show", "HEAD:docs/project/STATE.md"] });
    assert.equal(applied.stdout, stateShow.stdout, "the project holds the reconciled snapshot");
  } finally {
    await manager?.close();
    store?.close();
    await fixture.close();
  }
});

test("C2c repair BL-1/probe A1: a committed specs-dir link to an absolute outside target writes nothing outside", async () => {
  const RUN = "run-c2c-repair-a1";
  const fixture = await openFactoryPort("repairabslink", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = mkdtempSync(join(tmpdir(), "aiboard-c2c-outside-a1-"));
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    mkdirSync(join(worktree, "docs", "project"), { recursive: true });
    await commitEntryLinkMode(worktree, "docs/project/specs", outside);
    await checkoutDirLinkAsRealLink(worktree, "docs/project/specs");
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    assert.deepEqual(readdirSync(outside), [], "nothing is written outside the repository");
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the link layout still commits and completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.specCopySkipped, "write_failed", "the copy is skipped with a reason");
    assert.ok(!("specCopied" in payload), "no copy is claimed");
    assert.ok(!("specPath" in payload), "no copy path is recorded");
    assert.ok(!("stateSkippedReason" in payload), "a committed STATE.md never carries a skip reason");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    const state = await runGit({ cwd: worktree, args: ["show", `${commit}:docs/project/STATE.md`] });
    assert.ok(state.stdout.includes("spec: not recorded"), "the snapshot names no spec path the commit does not hold");
    const treeMode = await runGit({ cwd: worktree, args: ["ls-tree", commit, "--", "docs/project/specs"] });
    assert.match(treeMode.stdout.trim(), /^120000 /, "the commit still carries the link");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-repair-a1");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("C2c repair BL-1/probe A2: a committed specs-dir link to a relative outside target writes nothing outside", async () => {
  const RUN = "run-c2c-repair-a2";
  const fixture = await openFactoryPort("repairrellink", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = join(fixture.root, "zz-outside-specs-rel");
  mkdirSync(outside, { recursive: true });
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    mkdirSync(join(worktree, "docs", "project"), { recursive: true });
    const target = relative(join(worktree, "docs", "project"), outside);
    await commitEntryLinkMode(worktree, "docs/project/specs", target);
    await checkoutDirLinkAsRealLink(worktree, "docs/project/specs");
    assert.equal(readlinkSync(join(worktree, "docs", "project", "specs")), target);
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    assert.deepEqual(readdirSync(outside), [], "nothing is written outside the repository");
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the link layout still commits and completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.specCopySkipped, "write_failed", "the copy is skipped with a reason");
    assert.ok(!("specCopied" in payload), "no copy is claimed");
    assert.ok(!("specPath" in payload), "no copy path is recorded");
    assert.ok(!("stateSkippedReason" in payload), "a committed STATE.md never carries a skip reason");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    const state = await runGit({ cwd: worktree, args: ["show", `${commit}:docs/project/STATE.md`] });
    assert.ok(state.stdout.includes("spec: not recorded"), "the snapshot names no spec path the commit does not hold");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-repair-a2");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("C2c repair CD-17/probe A3: a committed docs/project link writes nothing outside and still completes", async () => {
  const RUN = "run-c2c-repair-a3";
  const fixture = await openFactoryPort("repairprojlink", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = mkdtempSync(join(tmpdir(), "aiboard-c2c-outside-a3-"));
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    mkdirSync(join(worktree, "docs"), { recursive: true });
    await commitEntryLinkMode(worktree, "docs/project", outside);
    await checkoutDirLinkAsRealLink(worktree, "docs/project");
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    assert.deepEqual(readdirSync(outside), [], "nothing is written outside the repository");
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the link layout still commits and completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.match(String(payload.stateSkippedReason), /docs\/project is a symbolic link or junction/, "the STATE.md skip is recorded");
    assert.equal(payload.bodyDigest, "", "no STATE.md is committed, so no digest is recorded");
    assert.equal(payload.specCopySkipped, "write_failed", "the copy under the link is skipped too");
    assert.ok(!("specPath" in payload), "no copy path is recorded");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md"]);
    const treeMode = await runGit({ cwd: worktree, args: ["ls-tree", commit, "--", "docs/project"] });
    assert.match(treeMode.stdout.trim(), /^120000 /, "the commit still carries the link");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-repair-a3");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("C2c repair CD-17/probe A3n: a committed docs/project link with no spec due completes with a recorded reason", async () => {
  const RUN = "run-c2c-repair-a3n";
  const fixture = await openFactoryPort("repairprojlinkn", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = mkdtempSync(join(tmpdir(), "aiboard-c2c-outside-a3n-"));
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    mkdirSync(join(worktree, "docs"), { recursive: true });
    await commitEntryLinkMode(worktree, "docs/project", outside);
    await checkoutDirLinkAsRealLink(worktree, "docs/project");
    const driven = await driveHandoff(fixture, RUN, { architect });
    assert.deepEqual(readdirSync(outside), [], "nothing is written outside the repository");
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the link layout still commits and completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.match(String(payload.stateSkippedReason), /docs\/project is a symbolic link or junction/, "the STATE.md skip is recorded");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md"]);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-repair-a3n");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("C2c repair CD-17/probe A4: a committed docs link writes nothing outside and still completes", async () => {
  const RUN = "run-c2c-repair-a4";
  const fixture = await openFactoryPort("repairdocslink", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = mkdtempSync(join(tmpdir(), "aiboard-c2c-outside-a4-"));
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    await commitEntryLinkMode(worktree, "docs", outside);
    await checkoutDirLinkAsRealLink(worktree, "docs");
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    assert.deepEqual(readdirSync(outside), [], "nothing is written outside the repository");
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the link layout still commits and completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.match(String(payload.stateSkippedReason), /docs is a symbolic link or junction/, "the STATE.md skip names the docs link");
    assert.equal(payload.bodyDigest, "", "no STATE.md is committed, so no digest is recorded");
    assert.equal(payload.specCopySkipped, "write_failed", "the copy under the link is skipped too");
    assert.ok(!("specPath" in payload), "no copy path is recorded");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md"]);
    const treeMode = await runGit({ cwd: worktree, args: ["ls-tree", commit, "--", "docs"] });
    assert.match(treeMode.stdout.trim(), /^120000 /, "the commit still carries the link");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-repair-a4");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("C2c repair M-1/probe D1: a junction above a redirect target refuses the redirect and writes nothing outside", async () => {
  const RUN = "run-c2c-repair-d1";
  const fixture = await openFactoryPort("repairjunction", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outsideRoot = mkdtempSync(join(tmpdir(), "aiboard-c2c-outside-d1-"));
  const outsideSub = join(outsideRoot, "sub");
  mkdirSync(outsideSub, { recursive: true });
  writeFileSync(join(outsideSub, "notes.md"), "outside notes\n");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    // sub/notes.md is a tracked regular file; then the worktree sub is
    // replaced out-of-band by a junction to an outside directory.
    mkdirSync(join(worktree, "sub"), { recursive: true });
    writeFileSync(join(worktree, "sub", "notes.md"), "inside notes\n");
    await runGit({ cwd: worktree, args: ["add", "--", "sub/notes.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed sub notes file"] });
    await commitEntryLinkMode(worktree, "AGENTS.md", "sub/notes.md");
    await checkoutEntryLinkAsPlainFile(worktree, "AGENTS.md", "sub/notes.md");
    rmSync(join(worktree, "sub"), { recursive: true, force: true });
    symlinkSync(outsideSub, join(worktree, "sub"), "junction");
    const driven = await driveHandoff(fixture, RUN, { architect });
    assert.equal(readFileSync(join(outsideSub, "notes.md"), "utf8"), "outside notes\n", "nothing is written outside the repository");
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the refused redirect still commits and completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, false);
    assert.match(String(payload.agentsSectionViaLink), /AGENTS\.md is a symbolic link to sub\/notes\.md/, "the redirect refusal is recorded");
    assert.match(String(payload.agentsSectionViaLink), /sub is a symbolic link or junction/, "the reason names the junction above the target");
    assert.equal(payload.claudeLineCommitted, true);
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["CLAUDE.md", "docs/project/STATE.md"]);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-repair-d1");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("C2c round 3/probe DUP-A4: a docs link with entry files already current commits empty and completes", async () => {
  const RUN = "run-c2c-r3-dupa4";
  const fixture = await openFactoryPort("r3dupa4", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = mkdtempSync(join(tmpdir(), "aiboard-c2c-outside-dupa4-"));
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    // What an earlier AIBoard handoff leaves in the project: both entry
    // files already hold exactly the v2 section and line.
    writeFileSync(join(worktree, "AGENTS.md"), spliceMarkedArchitectSectionBytes(null, V2_AGENTS_SECTION_BODY));
    writeFileSync(join(worktree, "CLAUDE.md"), spliceMarkedArchitectSectionBytes(null, V2_CLAUDE_POINTER_LINE));
    await runGit({ cwd: worktree, args: ["add", "--", "AGENTS.md", "CLAUDE.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "entry files from an earlier handoff"] });
    await commitEntryLinkMode(worktree, "docs", outside);
    await checkoutDirLinkAsRealLink(worktree, "docs");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the empty snapshot commit is recorded instead of a pump error");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.deepEqual(payload.paths, [], "nothing changed, so the kernel commit holds no paths");
    assert.match(String(payload.stateSkippedReason), /docs is a symbolic link or junction/);
    assert.deepEqual(readdirSync(outside), [], "nothing is written outside the repository");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r3-dupa4");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("C2c round 3/probe CI-lm: a committed capital-Docs link checked out as a plain file skips STATE.md and completes", async () => {
  const RUN = "run-c2c-r3-cilm";
  const fixture = await openFactoryPort("r3cilm", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = mkdtempSync(join(tmpdir(), "aiboard-c2c-outside-cilm-"));
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    await runGit({ cwd: worktree, args: ["config", "core.ignorecase", "true"] });
    await commitEntryLinkMode(worktree, "Docs", outside);
    await checkoutEntryLinkAsPlainFile(worktree, "Docs", outside);
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the case-folded index check finds the Docs link at stage time");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.match(String(payload.stateSkippedReason), /docs is a symbolic link or junction/);
    assert.deepEqual(readdirSync(outside), [], "nothing is written outside the repository");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r3-cilm");
    assert.equal(selected.status, "completed");
    await assert.rejects(
      fixture.integration.commitProjectDocuments({
        writes: [{ path: "docs/project/STATE.md", content: DEFAULT_STATE_TEMPLATE }],
        summary: "Record documents",
        runId: RUN,
        requestId: "project-doc:cilm:docs/project/STATE.md",
      }),
      /is refused because docs is a symbolic link or junction/,
      "v1 gives the declared CD-17 refusal, not ENOTDIR",
    );
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("C2c repair cycle 4/probe ALL-SKIP: every write skipped still records an empty snapshot commit and completes", async () => {
  const RUN = "run-c2c-r4-allskip";
  const fixture = await openFactoryPort("r4allskip", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = mkdtempSync(join(tmpdir(), "aiboard-c2c-outside-allskip-"));
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    await commitEntryLinkMode(worktree, "docs", outside);
    await checkoutDirLinkAsRealLink(worktree, "docs");
    await commitEntryLinkMode(worktree, "AGENTS.md", "MISSING.md");
    await checkoutEntryLinkAsPlainFile(worktree, "AGENTS.md", "MISSING.md");
    await commitEntryLinkMode(worktree, "CLAUDE.md", "AGENTS.md");
    await checkoutEntryLinkAsPlainFile(worktree, "CLAUDE.md", "AGENTS.md");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "every skip recorded still commits instead of throwing wrote-nothing");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.deepEqual(payload.paths, [], "nothing was staged, so the kernel commit holds no paths");
    assert.match(String(payload.stateSkippedReason), /docs is a symbolic link or junction/);
    assert.equal(payload.bodyDigest, "", "no STATE.md is committed, so no digest is recorded");
    assert.equal(payload.agentsSectionCommitted, false);
    assert.match(String(payload.agentsSectionViaLink), /AGENTS\.md is a symbolic link to MISSING\.md.*not a regular tracked file/);
    assert.equal(payload.claudeLineViaLink, "CLAUDE.md is a symbolic link to AGENTS.md");
    assert.deepEqual(readdirSync(outside), [], "nothing is written outside the repository");
    const commit = String(payload.commit);
    const parent = String(payload.parent);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), [], "the empty commit stages nothing");
    const treeDiff = await runGit({ cwd: worktree, args: ["diff", "--quiet", parent, commit], allowFailure: true });
    assert.equal(treeDiff.exitCode, 0, "the empty commit holds its parent's tree");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r4-allskip");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("C2c repair cycle 4/probe ALL-SKIP-out: links to outside files still record an empty snapshot commit and complete", async () => {
  const RUN = "run-c2c-r4-allskipout";
  const fixture = await openFactoryPort("r4allskipout", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = mkdtempSync(join(tmpdir(), "aiboard-c2c-outside-allskipout-"));
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    await commitEntryLinkMode(worktree, "docs", outside);
    await checkoutDirLinkAsRealLink(worktree, "docs");
    await commitEntryLinkMode(worktree, "AGENTS.md", join(outside, "a.md"));
    await checkoutEntryLinkAsPlainFile(worktree, "AGENTS.md", join(outside, "a.md"));
    await commitEntryLinkMode(worktree, "CLAUDE.md", join(outside, "c.md"));
    await checkoutEntryLinkAsPlainFile(worktree, "CLAUDE.md", join(outside, "c.md"));
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "every skip recorded still commits instead of throwing wrote-nothing");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.deepEqual(payload.paths, [], "nothing was staged, so the kernel commit holds no paths");
    assert.match(String(payload.stateSkippedReason), /docs is a symbolic link or junction/);
    assert.equal(payload.agentsSectionCommitted, false);
    assert.match(String(payload.agentsSectionViaLink), /AGENTS\.md is a symbolic link to .*outside the repository/);
    assert.match(String(payload.claudeLineViaLink), /CLAUDE\.md is a symbolic link to .*outside the repository/);
    assert.deepEqual(readdirSync(outside), [], "nothing is written outside the repository");
    const commit = String(payload.commit);
    const parent = String(payload.parent);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), [], "the empty commit stages nothing");
    const treeDiff = await runGit({ cwd: worktree, args: ["diff", "--quiet", parent, commit], allowFailure: true });
    assert.equal(treeDiff.exitCode, 0, "the empty commit holds its parent's tree");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r4-allskipout");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("C2e/m-11 unclean index reason: the empty-commit refusal names the unclean index", async () => {
  const RUN = "run-c2e-m11dirty";
  const fixture = await openFactoryPort("c2em11dirty", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = mkdtempSync(join(tmpdir(), "aiboard-c2e-outside-m11-"));
  try {
    const worktree = fixture.integration.path;
    await commitEntryLinkMode(worktree, "docs", outside);
    await checkoutDirLinkAsRealLink(worktree, "docs");
    await commitEntryLinkMode(worktree, "AGENTS.md", "MISSING.md");
    await checkoutEntryLinkAsPlainFile(worktree, "AGENTS.md", "MISSING.md");
    await commitEntryLinkMode(worktree, "CLAUDE.md", "AGENTS.md");
    await checkoutEntryLinkAsPlainFile(worktree, "CLAUDE.md", "AGENTS.md");
    // An unrelated staged file makes the integration index unclean while
    // every handoff write is skipped.
    writeFileSync(join(worktree, "unrelated.txt"), "unrelated\n");
    await runGit({ cwd: worktree, args: ["add", "--", "unrelated.txt"] });
    const before = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    await assert.rejects(
      () => fixture.integration.commitHandoffSnapshot({
        writes: [
          { path: "docs/project/STATE.md", content: "kernel body\n" },
          { path: "AGENTS.md", content: V2_AGENTS_SECTION_BODY },
          { path: "CLAUDE.md", content: V2_CLAUDE_POINTER_LINE },
        ],
        summary: `AIBoard handoff snapshot (plan_only) for run ${RUN}`,
        runId: RUN,
        snapshotKey: "handoff-snapshot:9",
      }),
      /integration index is not clean/,
      "the refusal names the unclean index instead of the recorded skips",
    );
    const after = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(after.stdout.trim(), before.stdout.trim(), "the refused commit lands nothing");
    const staged = await runGit({ cwd: worktree, args: ["diff", "--cached", "--name-only"] });
    assert.match(staged.stdout, /unrelated\.txt/, "the staged stranger is left alone");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

/**
 * C2c repair cycle 4 (NB-7): a withdrawn stop whose commit holds a `Docs`
 * link reconciles from its OWN commit even after the worktree drops that
 * spelling. The finish-run harness mirrors G2: stop 1's snapshot commit
 * lands, the read-back fails, guidance withdraws, a later integration
 * commit changes `Docs`, FV re-runs and the stop is re-requested (stop 2).
 *
 * Unlike the original hand-built port, the port under test is the one
 * NativeBuildFactory builds; fault injection patches the factory's own
 * integration manager instance.
 */
async function driveWithdrawnDocsLinkScenario(
  label: string,
  runId: string,
  mutateDocs: (worktree: string) => Promise<string>,
): Promise<{
  snapshots: Array<Record<string, unknown>>;
  stop1: number;
  mutatedHead: string;
  projection: SchedulerProjection;
  outside: string[];
  outsideOwnText: string;
}> {
  const preSeed = (seedRunId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(seedRunId, baseline).filter((event) => !event.type.startsWith("final_verification."));
  const fvSeed = (seedRunId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(seedRunId, baseline).filter((event) => event.type.startsWith("final_verification."));
  const fixture = await openFactoryPort(label, runId, preSeed, "finish");
  appendHandoffEvents(fixture, runId, fvSeed(runId, fixture.baselineRevision));
  // The factory's risk_based verifier policy is already in the shared log
  // (factory.create): qualify the green FV generation before completion.
  appendHandoffEvents(fixture, runId, lowRiskSeed(runId, fixture.baselineRevision));
  const outside = mkdtempSync(join(tmpdir(), `aiboard-c2c-outside-${label}-`));
  writeFileSync(join(outside, "own.txt"), "outside\n");
  // The checkout holds a committed `Docs` link to an outside directory. The
  // target uses forward slashes: a backslash blob checks out with slashes,
  // which would leave the worktree disagreeing with the index.
  await commitEntryLinkMode(fixture.integration.path, "Docs", outside.replace(/\\/g, "/"));
  await checkoutDirLinkAsRealLink(fixture.integration.path, "Docs");
  // Stop 1's snapshot commit lands, then the read-back fails: a transient
  // failure after the commit.
  failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
  const architect = silentArchitect("The build is complete and verified.");
  // FX-1 (the B2/G3 pattern): after guidance invalidates the stop-1
  // assessment, the second drive re-assesses through the real kernel
  // derivation and the Architect's real second complete_run re-requests
  // (stop 2) -- no seeded risk event, no seeded re-request.
  const verifierCalls = { calls: 0 };
  const riskStores: SqliteSchedulerStore[] = [];
  const verifier = productionRiskVerifier(runId, () => {
    const store = openHandoffStore(fixture, runId);
    riskStores.push(store);
    return store;
  }, verifierCalls);
  const driveOpts = { runPolicy: "finish" as const, architect, independentVerifier: verifier };
  try {
    let driven = await driveHandoff(fixture, runId, { runPolicy: "finish", architect });
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    // Untouched-so-far fact only: the harness never auto-applies, so this
    // cannot prove manager ordering (proved by C2a B1+M6, not here).
    assert.equal(existsSync(join(fixture.project, "docs", "project", "STATE.md")), false, "the project is still untouched (the harness never auto-applies)");
    const landed = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), "2", "the link commit plus the stop-1 kernel commit landed");
    const stop1 = driven.events.find((event) => event.type === "project.handoff_requested")!.sequence;
    // The owner submits guidance instead of resuming: the handoff is
    // withdrawn. The Architect acknowledges with no plan change.
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(runId, type, key, role, id, payload);
    const acknowledgementEvidence = fixture.evidence.record({
      runId,
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
    appendHandoffEvents(fixture, runId, [
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
    ]);
    const withdrawn = readHandoffLog(fixture, runId).projection;
    assert.equal(withdrawn.projectHandoff, undefined, "guidance withdrew the handoff");
    assert.equal((withdrawn.projectHandoffHistory ?? []).length, 1);
    // A later integration commit changes `Docs` (removed, or replaced by a
    // real directory): the live worktree no longer holds the old spelling.
    // The removal is recorded as the new integration revision (as production
    // records any later integration commit), so stop 2 continues the
    // document chain from it instead of dangling past the runner's tracking.
    const mutatedHead = await mutateDocs(fixture.integration.path);
    appendHandoffEvents(fixture, runId, [
      e("integration.revision_advanced", "integration-revision-docs-change", "runner", "integration", {
        integrationRevision: mutatedHead,
      }),
      ...fvRerunSeed(runId, mutatedHead),
    ]);
    // Guidance invalidated the stop-1 assessment, so the drive re-assesses
    // the re-run revision through the real kernel derivation (driveOpts)
    // before the Architect's real second complete_run re-requests (stop 2).
    driven = await driveHandoff(fixture, runId, driveOpts);
    for (const store of riskStores.splice(0)) store.close();
    const risks = driven.events.filter((event) => event.type === "build.risk_assessed");
    assert.equal(risks.length, 2, "the runtime re-assesses after the invalidation");
    assert.equal(
      risks[1]!.idempotencyKey,
      `build-risk:${mutatedHead}:generation-c2a-finish-rerun`,
      "the re-assessment is keyed by the re-run revision and generation",
    );
    assert.ok(verifierCalls.calls <= 3, `no assessRisk spin (${verifierCalls.calls} calls)`);
    assert.equal(architect.calls(), 2, "stop 1 plus the real re-request; the kernel snapshot itself makes no model call");
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    const projection = await applyAutomaticHandoff(fixture, runId, { runPolicy: "finish" });
    const outsideFiles = readdirSync(outside);
    const outsideOwnText = readFileSync(join(outside, "own.txt"), "utf8");
    return {
      snapshots: snapshots.map((event) => event.payload as Record<string, unknown>),
      stop1,
      mutatedHead,
      projection,
      outside: outsideFiles,
      outsideOwnText,
    };
  } finally {
    for (const store of riskStores.splice(0)) store.close();
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
}

test("C2c repair cycle 4/probe W-CI-rm: a withdrawn stop reconciles its committed Docs link after Docs is removed", async () => {
  const RUN = "run-c2c-r4-wcirm";
  const { snapshots, stop1, mutatedHead, projection, outside, outsideOwnText } = await driveWithdrawnDocsLinkScenario(
    "r4wcirm",
    RUN,
    async (worktree) => {
      await runGit({ cwd: worktree, args: ["rm", "--", "Docs"] });
      await runGit({ cwd: worktree, args: ["commit", "-m", "remove the Docs link"] });
      return (await runGit({ cwd: worktree, args: ["rev-parse", "HEAD"] })).stdout.trim();
    },
  );
  assert.equal(snapshots.length, 2, "the withdrawn stop is recorded as history before stop 2 commits");
  const first = snapshots[0]!;
  const second = snapshots[1]!;
  assert.equal(first.stopSequence, stop1, "the withdrawn stop is recorded first, as history");
  assert.match(String(first.stateSkippedReason), /docs is a symbolic link or junction/, "the withdrawn stop is described from its own commit");
  const restop = second.stopSequence;
  assert.ok(typeof restop === "number" && restop !== stop1, "the second record belongs to the re-request");
  assert.equal(second.parent, mutatedHead, "the new snapshot commits on the post-removal head");
  assert.ok((second.paths as string[]).includes("docs/project/STATE.md"), "stop 2 commits STATE.md");
  assert.ok(!("stateSkippedReason" in second), "stop 2 holds no skip");
  assert.equal(projection.status, "completed", "the run hands off after reconciliation");
  assert.equal(projection.projectHandoff?.choice, "apply_to_project");
  assert.deepEqual(outside, ["own.txt"], "nothing is written outside the repository");
  assert.equal(outsideOwnText, "outside\n");
});

test("C2c repair cycle 4/probe W-CI-mv: a withdrawn stop reconciles its committed Docs link after Docs becomes a real directory", async () => {
  const RUN = "run-c2c-r4-wcimv";
  const { snapshots, stop1, mutatedHead, projection, outside, outsideOwnText } = await driveWithdrawnDocsLinkScenario(
    "r4wcimv",
    RUN,
    async (worktree) => {
      await runGit({ cwd: worktree, args: ["rm", "--", "Docs"] });
      mkdirSync(join(worktree, "docs", "project"), { recursive: true });
      writeFileSync(join(worktree, "docs", "project", ".keep"), "real directory\n");
      await runGit({ cwd: worktree, args: ["add", "--", "docs"] });
      await runGit({ cwd: worktree, args: ["commit", "-m", "replace the Docs link with a real docs directory"] });
      return (await runGit({ cwd: worktree, args: ["rev-parse", "HEAD"] })).stdout.trim();
    },
  );
  assert.equal(snapshots.length, 2, "the withdrawn stop is recorded as history before stop 2 commits");
  const first = snapshots[0]!;
  const second = snapshots[1]!;
  assert.equal(first.stopSequence, stop1, "the withdrawn stop is recorded first, as history");
  assert.match(String(first.stateSkippedReason), /docs is a symbolic link or junction/, "the withdrawn stop is described from its own commit");
  const restop = second.stopSequence;
  assert.ok(typeof restop === "number" && restop !== stop1, "the second record belongs to the re-request");
  assert.equal(second.parent, mutatedHead, "the new snapshot commits on the post-replacement head");
  assert.ok((second.paths as string[]).includes("docs/project/STATE.md"), "stop 2 commits STATE.md");
  assert.ok(!("stateSkippedReason" in second), "stop 2 holds no skip");
  assert.equal(projection.status, "completed", "the run hands off after reconciliation");
  assert.equal(projection.projectHandoff?.choice, "apply_to_project");
  assert.deepEqual(outside, ["own.txt"], "nothing is written outside the repository");
  assert.equal(outsideOwnText, "outside\n");
});

test("C2d/probe DOCS-dir: a regular capital Docs directory hands off through the index spelling", async () => {
  const RUN = "run-c2d-docsdir";
  const fixture = await openFactoryPort("c2ddocsdir", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = join(fixture.root, "zz-outside-c2d-docsdir");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "own.txt"), "outside\n");
    await runGit({ cwd: worktree, args: ["config", "core.ignorecase", "true"] });
    // A regular capital `Docs/` directory (not a link): git stores
    // `Docs/project/STATE.md`, so the canonical commit pathspec matches
    // nothing on a case-insensitive checkout.
    mkdirSync(join(worktree, "Docs", "project"), { recursive: true });
    writeFileSync(join(worktree, "Docs", "project", "keep.md"), "user keep\n");
    await runGit({ cwd: worktree, args: ["add", "--", "Docs/project/keep.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed a regular capital Docs directory"] });
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the run hands off instead of wedging on the pathspec");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.ok(!("stateSkippedReason" in payload), "STATE.md is committed, not skipped");
    assert.deepEqual(
      payload.paths,
      ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"],
      "the event reports the canonical handoff spellings",
    );
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(
      files.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
      ["AGENTS.md", "CLAUDE.md", "Docs/project/STATE.md"],
      "the commit holds the index's own spelling",
    );
    const state = await runGit({ cwd: worktree, args: ["show", `${commit}:Docs/project/STATE.md`] });
    assert.equal(verifyHandoffSnapshotDigest(state.stdout), true, "the committed STATE.md verifies");
    assert.equal(
      verifyHandoffSnapshotDigest(readFileSync(join(worktree, "Docs", "project", "STATE.md"), "utf8")),
      true,
      "the write landed in the committed file",
    );
    const status = await runGit({ cwd: worktree, args: ["status", "--porcelain"] });
    assert.equal(status.stdout.trim(), "", "no write landed in a file the commit does not record");
    assert.equal(readFileSync(join(outside, "own.txt"), "utf8"), "outside\n", "nothing is written outside the repository");
    assert.equal(existsSync(join(fixture.project, "docs")), false, "the project is still untouched");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2d-docsdir");
    assert.equal(selected.status, "completed", "the owner selection completes");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("C2d/probe D-walk-projdir: a regular docs/Project directory hands off through the index spelling", async () => {
  const RUN = "run-c2d-projdir";
  const fixture = await openFactoryPort("c2dprojdir", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = join(fixture.root, "zz-outside-c2d-projdir");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "own.txt"), "outside\n");
    await runGit({ cwd: worktree, args: ["config", "core.ignorecase", "true"] });
    // The same case-variant class one level down: git stores
    // `docs/Project/keep.md`, so the canonical STATE.md pathspec matches
    // nothing on a case-insensitive checkout.
    mkdirSync(join(worktree, "docs", "Project"), { recursive: true });
    writeFileSync(join(worktree, "docs", "Project", "keep.md"), "user keep\n");
    await runGit({ cwd: worktree, args: ["add", "--", "docs/Project/keep.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed a regular docs/Project directory"] });
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the run hands off instead of wedging on the pathspec");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.ok(!("stateSkippedReason" in payload), "STATE.md is committed, not skipped");
    assert.deepEqual(payload.paths, ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(
      files.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
      ["AGENTS.md", "CLAUDE.md", "docs/Project/STATE.md"],
      "the commit holds the index's own spelling",
    );
    const state = await runGit({ cwd: worktree, args: ["show", `${commit}:docs/Project/STATE.md`] });
    assert.equal(verifyHandoffSnapshotDigest(state.stdout), true, "the committed STATE.md verifies");
    const status = await runGit({ cwd: worktree, args: ["status", "--porcelain"] });
    assert.equal(status.stdout.trim(), "", "no write landed in a file the commit does not record");
    assert.equal(readFileSync(join(outside, "own.txt"), "utf8"), "outside\n", "nothing is written outside the repository");
    assert.equal(existsSync(join(fixture.project, "docs")), false, "the project is still untouched");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2d-projdir");
    assert.equal(selected.status, "completed", "the owner selection completes");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("C2d/probe F-collide: a colliding tree prefers the link entry and skips STATE.md", async () => {
  const RUN = "run-c2d-fcollide";
  const fixture = await openFactoryPort("c2dfcollide", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = mkdtempSync(join(tmpdir(), "aiboard-c2d-outside-fcollide-"));
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    writeFileSync(join(outside, "own.txt"), "outside\n");
    await runGit({ cwd: worktree, args: ["config", "core.ignorecase", "true"] });
    // A colliding tree: the commit holds both a `Docs` link and a
    // `DOCS/project/keep.md` tree. The tree entry is built through the
    // index alone (plumbing, no checkout), since git cannot check such a
    // tree out on a case-insensitive filesystem.
    await commitEntryLinkMode(worktree, "Docs", outside.replace(/\\/g, "/"));
    await checkoutDirLinkAsRealLink(worktree, "Docs");
    writeFileSync(join(worktree, "keep-staging.txt"), "keep\n");
    const blob = (await runGit({ cwd: worktree, args: ["hash-object", "-w", "keep-staging.txt"] })).stdout.trim();
    assert.match(blob, /^[a-f0-9]{40}$/);
    rmSync(join(worktree, "keep-staging.txt"), { force: true });
    await runGit({ cwd: worktree, args: ["update-index", "--add", "--cacheinfo", `100644,${blob},DOCS/project/keep.md`] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "colliding DOCS tree next to the Docs link"] });
    const root = await runGit({ cwd: worktree, args: ["ls-tree", "HEAD"] });
    assert.match(root.stdout, /^120000 blob [a-f0-9]+[ \t]Docs$/m, "the commit holds the Docs link");
    assert.match(root.stdout, /^040000 tree [a-f0-9]+[ \t]DOCS$/m, "the commit holds the colliding DOCS tree");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the colliding layout still hands off");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.match(String(payload.stateSkippedReason), /docs is a symbolic link or junction/, "the walk agrees with the stage-time link check");
    assert.equal(payload.agentsSectionCommitted, true);
    assert.equal(payload.claudeLineCommitted, true);
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(
      files.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
      ["AGENTS.md", "CLAUDE.md"],
      "only the entry files commit; nothing is written under the link",
    );
    assert.equal(readlinkSync(join(worktree, "Docs")).replace(/\\/g, "/"), outside.replace(/\\/g, "/"), "the link is never touched");
    assert.deepEqual(readdirSync(outside), ["own.txt"], "nothing is written outside the repository");
    assert.equal(existsSync(join(fixture.project, "docs")), false, "the project is still untouched");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2d-fcollide");
    assert.equal(selected.status, "completed", "the owner selection completes");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("C2e/probe F-docs-file: a tracked file at docs skips STATE.md and still hands off", async () => {
  const RUN = "run-c2e-fdocsfile";
  const fixture = await openFactoryPort("c2efdocsfile", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    // A tracked regular file at `docs` (today: ENOTDIR from the write, on
    // every attempt).
    writeFileSync(join(worktree, "docs"), "user file\n");
    await runGit({ cwd: worktree, args: ["add", "--", "docs"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed a tracked file at docs"] });
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the run hands off instead of stalling on ENOTDIR");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.stateSkippedReason, handoffStateBlockerSkipReason("docs", "file"), "the skip reason names the file blocker accurately");
    assert.equal(payload.bodyDigest, "", "no STATE.md is committed, so no digest is recorded");
    assert.equal(payload.agentsSectionCommitted, true);
    assert.equal(payload.claudeLineCommitted, true);
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(
      files.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
      ["AGENTS.md", "CLAUDE.md"],
      "only the entry files commit; nothing is written under the file",
    );
    assert.equal(readFileSync(join(worktree, "docs"), "utf8"), "user file\n", "the user's file is untouched");
    const status = await runGit({ cwd: worktree, args: ["status", "--porcelain"] });
    assert.equal(status.stdout.trim(), "", "no write landed in a file the commit does not record");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2e-fdocsfile");
    assert.equal(selected.status, "completed", "the owner selection completes");
    // The v1 Architect path refuses with a clear reason, never with a crash.
    const before = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    await assert.rejects(
      () => fixture.integration.commitProjectDocuments({
        writes: [{ path: "docs/project/STATE.md", content: DEFAULT_STATE_TEMPLATE }],
        summary: "Record documents",
        runId: RUN,
        requestId: "project-doc:c2e-fdocsfile:docs/project/STATE.md",
      }),
      /Project document path docs\/project\/STATE\.md is refused because docs is a regular file, not a directory\./,
      "a file at docs refuses the v1 batch before any write",
    );
    const after = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(after.stdout.trim(), before.stdout.trim(), "the refused batch commits nothing");
  } finally {
    await fixture.close();
  }
});

test("C2e/probe F-project-file: a tracked file at docs/project skips STATE.md and still hands off", async () => {
  const RUN = "run-c2e-fprojectfile";
  const fixture = await openFactoryPort("c2efprojectfile", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    // A tracked regular file at `docs/project` (today: EEXIST from the
    // write, on every attempt).
    mkdirSync(join(worktree, "docs"), { recursive: true });
    writeFileSync(join(worktree, "docs", "project"), "user file\n");
    await runGit({ cwd: worktree, args: ["add", "--", "docs/project"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed a tracked file at docs/project"] });
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the run hands off instead of stalling on EEXIST");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.stateSkippedReason, handoffStateBlockerSkipReason("docs/project", "file"), "the skip reason names the file blocker accurately");
    assert.equal(payload.bodyDigest, "", "no STATE.md is committed, so no digest is recorded");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(
      files.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
      ["AGENTS.md", "CLAUDE.md"],
      "only the entry files commit; nothing is written under the file",
    );
    assert.equal(readFileSync(join(worktree, "docs", "project"), "utf8"), "user file\n", "the user's file is untouched");
    const status = await runGit({ cwd: worktree, args: ["status", "--porcelain"] });
    assert.equal(status.stdout.trim(), "", "no write landed in a file the commit does not record");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2e-fprojectfile");
    assert.equal(selected.status, "completed", "the owner selection completes");
    // The v1 Architect path refuses with a clear reason, never with a crash.
    const before = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    await assert.rejects(
      () => fixture.integration.commitProjectDocuments({
        writes: [{ path: "docs/project/STATE.md", content: DEFAULT_STATE_TEMPLATE }],
        summary: "Record documents",
        runId: RUN,
        requestId: "project-doc:c2e-fprojectfile:docs/project/STATE.md",
      }),
      /Project document path docs\/project\/STATE\.md is refused because docs\/project is a regular file, not a directory\./,
      "a file at docs/project refuses the v1 batch before any write",
    );
    const after = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(after.stdout.trim(), before.stdout.trim(), "the refused batch commits nothing");
  } finally {
    await fixture.close();
  }
});

test("C2e/probe F-state-dir: a tracked directory at docs/project/STATE.md skips STATE.md and still hands off", async () => {
  const RUN = "run-c2e-fstatedir";
  const fixture = await openFactoryPort("c2efstatedir", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    // A tracked directory at `docs/project/STATE.md` (today: EISDIR from
    // the write, on every attempt).
    mkdirSync(join(worktree, "docs", "project", "STATE.md"), { recursive: true });
    writeFileSync(join(worktree, "docs", "project", "STATE.md", "keep.md"), "user keep\n");
    await runGit({ cwd: worktree, args: ["add", "--", "docs/project/STATE.md/keep.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed a tracked directory at docs/project/STATE.md"] });
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the run hands off instead of stalling on EISDIR");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.stateSkippedReason, handoffStateBlockerSkipReason("docs/project/STATE.md", "directory"), "the skip reason names the directory blocker accurately");
    assert.equal(payload.bodyDigest, "", "no STATE.md is committed, so no digest is recorded");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(
      files.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
      ["AGENTS.md", "CLAUDE.md"],
      "only the entry files commit; nothing is written under the directory",
    );
    assert.equal(readFileSync(join(worktree, "docs", "project", "STATE.md", "keep.md"), "utf8"), "user keep\n", "the user's file is untouched");
    const status = await runGit({ cwd: worktree, args: ["status", "--porcelain"] });
    assert.equal(status.stdout.trim(), "", "no write landed in a file the commit does not record");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2e-fstatedir");
    assert.equal(selected.status, "completed", "the owner selection completes");
    // The v1 Architect path refuses with a clear reason, never with a crash.
    const before = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    await assert.rejects(
      () => fixture.integration.commitProjectDocuments({
        writes: [{ path: "docs/project/STATE.md", content: DEFAULT_STATE_TEMPLATE }],
        summary: "Record documents",
        runId: RUN,
        requestId: "project-doc:c2e-fstatedir:docs/project/STATE.md",
      }),
      /Project document path docs\/project\/STATE\.md is refused because docs\/project\/STATE\.md is a directory\./,
      "a directory at STATE.md refuses the v1 batch before any write",
    );
    const after = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(after.stdout.trim(), before.stdout.trim(), "the refused batch commits nothing");
  } finally {
    await fixture.close();
  }
});

test("C2e repair cycle 1/probe F10: a STATE.md directory refuses only the blocked v1 write", async () => {
  const RUN = "run-c2e-r1-f10";
  const fixture = await openFactoryPort("c2er1f10", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    // A tracked directory at `docs/project/STATE.md` (the F-state-dir
    // layout): the kernel run still hands off with the tree-derived
    // reason.
    mkdirSync(join(worktree, "docs", "project", "STATE.md"), { recursive: true });
    writeFileSync(join(worktree, "docs", "project", "STATE.md", "keep.md"), "user keep\n");
    await runGit({ cwd: worktree, args: ["add", "--", "docs/project/STATE.md/keep.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed a tracked directory at docs/project/STATE.md"] });
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the run hands off with the directory skip");
    // The v1 regression (N-2): a write the blocker cannot affect lands
    // instead of being refused for the STATE.md directory.
    const before = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    const documents = await fixture.integration.commitProjectDocuments({
      writes: [{ path: "docs/project/README.md", content: "# project readme\n" }],
      summary: "Record documents",
      runId: RUN,
      requestId: "project-doc:c2e-r1-f10:docs/project/README.md",
    });
    assert.ok(documents.commit, "the unrelated v1 write commits");
    const after = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(after.stdout.trim(), String(Number(before.stdout.trim()) + 1), "the v1 batch commits exactly once");
    const readme = await runGit({ cwd: worktree, args: ["show", `${documents.commit}:docs/project/README.md`] });
    assert.equal(readme.stdout, "# project readme\n", "the README lands in the commit");
    // The blocked write itself is still refused with a clear reason.
    await assert.rejects(
      () => fixture.integration.commitProjectDocuments({
        writes: [{ path: "docs/project/STATE.md", content: DEFAULT_STATE_TEMPLATE }],
        summary: "Record documents",
        runId: RUN,
        requestId: "project-doc:c2e-r1-f10:docs/project/STATE.md",
      }),
      /Project document path docs\/project\/STATE\.md is refused because docs\/project\/STATE\.md is a directory\./,
      "the STATE.md write is still refused",
    );
    assert.equal(readFileSync(join(worktree, "docs", "project", "STATE.md", "keep.md"), "utf8"), "user keep\n", "the user's directory is untouched");
    const status = await runGit({ cwd: worktree, args: ["status", "--porcelain"] });
    assert.equal(status.stdout.trim(), "", "no write landed in a file the commit does not record");
  } finally {
    await fixture.close();
  }
});

test("C2e repair cycle 1/probe F7: a submodule entry at docs/project/STATE.md skips STATE.md and still hands off", async () => {
  const RUN = "run-c2e-r1-f7";
  const fixture = await openFactoryPort("c2er1f7", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    // A gitlink (mode 160000, an empty directory on disk) at
    // `docs/project/STATE.md` (today: EISDIR on every attempt, and a raw
    // EISDIR throw on the v1 path).
    mkdirSync(join(worktree, "docs", "project"), { recursive: true });
    writeFileSync(join(worktree, "docs", "project", "README.md"), "user readme\n");
    await runGit({ cwd: worktree, args: ["add", "--", "docs/project/README.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed docs/project"] });
    const head = (await runGit({ cwd: worktree, args: ["rev-parse", "HEAD"] })).stdout.trim();
    assert.match(head, /^[a-f0-9]{40}$/);
    await runGit({ cwd: worktree, args: ["update-index", "--add", "--cacheinfo", `160000,${head},docs/project/STATE.md`] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed a submodule entry at docs/project/STATE.md"] });
    mkdirSync(join(worktree, "docs", "project", "STATE.md"), { recursive: true });
    const mode = await runGit({ cwd: worktree, args: ["ls-tree", "HEAD", "--", "docs/project/STATE.md"] });
    assert.match(mode.stdout, /^160000 commit /m, "the commit holds the submodule entry");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the run hands off instead of stalling on EISDIR");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(
      payload.stateSkippedReason,
      handoffStateBlockerSkipReason("docs/project/STATE.md", "submodule"),
      "the skip reason names the submodule entry accurately",
    );
    assert.equal(payload.bodyDigest, "", "no STATE.md is committed, so no digest is recorded");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(
      files.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
      ["AGENTS.md", "CLAUDE.md"],
      "only the entry files commit; nothing is written under the submodule entry",
    );
    const status = await runGit({ cwd: worktree, args: ["status", "--porcelain"] });
    assert.equal(status.stdout.trim(), "", "no write landed in a file the commit does not record");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2e-r1-f7");
    assert.equal(selected.status, "completed", "the owner selection completes");
    // The v1 Architect path refuses with a clear reason, never with a crash.
    const before = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    await assert.rejects(
      () => fixture.integration.commitProjectDocuments({
        writes: [{ path: "docs/project/STATE.md", content: DEFAULT_STATE_TEMPLATE }],
        summary: "Record documents",
        runId: RUN,
        requestId: "project-doc:c2e-r1-f7:docs/project/STATE.md",
      }),
      /Project document path docs\/project\/STATE\.md is refused because docs\/project\/STATE\.md is a submodule entry\./,
      "a submodule entry at STATE.md refuses the v1 batch before any write",
    );
    const after = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(after.stdout.trim(), before.stdout.trim(), "the refused batch commits nothing");
  } finally {
    await fixture.close();
  }
});

/**
 * C2d repair cycle 1 (B2): a valid snapshot body with its digest line,
 * built directly so the manager-level probe controls both bodies.
 */
function probeSnapshotBody(bodyText: string): string {
  const norm = bodyText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  return `# AIBoard handoff snapshot — body_sha256: ${createHash("sha256").update(norm, "utf8").digest("hex")}\n${bodyText}`;
}

test("C2d repair cycle 1/probe FA-1: two STATE.md spellings read back fail-closed", async (t) => {
  // The stale-exact collision needs a case-insensitive filesystem (the
  // staged write aliases into the lowercase entry).
  if (process.platform === "linux") { t.skip("The STATE.md spelling collision needs a case-insensitive checkout."); return; }
  const RUN = "run-c2d-fa1";
  const fixture = await openFactoryPort("c2dfa1", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  try {
    const worktree = fixture.integration.path;
    await runGit({ cwd: worktree, args: ["config", "core.ignorecase", "true"] });
    const OLD = probeSnapshotBody("OLD snapshot body (previous stop)\n");
    const NEW = probeSnapshotBody("NEW snapshot body (this stop)\n");
    assert.equal(verifyHandoffSnapshotDigest(OLD), true);
    assert.equal(verifyHandoffSnapshotDigest(NEW), true);
    // A valid snapshot at the exact spelling, plus a second tracked
    // spelling built through the index alone (plumbing, no checkout),
    // since both spellings cannot live on disk together.
    mkdirSync(join(worktree, "docs", "project"), { recursive: true });
    writeFileSync(join(worktree, "docs", "project", "STATE.md"), OLD);
    await runGit({ cwd: worktree, args: ["add", "--", "docs/project/STATE.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed the exact STATE.md spelling"] });
    writeFileSync(join(worktree, "plumb-staging.txt"), "user lower-case file\n");
    const blob = (await runGit({ cwd: worktree, args: ["hash-object", "-w", "plumb-staging.txt"] })).stdout.trim();
    assert.match(blob, /^[a-f0-9]{40}$/);
    rmSync(join(worktree, "plumb-staging.txt"), { force: true });
    await runGit({ cwd: worktree, args: ["update-index", "--add", "--cacheinfo", `100644,${blob},docs/project/state.md`] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "track lowercase state.md as well (collision)"] });
    const result = await fixture.integration.commitHandoffSnapshot({
      writes: [
        { path: "docs/project/STATE.md", content: NEW },
        { path: "AGENTS.md", content: V2_AGENTS_SECTION_BODY },
        { path: "CLAUDE.md", content: V2_CLAUDE_POINTER_LINE },
      ],
      summary: "FA-1 snapshot",
      runId: RUN,
      snapshotKey: "handoff:c2d-fa1",
    });
    const changed = (await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", result.commit] })).stdout
      .split("\n").map((line) => line.trim()).filter(Boolean).sort();
    assert.deepEqual(
      changed,
      ["AGENTS.md", "CLAUDE.md", "docs/project/state.md"],
      "the commit changes the lowercase entry while the exact entry keeps the old body",
    );
    assert.equal(
      (await runGit({ cwd: worktree, args: ["show", `${result.commit}:docs/project/STATE.md`] })).stdout,
      OLD,
      "the exact entry still holds the stale body",
    );
    const back = await fixture.integration.readHandoffSnapshotFile({ commit: result.commit, path: "docs/project/STATE.md" });
    assert.equal(back.content, OLD, "the read-back content comes from the stale exact entry");
    assert.equal(verifyHandoffSnapshotDigest(back.content ?? ""), true, "the stale bytes verify on their own");
    assert.equal(
      back.paths.includes("docs/project/STATE.md"),
      false,
      "fail closed: the changed lowercase spelling is not reported under the canonical name",
    );
    const described = describeSnapshotCommitFacts({ entryPoint: result.entryPoint, storedPaths: back.paths });
    assert.equal(described.stateChanged, false, "the gate stays closed instead of accepting the old digest");
    assert.equal(described.stateSkippedReason, undefined, "no skip reason is invented for the collision");
    assert.equal(
      readFileSync(join(worktree, "docs", "project", "STATE.md"), "utf8").includes("NEW snapshot body"),
      true,
      "the write landed in the committed spelling's physical file; only the canonical name stays closed",
    );
    assert.equal(existsSync(join(fixture.project, "docs")), false, "the project is still untouched");
  } finally {
    await fixture.close();
  }
});

test("C2d repair cycle 1/escalation C-1: colliding docs/ and Docs/ directories skip STATE.md and still hand off", async (t) => {
  // The collision lives in the index (both spellings cannot live on one
  // case-insensitive disk); the wedge needs the write to alias.
  if (process.platform === "linux") { t.skip("The colliding directories need a case-insensitive checkout."); return; }
  const RUN = "run-c2d-collidedirs";
  const fixture = await openFactoryPort("c2dcollidedirs", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = join(fixture.root, "zz-outside-c2d-collidedirs");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "own.txt"), "outside\n");
    await runGit({ cwd: worktree, args: ["config", "core.ignorecase", "true"] });
    // A tree that tracks both `docs/` and `Docs/` as directories: the
    // second spelling is built through the index alone (plumbing, no
    // checkout). Every attempt used to wedge on the STATE.md pathspec
    // because the write stages under the other spelling.
    mkdirSync(join(worktree, "docs"), { recursive: true });
    writeFileSync(join(worktree, "docs", "keep.md"), "user keep\n");
    await runGit({ cwd: worktree, args: ["add", "--", "docs/keep.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed docs"] });
    writeFileSync(join(worktree, "plumb-staging.txt"), "other\n");
    const blob = (await runGit({ cwd: worktree, args: ["hash-object", "-w", "plumb-staging.txt"] })).stdout.trim();
    assert.match(blob, /^[a-f0-9]{40}$/);
    rmSync(join(worktree, "plumb-staging.txt"), { force: true });
    await runGit({ cwd: worktree, args: ["update-index", "--add", "--cacheinfo", `100644,${blob},Docs/other.md`] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "collide Docs directory"] });
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the colliding layout hands off instead of wedging on the pathspec");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.stateSkippedReason, handoffStateSkipReason("docs"), "the skip reason is commit-tree-derived, as for a link");
    assert.equal(payload.bodyDigest, "", "no STATE.md is committed, so no digest is recorded");
    assert.equal(payload.agentsSectionCommitted, true);
    assert.equal(payload.claudeLineCommitted, true);
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(
      files.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
      ["AGENTS.md", "CLAUDE.md"],
      "only the entry files commit; the colliding STATE.md is skipped",
    );
    assert.equal(existsSync(join(worktree, "Docs", "project", "STATE.md")), false, "the skipped write landed nowhere");
    assert.equal(existsSync(join(worktree, "docs", "project", "STATE.md")), false, "the skipped write landed nowhere under either spelling");
    assert.equal(readFileSync(join(outside, "own.txt"), "utf8"), "outside\n", "nothing is written outside the repository");
    assert.equal(existsSync(join(fixture.project, "docs")), false, "the project is still untouched");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2d-collidedirs");
    assert.equal(selected.status, "completed", "the owner selection completes");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});
