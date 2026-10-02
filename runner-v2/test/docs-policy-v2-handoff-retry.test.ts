import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import type { IndependentVerifierDriver } from "../src/build-runtime.js";
import {
  handoffSnapshotInputFromProjection,
  renderHandoffSnapshot,
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
import { deriveNativeVerifierRiskInput } from "../src/native-build-factory.js";
import { runGit } from "./support/git-fixture.js";
import {
  CLOCK,
  COMPLETION_SUMMARY,
  SOURCE_TEXT,
  advancingClock,
  appendHandoffEvents,
  applyAutomaticHandoff,
  buildRuntimeForHandoff,
  checkoutDirLinkAsRealLink,
  checkoutEntryLinkAsPlainFile,
  commitEntryLinkMode,
  driveHandoff,
  type FactoryPortFixture,
  failNextSnapshotAppendOnce,
  failNextSnapshotCommits,
  failNextSnapshotLookupOnce,
  failNextSnapshotReadOnce,
  fvRerunSeed,
  headerDigest,
  lowRiskSeed,
  openFactoryPort,
  openHandoffStore,
  pauseHandoff,
  readHandoffLog,
  resumeHandoff,
  seedEvent,
  seedHandoffRequested,
  selectHandoffOwner,
  silentArchitect,
  v2FinishSeed,
  v2PlanOnlySeed,
} from "./support/handoff-snapshot-harness.js";

/**
 * TX-2 handoff suite, file 3 of 8: retry, reuse and crash.
 *
 * Every test drives the runtime's real snapshot step directly through the
 * harness (factory-built port, no manager pump). The Architect turn that
 * records stop 1 is kept, so the `architect.calls()` assertions are
 * unchanged; the throwing default is never needed here because no test
 * seeds its stop. Resume and pause go through the real runtime; owner and
 * automatic selections mirror the manager (shared pre-check first).
 */

/**
 * FX-1: production-shaped independent verifier for the factory-port finish
 * tests. Risk comes from the real kernel derivation
 * (deriveNativeVerifierRiskInput); low risk never reaches verify. The
 * factory already configured the risk_based policy with these candidates,
 * so the driver matches it exactly.
 */
function productionRiskVerifier(
  fixture: FactoryPortFixture,
  runId: string,
  counter: { calls: number },
): IndependentVerifierDriver {
  return {
    candidateRuntimeIds: ["rev:reviewer"],
    alwaysRequireIndependentVerifier: false,
    assessRisk: async ({ projection }) => {
      counter.calls += 1;
      const store = openHandoffStore(fixture, runId);
      try {
        return deriveNativeVerifierRiskInput({
          projection,
          sessions: [],
          schedulerEvents: store.readRun(runId),
          toolEvents: [],
          stricterQualification: false,
        });
      } finally {
        store.close();
      }
    },
    verify: async () => {
      throw new Error("A low-risk run must never reach independent verification.");
    },
  };
}

test("C2a B3: two consecutive failures pause again and the next resume retries", async () => {
  const RUN = "run-c2a-double-failure";
  const fixture = await openFactoryPort("double-failure", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  failNextSnapshotCommits(fixture.integration, 2, "Injected handoff snapshot commit failure.");
  const architect = silentArchitect();
  try {
    let driven = await driveHandoff(fixture, RUN, { architect });
    const firstPauses = driven.events.filter((event) => event.type === "run.paused");
    assert.equal(firstPauses.length, 1);
    assert.equal((firstPauses[0]!.payload as Record<string, unknown>).reason, "handoff_snapshot_failed");
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    // The next resume retries instead of being refused.
    await resumeHandoff(fixture, RUN, "resume:c2a-double-1", { architect });
    driven = await driveHandoff(fixture, RUN, { architect });
    const secondPauses = driven.events.filter((event) => event.type === "run.paused");
    assert.equal(secondPauses.length, 2, "the second failure pauses again");
    assert.notEqual(secondPauses[0]!.idempotencyKey, secondPauses[1]!.idempotencyKey, "the failure pause key is per attempt");
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    await resumeHandoff(fixture, RUN, "resume:c2a-double-2", { architect });
    driven = await driveHandoff(fixture, RUN, { architect });
    const retried = driven.projection;
    assert.equal(retried.status, "paused");
    assert.equal(retried.projectHandoff?.status, "requested");
    assert.equal(retried.pauseReason, undefined);
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 1);
    const count = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "1");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2a-double");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2a B4: commit lands, the read fails, retry reuses the commit and records its tree", async () => {
  const RUN = "run-c2a-read-retry";
  const fixture = await openFactoryPort("read-retry", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
  const architect = silentArchitect();
  try {
    let driven = await driveHandoff(fixture, RUN, { architect });
    // The commit landed but the read failed: paused, one commit, no event.
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const landed = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), "1");
    await resumeHandoff(fixture, RUN, "resume:c2a-read-retry", { architect });
    driven = await driveHandoff(fixture, RUN, { architect });
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 1);
    const payload = driven.events.find((event) => event.type === "project_docs.handoff_snapshot_committed")!.payload as Record<string, unknown>;
    const count = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "1", "the retry reuses the commit instead of duplicating it");
    // The event digest is the committed file's own digest.
    const committed = await runGit({ cwd: fixture.integration.path, args: ["show", `${String(payload.commit)}:docs/project/STATE.md`] });
    assert.equal(headerDigest(committed.stdout), payload.bodyDigest);
    assert.deepEqual(payload.paths, ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
  } finally {
    await fixture.close();
  }
});

test("C2a: a crash between the kernel commit and the event append resumes to one commit and one event", async () => {
  const RUN = "run-c2a-crash";
  const fixture = await openFactoryPort("crash", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  try {
    // The stop is recorded but the crashed attempt never appended the event.
    seedHandoffRequested(fixture, RUN);
    const logged = readHandoffLog(fixture, RUN).events;
    const stop = logged.find((event) => event.type === "project.handoff_requested")!;
    const stopProjection = rebuildSchedulerProjection(logged.filter((event) => event.sequence <= stop.sequence));
    // The crashed attempt committed the deterministic stop body with the
    // snapshot key, then died before the event append.
    const body = renderHandoffSnapshot(handoffSnapshotInputFromProjection(stopProjection, { stopAt: stop.occurredAt, revision: "revision_value" }));
    // C2b: the crashed attempt committed the full kernel tree (STATE.md plus
    // the v2 entry lines); the drive must reuse it, never duplicate it.
    const crashed = await fixture.integration.commitHandoffSnapshot({
      writes: [
        { path: "docs/project/STATE.md", content: body },
        { path: "AGENTS.md", content: V2_AGENTS_SECTION_BODY },
        { path: "CLAUDE.md", content: V2_CLAUDE_POINTER_LINE },
      ],
      summary: "crashed attempt with the same snapshot key",
      runId: RUN,
      snapshotKey: `handoff-snapshot:${stop.sequence}`,
    });
    const architect = silentArchitect();
    // Direct drive recovers the crash; the seeded stop needs no new turn.
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    assert.equal((snapshots[0]!.payload as Record<string, unknown>).commit, crashed.commit);
    const count = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "1", "the crash does not create a second commit");
    const stored = await runGit({ cwd: fixture.integration.path, args: ["show", `${crashed.commit}:docs/project/STATE.md`] });
    assert.equal(stored.stdout, body);
    assert.equal((snapshots[0]!.payload as Record<string, unknown>).bodyDigest, headerDigest(body));
    assert.equal(architect.calls(), 0, "recovery makes no model call");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2a-crash");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2a M3: snapshot reuse requires every runner trailer, not just the key line", async () => {
  const RUN = "run-c2a-trailers";
  const fixture = await openFactoryPort("trailers", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  try {
    const key = "handoff-snapshot:999";
    // A foreign commit carrying only the key line (as a cherry-picked worker
    // message would): it must NOT be reused.
    const worktreeFile = join(fixture.integration.path, "docs", "project", "STATE.md");
    mkdirSync(join(fixture.integration.path, "docs", "project"), { recursive: true });
    writeFileSync(worktreeFile, "foreign body\n");
    await runGit({ cwd: fixture.integration.path, args: ["add", "--", "docs/project/STATE.md"] });
    await runGit({
      cwd: fixture.integration.path,
      args: ["commit", "-m", "worker summary with several lines", "--trailer", `AIBoard-Snapshot-Key: ${key}`],
    });
    const foreign = await runGit({ cwd: fixture.integration.path, args: ["rev-parse", "HEAD"] });
    const first = await fixture.integration.commitHandoffSnapshot({
      writes: [{ path: "docs/project/STATE.md", content: "kernel body\n" }],
      summary: "kernel attempt",
      runId: RUN,
      snapshotKey: key,
    });
    assert.notEqual(first.commit, foreign.stdout.trim(), "a commit without the runner trailers is not reused");
    const both = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(both.stdout.trim(), "2");
    // The genuine runner commit carries every trailer and IS reused.
    const message = await runGit({ cwd: fixture.integration.path, args: ["log", "-1", "--format=%B", first.commit] });
    for (const trailer of [`AIBoard-Run: ${RUN}`, "AIBoard-Author: runner", "AIBoard-Generated: handoff-snapshot", `AIBoard-Snapshot-Key: ${key}`]) {
      assert.ok(message.stdout.split("\n").some((line) => line.trim() === trailer), `missing trailer ${trailer}`);
    }
    const second = await fixture.integration.commitHandoffSnapshot({
      writes: [{ path: "docs/project/STATE.md", content: "kernel body\n" }],
      summary: "kernel attempt",
      runId: RUN,
      snapshotKey: key,
    });
    assert.equal(second.commit, first.commit, "the runner-authored commit is reused");
    const still = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(still.stdout.trim(), "2");
    const read = await fixture.integration.readHandoffSnapshotFile({ commit: first.commit, path: "docs/project/STATE.md" });
    assert.equal(read.content, "kernel body\n");
    assert.deepEqual(read.paths, ["docs/project/STATE.md"]);
  } finally {
    await fixture.close();
  }
});

test("C2b N1 probe F: a withdrawn-stop commit is recorded, never stuck, never mutating", async () => {
  const RUN = "run-c2b-probef";
  const fixture = await openFactoryPort("probef", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  failNextSnapshotCommits(fixture.integration, 1, "Injected handoff snapshot commit failure.");
  const architect = silentArchitect();
  try {
    let driven = await driveHandoff(fixture, RUN, { architect });
    // The first attempt fails before landing: requested, paused, no commit.
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    // Guidance withdraws the handoff while the kernel commit is in flight.
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    const withdrawEvents: NewSchedulerEvent[] = [
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
    ];
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
      ...withdrawEvents,
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
    // The in-flight kernel commit lands after the withdrawal: a real commit
    // with the stop-1 key and the full kernel tree.
    const logged = readHandoffLog(fixture, RUN).events;
    const stop1 = logged.find((event) => event.type === "project.handoff_requested")!;
    const stopProjection = rebuildSchedulerProjection(logged.filter((event) => event.sequence <= stop1.sequence));
    const lateBody = renderHandoffSnapshot(handoffSnapshotInputFromProjection(stopProjection, { stopAt: stop1.occurredAt, revision: "revision_value" }));
    const late = await fixture.integration.commitHandoffSnapshot({
      writes: [
        { path: "docs/project/STATE.md", content: lateBody },
        { path: "AGENTS.md", content: V2_AGENTS_SECTION_BODY },
        { path: "CLAUDE.md", content: V2_CLAUDE_POINTER_LINE },
      ],
      summary: "late kernel commit for the withdrawn stop",
      runId: RUN,
      snapshotKey: `handoff-snapshot:${stop1.sequence}`,
    });
    const lateRead = await fixture.integration.readHandoffSnapshotFile({ commit: late.commit, path: "docs/project/STATE.md" });
    // The late event append is accepted into history (N1): the commit moves
    // the tip, touches no run state, and never satisfies a later gate.
    appendHandoffEvents(fixture, RUN, [
      e("project_docs.handoff_snapshot_committed", `handoff-snapshot:${stop1.sequence}`, "runner", "build-runtime", {
        stopSequence: stop1.sequence,
        stopKind: "plan_only",
        revision: "revision_value",
        commit: late.commit,
        parent: late.parent,
        head: late.head,
        bodyDigest: headerDigest(lateRead.content!),
        paths: lateRead.paths,
        previousSnapshotEdited: false,
        agentsSectionCommitted: true,
        claudeLineCommitted: true,
      }),
    ]);
    const recorded = readHandoffLog(fixture, RUN).projection;
    assert.equal(recorded.projectDocs?.snapshots?.length, 1);
    assert.equal(recorded.status, "running", "a withdrawn-stop record leaves the run state alone");
    assert.equal(recorded.pauseReason?.reason, "handoff_snapshot_failed", "the failure pause is not cleared by history");
    // Re-request: a fresh stop commits a fresh snapshot and completes. The
    // run was never stuck and the project was never mutated.
    appendHandoffEvents(fixture, RUN, [
      e("project.handoff_requested", "handoff-2", "architect", "architect", { summary: COMPLETION_SUMMARY }),
    ]);
    driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 2);
    assert.equal((snapshots[1]!.payload as Record<string, unknown>).previousSnapshotEdited, false);
    assert.equal(architect.calls(), 1, "no model call follows the handoff wait");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2b-probef");
    assert.equal(selected.status, "completed");
    assert.equal(existsSync(join(fixture.project, "docs", "project", "STATE.md")), false, "the project is untouched");
  } finally {
    await fixture.close();
  }
});

test("C2b N1 probe G: a snapshot that breaks the chain is refused before any mutation", async () => {
  const RUN = "run-c2b-probeg";
  // The factory re-validates final-verification profiles against its audit
  // archive on read, so FV events land after create through the harness
  // store (as in G2-prod); the factory store never re-reads once its
  // runtime is built.
  const preSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(runId, baseline).filter((event) => !event.type.startsWith("final_verification."));
  const fvSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(runId, baseline).filter((event) => event.type.startsWith("final_verification."));
  const fixture = await openFactoryPort("probeg", RUN, preSeed, "finish");
  appendHandoffEvents(fixture, RUN, fvSeed(RUN, fixture.baselineRevision));
  // The factory's risk_based verifier policy is already in the shared log
  // (factory.create): qualify the green FV generation before completion.
  appendHandoffEvents(fixture, RUN, lowRiskSeed(RUN, fixture.baselineRevision));
  // The integration branch runs one commit ahead of the canonical revision,
  // so the kernel snapshot's parent continues neither the canonical
  // revision nor the document tip.
  writeFileSync(join(fixture.integration.path, "unrelated.txt"), "unrelated work\n");
  await runGit({ cwd: fixture.integration.path, args: ["add", "--", "unrelated.txt"] });
  await runGit({ cwd: fixture.integration.path, args: ["commit", "-m", "unrelated work ahead of canonical"] });
  const architect = silentArchitect("The build is complete and verified.");
  try {
    const driven = await driveHandoff(fixture, RUN, { runPolicy: "finish", architect });
    // The snapshot is recorded (the commit landed) but moves no tip; the
    // shared predicate refuses the selection before any project mutation.
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    assert.equal(driven.projection.projectDocs?.documentTip, undefined);
    assert.equal(existsSync(join(fixture.project, "docs", "project", "STATE.md")), false, "the project is untouched");
    // The automatic handoff fails with the kernel rule before mutating.
    await assert.rejects(
      applyAutomaticHandoff(fixture, RUN, { runPolicy: "finish" }),
      /does not match the verified integration revision/,
    );
    assert.equal(existsSync(join(fixture.project, "docs", "project", "STATE.md")), false, "no project mutation precedes the refusal");
    // The owner's selection is refused with the same kernel rule, and the
    // run is still at the handoff wait -- refused, not stuck terminally.
    await assert.rejects(
      selectHandoffOwner(fixture, RUN, "apply_to_project", "handoff:c2b-probeg", { runPolicy: "finish" }),
      /does not match the verified integration revision/,
    );
    assert.equal(existsSync(join(fixture.project, "docs", "project", "STATE.md")), false);
    assert.equal(readHandoffLog(fixture, RUN).projection.projectHandoff?.status, "requested");
  } finally {
    await fixture.close();
  }
});

test("C2b repair B1 probe G2: a withdrawn stop's landed commit is reconciled, the chain continues", async () => {
  const RUN = "run-c2b-g2";
  // The canonical revision is the real baseline, so the stop-1 kernel commit
  // continues the documents once it is recorded as history. FV events land
  // after create through the harness store (as in G2-prod).
  const preSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(runId, baseline).filter((event) => !event.type.startsWith("final_verification."));
  const fvSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(runId, baseline).filter((event) => event.type.startsWith("final_verification."));
  const fixture = await openFactoryPort("g2", RUN, preSeed, "finish");
  appendHandoffEvents(fixture, RUN, fvSeed(RUN, fixture.baselineRevision));
  // The factory's risk_based verifier policy is already in the shared log
  // (factory.create): qualify the green FV generation before completion.
  appendHandoffEvents(fixture, RUN, lowRiskSeed(RUN, fixture.baselineRevision));
  // The stop-1 commit lands, then the read-back fails: a transient failure
  // after the commit (or a crash before the append).
  failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
  const architect = silentArchitect("The build is complete and verified.");
  // FX-1: after guidance invalidates the stop-1 assessment, the second
  // drive re-assesses through the real kernel derivation (no seeded
  // re-assessment), and the Architect's real second complete_run records
  // stop 2 (no seeded re-request) -- the B2/G3 pattern.
  const verifierCalls = { calls: 0 };
  const verifier = productionRiskVerifier(fixture, RUN, verifierCalls);
  const driveOpts = { runPolicy: "finish" as const, architect, independentVerifier: verifier };
  try {
    let driven = await driveHandoff(fixture, RUN, { runPolicy: "finish", architect });
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    assert.equal(existsSync(join(fixture.project, "docs", "project", "STATE.md")), false, "the project is untouched");
    const landed = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), "1", "the stop-1 kernel commit landed");
    const stop1 = driven.events.find((event) => event.type === "project.handoff_requested")!.sequence;
    // The owner submits guidance instead of resuming: the handoff is
    // withdrawn. The Architect acknowledges with no plan change.
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
    ]);
    const withdrawn = readHandoffLog(fixture, RUN).projection;
    assert.equal(withdrawn.projectHandoff, undefined, "guidance withdrew the handoff");
    assert.equal((withdrawn.projectHandoffHistory ?? []).length, 1);
    // Final verification re-runs green on the unchanged canonical revision.
    // Guidance invalidated the stop-1 assessment, so the drive re-assesses
    // through the real kernel derivation (driveOpts) before the Architect's
    // real second complete_run re-requests (stop 2): no seeded risk event,
    // no seeded re-request.
    appendHandoffEvents(fixture, RUN, fvRerunSeed(RUN, fixture.baselineRevision));
    driven = await driveHandoff(fixture, RUN, driveOpts);
    const risks = driven.events.filter((event) => event.type === "build.risk_assessed");
    assert.equal(risks.length, 2, "the runtime re-assesses after the invalidation");
    assert.equal(
      risks[1]!.idempotencyKey,
      `build-risk:${fixture.baselineRevision}:generation-c2a-finish-rerun`,
      "the re-assessment is keyed by the re-run generation",
    );
    assert.ok(verifierCalls.calls <= 3, `no assessRisk spin (${verifierCalls.calls} calls)`);
    // The withdrawn stop's landed commit was recorded as history before the
    // next stop committed: two snapshot events, one chain.
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 2);
    const first = snapshots[0]!.payload as Record<string, unknown>;
    const second = snapshots[1]!.payload as Record<string, unknown>;
    assert.equal(first.stopSequence, stop1, "the withdrawn stop is recorded first, as history");
    const restop = driven.events.filter((event) => event.type === "project.handoff_requested");
    assert.equal(second.stopSequence, restop[restop.length - 1]!.sequence, "the second record belongs to the re-request");
    assert.equal(second.parent, first.commit, "the new snapshot continues the withdrawn commit");
    assert.equal(driven.projection.projectDocs?.documentTip, second.commit);
    // The project is still untouched at this point: the harness never
    // auto-applies, so this only records that nothing has applied yet.
    // Manager ordering (mutation only after the kernel accepts) is proved
    // by the kept C2a B1+M6 and B1 forced-fail tests, not here.
    assert.equal(existsSync(join(fixture.project, "docs", "project", "STATE.md")), false, "the project is still untouched before the explicit apply");
    // The handoff succeeds only after the kernel record, and the project
    // holds the new snapshot.
    const projection = await applyAutomaticHandoff(fixture, RUN, { runPolicy: "finish" });
    assert.equal(projection.status, "completed", "the handoff succeeds after reconciliation");
    assert.equal(projection.projectHandoff?.choice, "apply_to_project");
    assert.equal(architect.calls(), 2, "stop 1 plus the real re-request; the kernel snapshot itself makes no model call");
    const stateShow = await runGit({ cwd: fixture.integration.path, args: ["show", `${String(second.commit)}:docs/project/STATE.md`] });
    const applied = await runGit({ cwd: fixture.project, args: ["show", "HEAD:docs/project/STATE.md"] });
    assert.equal(applied.stdout, stateShow.stdout, "the project holds the reconciled snapshot");
  } finally {
    await fixture.close();
  }
});

test("C2b repair m2/probe H: a reused commit's event is derived from the commit, not fresh reads", async () => {
  const RUN = "run-c2b-reused-derive";
  const fixture = await openFactoryPort("reused-derive", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  // The tip STATE.md is hand-written outside AIBoard, and the spec copy is due.
  mkdirSync(join(fixture.integration.path, "docs", "project"), { recursive: true });
  writeFileSync(join(fixture.integration.path, "docs", "project", "STATE.md"), "hand-written outside AIBoard\n");
  await runGit({ cwd: fixture.integration.path, args: ["add", "--", "docs/project/STATE.md"] });
  await runGit({ cwd: fixture.integration.path, args: ["commit", "-m", "hand-written tip snapshot"] });
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  // The commit lands, then the read-back fails; resume retries and reuses it.
  failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
  const architect = silentArchitect();
  try {
    let driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    await resumeHandoff(fixture, RUN, "resume:c2b-reused-derive", { architect });
    driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    // Derived from the reused commit: the committed STATE.md names the edit
    // and the commit holds the spec copy -- although fresh reads now say
    // clean (the tip IS the commit) and find the spec already tracked.
    assert.equal(payload.previousSnapshotEdited, true);
    assert.equal(payload.specCopied, true);
    assert.equal(payload.specPath, "docs/project/specs/source_value.md");
    const count = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "2", "no second commit: the landed commit is reused");
  } finally {
    await fixture.close();
  }
});

test("C2b N2: an owner pause stacked on a snapshot failure still resumes to retry", async () => {
  const RUN = "run-c2b-stacked-pause";
  const fixture = await openFactoryPort("stacked-pause", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  failNextSnapshotCommits(fixture.integration, 1, "Injected handoff snapshot commit failure.");
  const architect = silentArchitect();
  try {
    let driven = await driveHandoff(fixture, RUN, { architect });
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    // An owner pause stacks on top of the snapshot failure through the
    // real runtime pause path.
    const stacked = await pauseHandoff(fixture, RUN, "owner_hold_for_review", "pause:owner-c2b-n2", { architect });
    assert.equal(stacked.pauseReason?.reason, "owner_hold_for_review");
    // Resume is allowed because a snapshot retry is pending for the current
    // stop -- not because of the current pause reason.
    await resumeHandoff(fixture, RUN, "resume:c2b-n2", { architect });
    driven = await driveHandoff(fixture, RUN, { architect });
    const retried = driven.projection;
    assert.equal(retried.status, "paused");
    assert.equal(retried.projectHandoff?.status, "requested");
    assert.equal(retried.pauseReason, undefined);
    assert.equal(architect.calls(), 1, "the retry makes no model call");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 1);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2b-n2");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2b N4: a cherry-picked worker commit quoting the trailers is not reused", async () => {
  const RUN = "run-c2b-trailers-n4";
  const fixture = await openFactoryPort("trailers-n4", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  try {
    const key = "handoff-snapshot:4242";
    // A worker commit cherry-picked with -x keeps its message: the four
    // EXACT trailer lines sit mid-body, followed by the cherry-pick line --
    // never in the trailer block (C2b repair m7: the pre-N4 line-set rule
    // would reuse this message, so the test goes red without the N4 fix).
    // Even with the runner identity on it, the kernel must not reuse it.
    const quoted = [
      "worker summary with several lines",
      "",
      `AIBoard-Run: ${RUN}`,
      "AIBoard-Author: runner",
      "AIBoard-Generated: handoff-snapshot",
      `AIBoard-Snapshot-Key: ${key}`,
      "(cherry picked from commit abcdef1234567890abcdef1234567890abcdef12)",
    ].join("\n");
    const worktreeFile = join(fixture.integration.path, "docs", "project", "STATE.md");
    mkdirSync(join(fixture.integration.path, "docs", "project"), { recursive: true });
    writeFileSync(worktreeFile, "worker body\n");
    await runGit({ cwd: fixture.integration.path, args: ["add", "--", "docs/project/STATE.md"] });
    await runGit({
      cwd: fixture.integration.path,
      args: ["-c", "user.name=AIBoard Integrator", "-c", "user.email=integrator@aiboard.local", "commit", "-m", quoted],
    });
    const foreign = await runGit({ cwd: fixture.integration.path, args: ["rev-parse", "HEAD"] });
    const kernel = await fixture.integration.commitHandoffSnapshot({
      writes: [{ path: "docs/project/STATE.md", content: "kernel body\n" }],
      summary: "kernel attempt",
      runId: RUN,
      snapshotKey: key,
    });
    assert.notEqual(kernel.commit, foreign.stdout.trim(), "a mid-body-trailer commit is not reused even with the runner identity");
    const count = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "2");
  } finally {
    await fixture.close();
  }
});

test("C2b repair B2/G3: a transient reconciliation failure pauses before committing and retries on resume", async () => {
  const RUN = "run-c2b-g3";
  // Probe G3 with the factory's port: the stop-1 commit lands and the read
  // fails; guidance withdraws; FV re-runs green and the Architect
  // re-requests; then the withdrawn-stop lookup throws ONCE (transient).
  const preSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(runId, baseline).filter((event) => !event.type.startsWith("final_verification."));
  const fvSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(runId, baseline).filter((event) => event.type.startsWith("final_verification."));
  const fixture = await openFactoryPort("g3", RUN, preSeed, "finish");
  failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
  const architect = silentArchitect("The build is complete and verified.");
  // FX-1: the harness runtime re-assesses through the real kernel
  // derivation after the FV re-run (no seeded re-assessment).
  const verifierCalls = { calls: 0 };
  const verifier = productionRiskVerifier(fixture, RUN, verifierCalls);
  const driveOpts = { runPolicy: "finish" as const, architect, independentVerifier: verifier };
  try {
    appendHandoffEvents(fixture, RUN, fvSeed(RUN, fixture.baselineRevision));
    // The factory's risk_based verifier policy is already in the shared log
    // (factory.create); qualify the green FV generation before completion.
    appendHandoffEvents(fixture, RUN, lowRiskSeed(RUN, fixture.baselineRevision));
    // C2e repair cycle 2 (load-only hardening): under heavy machine load
    // a transient process-launch failure can pause the stop-1 commit
    // itself before anything lands (pause with no snapshot event and no
    // commit). That state proves the injected read fault never fired -- it
    // fires only on the post-commit read-back -- so resume and re-drive
    // until the exact injected-failure state holds. The assertions below
    // still prove the injected failure pauses with the commit landed.
    let driven = await driveHandoff(fixture, RUN, driveOpts);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const commits = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length;
      const landedNow = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
      if (commits !== 0 || landedNow.stdout.trim() !== "0") break;
      assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
      await resumeHandoff(fixture, RUN, `resume:c2b-g3-setup-${attempt}`, driveOpts);
      driven = await driveHandoff(fixture, RUN, driveOpts);
    }
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const landed = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), "1", "the stop-1 kernel commit landed");
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
      ...fvRerunSeed(RUN, fixture.baselineRevision),
    ]);
    assert.equal(readHandoffLog(fixture, RUN).projection.projectHandoff, undefined, "guidance withdrew the handoff");
    // The transient: the withdrawn-stop lookup throws once at stop 2. It is
    // armed before the drive so the first lookup of the stop-2 reconcile
    // attempt fails; the resume retries with the transient gone.
    failNextSnapshotLookupOnce(fixture.integration, "Injected transient snapshot lookup failure.");
    // FX-1: guidance invalidated the stop-1 assessment; the drive
    // re-assesses through the real derivation before the Architect
    // re-requests (stop 2). FX-2: the Architect's real second complete_run
    // records stop 2 (no seeded re-request).
    driven = await driveHandoff(fixture, RUN, driveOpts);
    // Fail closed: the current stop pauses with the reconciliation failure
    // named, and commits nothing -- the chain cannot break.
    const paused = driven.projection;
    assert.equal(paused.pauseReason?.reason, "handoff_snapshot_failed");
    assert.match(String(paused.pauseReason?.detail ?? ""), /withdrawn-stop reconciliation failed/, "the pause names the reconciliation failure");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0, "no stop commits while a withdrawn stop is unclassifiable");
    const stuck = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(stuck.stdout.trim(), "1", "only the stop-1 commit exists");
    assert.equal(existsSync(join(fixture.project, "docs", "project", "STATE.md")), false, "the project is still untouched while paused before any commit");
    const risks = driven.events.filter((event) => event.type === "build.risk_assessed");
    assert.equal(risks.length, 2, "production re-assesses after the invalidation");
    assert.equal(
      risks[1]!.idempotencyKey,
      `build-risk:${fixture.baselineRevision}:generation-c2a-finish-rerun`,
      "the re-assessment is keyed by the re-run generation",
    );
    assert.ok(verifierCalls.calls <= 3, `no assessRisk spin (${verifierCalls.calls} calls)`);
    // Resume retries: the transient is gone, the history records, the new
    // snapshot continues it, and the handoff completes.
    await resumeHandoff(fixture, RUN, "resume:c2b-g3", driveOpts);
    driven = await driveHandoff(fixture, RUN, driveOpts);
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 2);
    const first = snapshots[0]!.payload as Record<string, unknown>;
    const second = snapshots[1]!.payload as Record<string, unknown>;
    assert.equal(second.parent, first.commit, "the retried snapshot continues the reconciled commit");
    assert.equal(driven.projection.projectDocs?.documentTip, second.commit);
    // Untouched-so-far fact only: the harness never auto-applies, so this
    // cannot prove manager ordering (proved by C2a B1+M6, not here).
    assert.equal(existsSync(join(fixture.project, "docs", "project", "STATE.md")), false, "the project is still untouched before the explicit apply");
    const projection = await applyAutomaticHandoff(fixture, RUN, { runPolicy: "finish" });
    assert.equal(projection.status, "completed", "the handoff completes after resume");
    assert.equal(projection.projectHandoff?.choice, "apply_to_project");
    const g3requests = driven.events.filter((event) => event.type === "project.handoff_requested");
    assert.equal(g3requests.length, 2, "the second complete_run records a new request");
    assert.equal(g3requests[1]!.idempotencyKey, "project-handoff-requested:1");
    assert.equal(architect.calls(), 2, "stop 1 plus the real re-request; the kernel snapshot itself makes no model call");
    const stateShow = await runGit({ cwd: fixture.integration.path, args: ["show", `${String(second.commit)}:docs/project/STATE.md`] });
    const applied = await runGit({ cwd: fixture.project, args: ["show", "HEAD:docs/project/STATE.md"] });
    assert.equal(applied.stdout, stateShow.stdout, "the project holds the reconciled snapshot");
  } finally {
    await fixture.close();
  }
});

test("C2c repair BL-2/probe B1: a reused skip-layout commit completes after resume", async () => {
  const RUN = "run-c2c-repair-b1";
  const fixture = await openFactoryPort("repairb1", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    await commitEntryLinkMode(worktree, "AGENTS.md", "MISSING.md");
    await checkoutEntryLinkAsPlainFile(worktree, "AGENTS.md", "MISSING.md");
    const setupCount = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    // The commit lands, then the read-back fails; resume retries and reuses it.
    failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
    let driven = await driveHandoff(fixture, RUN, { architect });
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const landed = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), String(Number(setupCount.stdout.trim()) + 1), "the stop-1 kernel commit landed");
    await resumeHandoff(fixture, RUN, "resume:c2c-repair-b1", { architect });
    driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "resume reuses the commit and completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, false);
    assert.match(String(payload.agentsSectionViaLink), /AGENTS\.md is a symbolic link to MISSING\.md/, "the skip reason is re-described from the commit tree");
    assert.equal(payload.claudeLineCommitted, true);
    const reused = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(reused.stdout.trim(), landed.stdout.trim(), "no second commit: the landed commit is reused");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-repair-b1");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c repair BL-2/probe B1c: a reused CLAUDE.md skip-layout commit completes after resume", async () => {
  const RUN = "run-c2c-repair-b1c";
  const fixture = await openFactoryPort("repairb1c", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    await commitEntryLinkMode(worktree, "CLAUDE.md", "../outside.md");
    await checkoutEntryLinkAsPlainFile(worktree, "CLAUDE.md", "../outside.md");
    const setupCount = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
    let driven = await driveHandoff(fixture, RUN, { architect });
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const landed = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), String(Number(setupCount.stdout.trim()) + 1), "the stop-1 kernel commit landed");
    await resumeHandoff(fixture, RUN, "resume:c2c-repair-b1c", { architect });
    driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "resume reuses the commit and completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.claudeLineCommitted, false);
    assert.match(String(payload.claudeLineViaLink), /CLAUDE\.md is a symbolic link to .*outside/, "the skip reason is re-described from the commit tree");
    assert.equal(payload.agentsSectionCommitted, true);
    const reused = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(reused.stdout.trim(), landed.stdout.trim(), "no second commit: the landed commit is reused");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-repair-b1c");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c repair cycle 2/probe B2: a reused AGENTS.md-into-CLAUDE.md commit completes after resume", async () => {
  const RUN = "run-c2c-r2-b2";
  const fixture = await openFactoryPort("r2b2", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    writeFileSync(join(worktree, "CLAUDE.md"), "pre-existing claude rules\n");
    await runGit({ cwd: worktree, args: ["add", "--", "CLAUDE.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed claude file"] });
    await commitEntryLinkMode(worktree, "AGENTS.md", "CLAUDE.md");
    await checkoutEntryLinkAsPlainFile(worktree, "AGENTS.md", "CLAUDE.md");
    const setupCount = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    // The merged commit lands, then the read-back fails; resume retries and
    // reuses it. The M-6 omission must be re-derived from the commit tree.
    failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
    let driven = await driveHandoff(fixture, RUN, { architect });
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const landed = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), String(Number(setupCount.stdout.trim()) + 1), "the stop-1 kernel commit landed");
    await resumeHandoff(fixture, RUN, "resume:c2c-r2-b2", { architect });
    driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "resume reuses the commit and completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, true);
    assert.equal(payload.agentsSectionViaLink, "AGENTS.md is a symbolic link to CLAUDE.md; the section is written into CLAUDE.md.");
    assert.equal(payload.claudeLineCommitted, true, "the merged section satisfies both entry lines");
    assert.match(String(payload.claudeLineViaLink), /CLAUDE\.md pointer omitted: AGENTS\.md resolves to CLAUDE\.md/, "the self-import omission is re-described from the commit tree");
    assert.ok(!("stateSkippedReason" in payload), "a committed STATE.md never carries a skip reason");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["CLAUDE.md", "docs/project/STATE.md"]);
    const reused = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(reused.stdout.trim(), landed.stdout.trim(), "no second commit: the landed commit is reused");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r2-b2");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c repair cycle 2/probe B2-real: a reused real AGENTS.md link commit completes after resume", async () => {
  const RUN = "run-c2c-r2-b2real";
  const fixture = await openFactoryPort("r2b2real", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
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
    const setupCount = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
    let driven = await driveHandoff(fixture, RUN, { architect });
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const landed = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), String(Number(setupCount.stdout.trim()) + 1), "the stop-1 kernel commit landed");
    await resumeHandoff(fixture, RUN, "resume:c2c-r2-b2real", { architect });
    driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "resume reuses the commit and completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, true);
    assert.equal(payload.claudeLineCommitted, true, "the merged section satisfies both entry lines");
    assert.match(String(payload.claudeLineViaLink), /CLAUDE\.md pointer omitted: AGENTS\.md resolves to CLAUDE\.md/, "the self-import omission is re-described from the commit tree");
    assert.ok(lstatSync(join(worktree, "AGENTS.md")).isSymbolicLink(), "never written through the link");
    const reused = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(reused.stdout.trim(), landed.stdout.trim(), "no second commit: the landed commit is reused");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r2-b2real");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c repair cycle 2/probe S1-reuse: a reused STATE.md-link commit completes after resume", async () => {
  const RUN = "run-c2c-r2-s1reuse";
  const fixture = await openFactoryPort("r2s1reuse", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    writeFileSync(join(worktree, "shared.txt"), "shared\n");
    await runGit({ cwd: worktree, args: ["add", "--", "shared.txt"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed shared file"] });
    // STATE.md itself is a link (mode 120000): the skip names the file,
    // re-described from the commit tree on the reuse path.
    await commitEntryLinkMode(worktree, "docs/project/STATE.md", "../../shared.txt");
    await checkoutEntryLinkAsPlainFile(worktree, "docs/project/STATE.md", "../../shared.txt");
    const setupCount = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
    let driven = await driveHandoff(fixture, RUN, { architect });
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const landed = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), String(Number(setupCount.stdout.trim()) + 1), "the stop-1 kernel commit landed");
    await resumeHandoff(fixture, RUN, "resume:c2c-r2-s1reuse", { architect });
    driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "resume reuses the commit and completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.match(String(payload.stateSkippedReason), /docs\/project\/STATE\.md is not written: docs\/project\/STATE\.md is a symbolic link or junction/, "the STATE.md skip is re-described from the commit tree");
    assert.equal(payload.bodyDigest, "", "no STATE.md is committed, so no digest is recorded");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: worktree, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md"]);
    assert.equal(readFileSync(join(worktree, "shared.txt"), "utf8"), "shared\n", "nothing is written outside the repository");
    const reused = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(reused.stdout.trim(), landed.stdout.trim(), "no second commit: the landed commit is reused");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r2-s1reuse");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c repair cycle 2/probe CI-reuse: a reused capital-Docs link commit completes after resume", async () => {
  const RUN = "run-c2c-r2-cireuse";
  const fixture = await openFactoryPort("r2cireuse", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outside = mkdtempSync(join(tmpdir(), "aiboard-c2c-outside-cireuse-"));
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    // A committed capital-Docs link to an outside directory: the checkout
    // is case-insensitive, so the commit-tree link backs the same skip.
    await commitEntryLinkMode(worktree, "Docs", outside);
    await checkoutDirLinkAsRealLink(worktree, "Docs");
    const setupCount = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
    let driven = await driveHandoff(fixture, RUN, { architect });
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const landed = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), String(Number(setupCount.stdout.trim()) + 1), "the stop-1 kernel commit landed");
    await resumeHandoff(fixture, RUN, "resume:c2c-r2-cireuse", { architect });
    driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "resume reuses the commit and completes");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.match(String(payload.stateSkippedReason), /docs\/project\/STATE\.md is not written: docs is a symbolic link or junction/, "the STATE.md skip is re-described from the case-folded commit tree");
    assert.equal(payload.bodyDigest, "", "no STATE.md is committed, so no digest is recorded");
    assert.deepEqual(readdirSync(outside), [], "nothing is written outside the repository");
    const reused = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(reused.stdout.trim(), landed.stdout.trim(), "no second commit: the landed commit is reused");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r2-cireuse");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("C2c repair cycle 2/probe E3-throw: a throwing stageability check never fails open", async () => {
  const RUN = "run-c2c-r2-e3throw";
  const fixture = await openFactoryPort("r2e3throw", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    mkdirSync(join(worktree, "docs", "project", "specs"), { recursive: true });
    writeFileSync(join(worktree, "docs", "project", "specs", "source_value.md"), "untracked other bytes\n");
    // The E3 occupant plus one injected check throw: the copy must count as
    // not stageable (rendered "not recorded"), never as stageable.
    const port = fixture.port;
    const orig = port.canStageSpecPath.bind(port);
    let armed = true;
    port.canStageSpecPath = async (input: { path: string; content: string }) => {
      if (armed) {
        armed = false;
        throw new Error("A verified process backend with required semantic capabilities is unavailable");
      }
      return orig(input);
    };
    const driven = await driveHandoff(fixture, RUN, { architect, artifacts });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
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
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r2-e3throw");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2c repair cycle 2/probe J-docs: an out-of-band docs junction pauses fail-closed", async () => {
  const RUN = "run-c2c-r2-jdocs";
  const fixture = await openFactoryPort("r2jdocs", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const outsideRoot = mkdtempSync(join(tmpdir(), "aiboard-c2c-outside-jdocs-"));
  writeFileSync(join(outsideRoot, "own.txt"), "outside owned\n");
  const architect = silentArchitect();
  try {
    const worktree = fixture.integration.path;
    // docs/keep.md is tracked, so the commit tree holds a regular docs
    // tree; then the worktree docs is replaced out-of-band by a junction.
    // The stage-time skip has no commit-tree backing, so the run pauses
    // fail-closed instead of recording it.
    mkdirSync(join(worktree, "docs"), { recursive: true });
    writeFileSync(join(worktree, "docs", "keep.md"), "keep\n");
    await runGit({ cwd: worktree, args: ["add", "--", "docs/keep.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed tracked docs file"] });
    rmSync(join(worktree, "docs"), { recursive: true, force: true });
    symlinkSync(outsideRoot, join(worktree, "docs"), "junction");
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 0, "no snapshot is recorded without commit-tree proof");
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.deepEqual(readdirSync(outsideRoot), ["own.txt"], "nothing is written outside the repository");
    await assert.rejects(
      selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2c-r2-jdocs"),
      /kernel handoff snapshot/,
      "the owner's selection is refused while the proof is missing",
    );
  } finally {
    await fixture.close();
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("C2e/m-7 refused append pauses: a refused snapshot append pauses with the reason and resume retries", async () => {
  const RUN = "run-c2e-m7append";
  const fixture = await openFactoryPort("c2em7append", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const architect = silentArchitect();
  try {
    // Fault injection: the reducer refuses the snapshot append once, as if
    // the runtime and the reducer disagreed about the record.
    const store = openHandoffStore(fixture, RUN);
    try {
      failNextSnapshotAppendOnce(store, "Handoff snapshots must include docs/project/STATE.md.");
      const runtime = buildRuntimeForHandoff({
        runId: RUN,
        store,
        projectDocs: fixture.port,
        architect,
        clock: advancingClock(),
        runPolicy: "plan_only",
        evidenceStore: fixture.evidence,
      });
      await runtime.runUntilBlocked();
      const events = store.readRun(RUN);
      assert.equal(events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0, "the refused append records nothing");
      const pauses = events.filter((event) => event.type === "run.paused");
      assert.equal(pauses.length, 1, "the refusal is a pause, not a pump error");
      assert.equal((pauses[0]!.payload as Record<string, unknown>).reason, "handoff_snapshot_failed");
      assert.match(String((pauses[0]!.payload as Record<string, unknown>).detail), /Handoff snapshots must include docs\/project\/STATE\.md/, "the pause carries the reducer's reason");
      const landed = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
      assert.equal(landed.stdout.trim(), "1", "the kernel commit landed before the refused append");
    } finally {
      store.close();
    }
    // A resume retries the same stop, reusing the landed commit by key.
    await resumeHandoff(fixture, RUN, "resume:c2e-m7append", { architect });
    const driven = await driveHandoff(fixture, RUN, { architect });
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the resume retries and records the snapshot");
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2e-m7append");
    assert.equal(selected.status, "completed", "the owner selection completes after the retry");
  } finally {
    await fixture.close();
  }
});

test("C2e/m-8 W-A4 second stop: a withdrawn docs-link stop records its empty second commit and completes", async () => {
  const RUN = "run-c2e-m8wa4";
  // The finish-run harness mirrors G2: stop 1's snapshot commit lands, the
  // read-back fails, guidance withdraws, FV re-runs and the Architect's
  // real second complete_run re-requests (stop 2). The layout is the exact
  // `docs` link (W-A4), so stop 2 commits empty: the entry files already
  // hold their sections.
  const preSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(runId, baseline).filter((event) => !event.type.startsWith("final_verification."));
  const fvSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(runId, baseline).filter((event) => event.type.startsWith("final_verification."));
  const fixture = await openFactoryPort("c2em8wa4", RUN, preSeed, "finish");
  appendHandoffEvents(fixture, RUN, fvSeed(RUN, fixture.baselineRevision));
  appendHandoffEvents(fixture, RUN, lowRiskSeed(RUN, fixture.baselineRevision));
  const outside = mkdtempSync(join(tmpdir(), "aiboard-c2e-outside-m8-"));
  writeFileSync(join(outside, "own.txt"), "outside\n");
  const worktree = fixture.integration.path;
  await commitEntryLinkMode(worktree, "docs", outside);
  await checkoutDirLinkAsRealLink(worktree, "docs");
  const setupHead = (await runGit({ cwd: worktree, args: ["rev-parse", "HEAD"] })).stdout.trim();
  // The stop-1 commit lands (entry files only: STATE.md is skipped under
  // the link), then the read-back fails: a transient failure after the
  // commit.
  failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
  const architect = silentArchitect("The build is complete and verified.");
  const verifierCalls = { calls: 0 };
  const verifier = productionRiskVerifier(fixture, RUN, verifierCalls);
  const driveOpts = { runPolicy: "finish" as const, architect, independentVerifier: verifier };
  try {
    let driven = await driveHandoff(fixture, RUN, { runPolicy: "finish", architect });
    assert.equal(driven.projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const landed = await runGit({ cwd: worktree, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), "2", "the link setup plus the stop-1 kernel commit landed");
    const stop1 = driven.events.find((event) => event.type === "project.handoff_requested")!.sequence;
    // The owner submits guidance instead of resuming: the handoff is
    // withdrawn. The Architect acknowledges with no plan change.
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
    ]);
    const withdrawn = readHandoffLog(fixture, RUN).projection;
    assert.equal(withdrawn.projectHandoff, undefined, "guidance withdrew the handoff");
    assert.equal((withdrawn.projectHandoffHistory ?? []).length, 1);
    // The link setup is an integration-branch move, so it is recorded as the
    // integration revision (as production records any later integration
    // commit, W-CI pattern): stop 1's landed commit then continues the
    // documents instead of dangling past the runner's tracking. Final
    // verification re-runs green on that head. Guidance invalidated the
    // stop-1 assessment, so the drive re-assesses through the real kernel
    // derivation (driveOpts) before the Architect's real second
    // complete_run re-requests (stop 2): no seeded risk event, no seeded
    // re-request.
    appendHandoffEvents(fixture, RUN, [
      seedEvent(RUN, "integration.revision_advanced", "integration-revision-setup", "runner", "integration", {
        integrationRevision: setupHead,
      }),
      ...fvRerunSeed(RUN, setupHead),
    ]);
    driven = await driveHandoff(fixture, RUN, driveOpts);
    const risks = driven.events.filter((event) => event.type === "build.risk_assessed");
    assert.equal(risks.length, 2, "the runtime re-assesses after the invalidation");
    assert.equal(
      risks[1]!.idempotencyKey,
      `build-risk:${setupHead}:generation-c2a-finish-rerun`,
      "the re-assessment is keyed by the re-run revision and generation",
    );
    assert.ok(verifierCalls.calls <= 3, `no assessRisk spin (${verifierCalls.calls} calls)`);
    // The withdrawn stop's landed commit was recorded as history before the
    // next stop committed: two snapshot events, one chain, the second one
    // empty.
    const snapshots = driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 2, "the withdrawn stop is history and the second stop commits");
    const first = snapshots[0]!.payload as Record<string, unknown>;
    const second = snapshots[1]!.payload as Record<string, unknown>;
    assert.equal(first.stopSequence, stop1, "the withdrawn stop is recorded first, as history");
    assert.match(String(first.stateSkippedReason), /docs is a symbolic link or junction/, "the withdrawn stop names the docs link");
    assert.deepEqual(second.paths, [], "stop 2 commits empty: the entry files already hold their sections");
    assert.match(String(second.stateSkippedReason), /docs is a symbolic link or junction/, "the empty commit still names the docs link");
    assert.equal(second.parent, first.commit, "the empty commit continues the withdrawn commit");
    assert.equal(driven.projection.projectDocs?.documentTip, second.commit);
    assert.deepEqual(readdirSync(outside), ["own.txt"], "nothing is written outside the repository");
    // The handoff succeeds only after the kernel record, and the project
    // holds the applied entry section plus the applied docs link.
    const projection = await applyAutomaticHandoff(fixture, RUN, { runPolicy: "finish" });
    assert.equal(projection.status, "completed", "the handoff succeeds after the empty commit");
    assert.equal(projection.projectHandoff?.choice, "apply_to_project");
    assert.equal(architect.calls(), 2, "stop 1 plus the real re-request; the kernel snapshot itself makes no model call");
    const appliedAgents = await runGit({ cwd: fixture.project, args: ["show", "HEAD:AGENTS.md"] });
    assert.ok(appliedAgents.stdout.includes(V2_AGENTS_SECTION_BODY), "the project holds the applied entry section");
    const appliedDocs = await runGit({ cwd: fixture.project, args: ["ls-tree", "HEAD", "--", "docs"] });
    assert.match(appliedDocs.stdout.trim(), /^120000 /, "the apply carries the docs link itself");
  } finally {
    await fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});
