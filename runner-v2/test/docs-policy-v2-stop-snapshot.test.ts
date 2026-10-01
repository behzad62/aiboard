import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  STOP_SNAPSHOT_TABLE,
  classifyStopSnapshot,
  type NewSchedulerEvent,
  type SchedulerActorRole,
} from "../src/scheduler-store.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { type BuildStepResult, type IndependentVerifierDriver } from "../src/build-runtime.js";
import { createExecutionHost } from "../src/execution-host.js";
import { NativeBuildFactory, snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import type { BuildRiskAssessmentInput } from "../src/risk-policy.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { captureGitBaseline, runGit } from "./support/git-fixture.js";
import { acceptFinalVerificationProfile } from "./support/final-verification-profile.js";
import {
  driveHandoff,
  failNextSnapshotCommits,
  openFactoryPort,
  openHandoffStore,
  readHandoffLog,
  resumeHandoff,
  seedEvent,
  selectHandoffOwner,
  silentArchitect,
  v2FinishSeed,
  v2PlanOnlySeed,
  withRunOptions,
  CLOCK,
  CompletionArchitect,
  UnusedModel,
  advancingClock,
  buildRuntimeForHandoff,
  failNextSnapshotReadOnce,
  managedHandle,
  managerSpec,
  provider,
  safeSegment,
  gitDocsPort,
  headerDigest,
  openGitRepo,
  throwingArchitect,
  type FactoryPortFixture,
} from "./support/handoff-snapshot-harness.js";

/**
 * C3a: snapshot at every stop (AR-R08, packet C3 steps 1, 2 and 4).
 *
 * Every test builds its docs port through NativeBuildFactory
 * (`openFactoryPort`) and drives the run with `BuildRuntime.step`
 * (`driveHandoff`) on the real SQLite store (CD-7). The stop table itself
 * lives in code (`STOP_SNAPSHOT_TABLE` in scheduler-store.ts, used by C3b
 * for the stop notes); every snapshot here renders "no notes" (C3b adds
 * notes) and commits through C2's kernel-commit method and event.
 */

function e(
  runId: string,
  type: string,
  key: string,
  role: SchedulerActorRole,
  id: string,
  payload: Record<string, unknown>,
): NewSchedulerEvent {
  return seedEvent(runId, type, key, role, id, payload);
}

function pauseSeed(runId: string, reason: string): NewSchedulerEvent[] {
  return [
    ...v2PlanOnlySeed(runId),
    e(runId, "run.paused", `pause:${reason}`, "user", "local-user", { reason }),
  ];
}

function snapshotCommits(events: ReturnType<typeof readHandoffLog>["events"]) {
  return events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
}

function skipRecords(events: ReturnType<typeof readHandoffLog>["events"]) {
  return events.filter((event) => event.type === "project_docs.stop_snapshot_skipped");
}

async function revCount(fixture: FactoryPortFixture): Promise<string> {
  const count = await runGit({
    cwd: fixture.integration.path,
    args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`],
  });
  return count.stdout.trim();
}

async function stateBody(fixture: FactoryPortFixture, commit: string): Promise<string> {
  const shown = await runGit({
    cwd: fixture.integration.path,
    args: ["show", `${commit}:docs/project/STATE.md`],
  });
  return shown.stdout;
}

test("C3a/CD-7: a repair-limit pause commits a paused stop snapshot with open work", async () => {
  const RUN = "run-c3a-repair-limit";
  const seed = (runId: string, baselineRevision: string): NewSchedulerEvent[] => [
    ...v2PlanOnlySeed(runId),
    e(runId, "repair.policy_configured", "repair-policy", "runner", "build-runtime", {
      repairPlanLimit: 0,
      explicit: true,
    }),
    e(runId, "repair.cycle_limit_reached", "repair-limit", "runner", "build-runtime", {
      source: "verifier",
      targetRevision: baselineRevision,
      used: 0,
      limit: 0,
    }),
  ];
  const fixture = await openFactoryPort("stop-repair-limit", RUN, seed, "plan_only");
  try {
    const { events, projection } = await driveHandoff(fixture, RUN);
    assert.equal(projection.status, "paused", "the stop proceeds");
    assert.equal(projection.pauseReason?.reason, "repair_cycle_limit");
    const commits = snapshotCommits(events);
    assert.equal(commits.length, 1, "the pause commits exactly one stop snapshot");
    const payload = commits[0]!.payload as Record<string, unknown>;
    assert.equal(payload.stopKind, "paused");
    const body = await stateBody(fixture, payload.commit as string);
    assert.ok(body.includes("stop: paused \u2014 repair_cycle_limit"), "the header names the stop");
    assert.ok(
      body.includes("No Architect notes for this stop: stop notes are added in C3b"),
      "the snapshot says no notes",
    );
    assert.ok(body.includes("REQ-1"), "the snapshot carries the open work");
    assert.equal(await revCount(fixture), "1");
  } finally {
    await fixture.close();
  }
});

test("C3a: owner cancel writes a cancelled snapshot without notes", async () => {
  const RUN = "run-c3a-cancel";
  const fixture = await openFactoryPort("stop-cancel", RUN, (runId) => pauseSeed(runId, "owner_cancelled"), "plan_only");
  try {
    const { events, projection } = await driveHandoff(fixture, RUN);
    assert.equal(projection.status, "paused", "the stop proceeds");
    const commits = snapshotCommits(events);
    assert.equal(commits.length, 1);
    const payload = commits[0]!.payload as Record<string, unknown>;
    assert.equal(payload.stopKind, "cancelled");
    const body = await stateBody(fixture, payload.commit as string);
    assert.ok(body.includes("stop: cancelled \u2014 owner_cancelled"));
    assert.ok(body.includes("No Architect notes for this stop:"));
    assert.equal(await revCount(fixture), "1");
  } finally {
    await fixture.close();
  }
});

test("C3a: a terminal failure writes a failed snapshot", async () => {
  const RUN = "run-c3a-failed";
  const seed = (runId: string): NewSchedulerEvent[] => {
    const base = v2PlanOnlySeed(runId);
    return [
      ...base,
      e(runId, "context_manifest.recording_failed", "recording-failed", "runner", "build-runtime", {
        purpose: "record",
        attempts: 1,
        reason: "Injected recording failure.",
      }),
      e(runId, "run.paused", "recording-paused", "runner", "build-runtime", {
        reason: "context_recording_failed",
      }),
      e(runId, "context_manifest.recording_resolved", "recording-abort", "architect", "architect", {
        resolution: "abort",
        noteSequence: base.length + 1,
      }),
    ];
  };
  const fixture = await openFactoryPort("stop-failed", RUN, seed, "plan_only");
  try {
    const { events, projection } = await driveHandoff(fixture, RUN);
    assert.equal(projection.status, "failed", "the stop proceeds");
    assert.equal(projection.failureReason, "context_recording_aborted");
    const commits = snapshotCommits(events);
    assert.equal(commits.length, 1);
    const payload = commits[0]!.payload as Record<string, unknown>;
    assert.equal(payload.stopKind, "failed");
    const body = await stateBody(fixture, payload.commit as string);
    assert.ok(body.includes("stop: failed \u2014 "), `unexpected header: ${body.split("\n").slice(0, 8).join("\n")}`);
    assert.ok(body.includes("No Architect notes for this stop:"));
    assert.equal(await revCount(fixture), "1");
  } finally {
    await fixture.close();
  }
});

test("C3a: replay and resume create no duplicate commit; the next stop writes anew", async () => {
  const RUN = "run-c3a-replay";
  const fixture = await openFactoryPort("stop-replay", RUN, (runId) => pauseSeed(runId, "user"), "plan_only");
  try {
    const first = await driveHandoff(fixture, RUN);
    const pauseSequence = (first.events.find((event) => event.type === "run.paused"))!.sequence;
    assert.equal(snapshotCommits(first.events).length, 1);
    assert.equal(await revCount(fixture), "1");
    // Replaying the log (a fresh runtime, same store) records nothing new.
    const second = await driveHandoff(fixture, RUN);
    assert.equal(snapshotCommits(second.events).length, 1, "replay records no duplicate");
    assert.equal(skipRecords(second.events).length, 0, "replay records no skip either");
    assert.equal(await revCount(fixture), "1");
    // Resume and drive to handoff: the pause stop stays single, the handoff
    // stop (C2) writes its own new snapshot.
    await resumeHandoff(fixture, RUN, "resume:c3a-replay");
    const architect = silentArchitect();
    const third = await driveHandoff(fixture, RUN, { architect });
    assert.equal(third.projection.projectHandoff?.status, "requested");
    const commits = snapshotCommits(third.events);
    assert.equal(
      commits.filter((event) => (event.payload as Record<string, unknown>).stopSequence === pauseSequence).length,
      1,
      "resume records no duplicate for the pause stop",
    );
    assert.equal(commits.length, 2, "the handoff stop writes its own new snapshot");
    assert.equal(await revCount(fixture), "2");
  } finally {
    await fixture.close();
  }
});

test("C3a/CD-9: pause during triage, then answer, leaves the project tree hash unchanged", async () => {
  const RUN = "run-c3a-pretriage";
  // No triage yet: docs v2 plus the run policy only.
  const seed = (runId: string): NewSchedulerEvent[] => [
    e(runId, "project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }),
    e(runId, "run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }),
    e(runId, "planning.policy_configured", "planning-policy", "runner", "build-runtime", { version: 1 }),
    e(runId, "run.paused", "pause:pre-triage", "user", "local-user", { reason: "user" }),
  ];
  const fixture = await openFactoryPort("stop-pretriage", RUN, seed, "finish");
  try {
    const treeBefore = (await runGit({ cwd: fixture.project, args: ["rev-parse", "HEAD^{tree}"] })).stdout.trim();
    const paused = await driveHandoff(fixture, RUN, { runPolicy: "finish" });
    const skips = skipRecords(paused.events);
    assert.equal(skips.length, 1, "the pre-triage pause records its skip");
    assert.equal((skips[0]!.payload as Record<string, unknown>).reason, "pre_triage");
    assert.equal(snapshotCommits(paused.events).length, 0, "no snapshot before the triage decision");
    assert.equal(await revCount(fixture), "0");
    // Answer the run, then apply: with no snapshot commit anywhere, the
    // integration branch still matches the baseline, so the project tree
    // hash is unchanged.
    const answerStore = openHandoffStore(fixture, RUN);
    try {
      answerStore.append(e(RUN, "request.triaged", "triage", "architect", "architect", {
        decision: "answer",
        rationale: "A pure question.",
      }));
      answerStore.append(e(RUN, "request.answered", "answer", "architect", "architect", {
        answerText: "The value module must export 2.",
        addressedParts: ["What to export"],
      }));
    } finally {
      answerStore.close();
    }
    // The answer-path Architect turn requests the handoff (no snapshot:
    // answered runs are skipped); the real apply then carries an
    // integration branch the stop snapshots never touched.
    await resumeHandoff(fixture, RUN, "resume:c3a-pretriage", { runPolicy: "finish" });
    const architect = silentArchitect("The value module must export 2.");
    const answered = await driveHandoff(fixture, RUN, { runPolicy: "finish", architect });
    assert.equal(answered.projection.projectHandoff?.status, "requested");
    assert.equal(architect.calls(), 1, "only the answer turn runs");
    const selected = await selectHandoffOwner(fixture, RUN, "apply_to_project", "handoff:c3a-pretriage", {
      runPolicy: "finish",
    });
    assert.equal(selected.status, "completed");
    const treeAfter = (await runGit({ cwd: fixture.project, args: ["rev-parse", "HEAD^{tree}"] })).stdout.trim();
    assert.equal(treeAfter, treeBefore, "apply_to_project leaves the project tree hash unchanged");
    // C3a repair cycle 1 (M-5d): the integration branch revision itself
    // equals the baseline after the answer, not only the tree hash.
    const integrationHead = (await runGit({ cwd: fixture.integration.path, args: ["rev-parse", "HEAD"] })).stdout.trim();
    assert.equal(integrationHead, fixture.baselineRevision, "the integration branch revision equals the baseline after the answer");
    assert.equal(await revCount(fixture), "0", "the answered run commits nothing");
  } finally {
    await fixture.close();
  }
});

test("C3a/CD-5: an export_only pause writes nothing", async () => {
  const RUN = "run-c3a-exportonly";
  const fixture = await openFactoryPort(
    "stop-exportonly",
    RUN,
    (runId) => withRunOptions(pauseSeed(runId, "user"), { handoffFiles: "export_only" }),
    "plan_only",
    { handoffFiles: "export_only" },
  );
  try {
    const { events, projection } = await driveHandoff(fixture, RUN, { handoffFiles: "export_only" });
    assert.equal(projection.status, "paused", "the stop proceeds");
    assert.equal(snapshotCommits(events).length, 0, "export_only writes no snapshot");
    const skips = skipRecords(events);
    assert.equal(skips.length, 1);
    assert.equal((skips[0]!.payload as Record<string, unknown>).reason, "export_only");
    assert.equal(await revCount(fixture), "0");
  } finally {
    await fixture.close();
  }
});

test("C3a: a snapshot commit failure does not block the stop and records a finding", async () => {
  const RUN = "run-c3a-commit-failure";
  const fixture = await openFactoryPort("stop-commit-failure", RUN, (runId) => pauseSeed(runId, "user"), "plan_only");
  try {
    failNextSnapshotCommits(fixture.integration, 5, "Injected stop snapshot commit failure.");
    const { events, projection } = await driveHandoff(fixture, RUN);
    assert.equal(projection.status, "paused", "the stop proceeds");
    assert.equal(projection.pauseReason?.reason, "user");
    assert.equal(snapshotCommits(events).length, 0);
    const skips = skipRecords(events);
    assert.equal(skips.length, 1, "the failure records a finding");
    const reason = (skips[0]!.payload as Record<string, unknown>).reason as string;
    assert.ok(reason.startsWith("commit_failed: "), `unexpected skip reason: ${reason}`);
    assert.ok(reason.includes("Injected stop snapshot commit failure."));
    assert.equal(await revCount(fixture), "0", "a failed commit leaves no commit behind");
  } finally {
    await fixture.close();
  }
});

test("C3a: legacy (v1 docs policy) runs are unchanged", async () => {
  const RUN = "run-c3a-legacy";
  // A legacy run: docs policy v1 stamped explicitly (the factory would
  // otherwise stamp v2). The final-verification events stay out (their
  // profile archive validation is a factory concern, not this packet's).
  const seed = (runId: string, baselineRevision: string): NewSchedulerEvent[] => [
    e(runId, "project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 1 }),
    e(runId, "run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }),
    ...v2FinishSeed(runId, baselineRevision).filter((event) =>
      event.type !== "project_docs.policy_configured" &&
      event.type !== "run.policy_configured" &&
      !event.type.startsWith("final_verification.")),
    e(runId, "run.paused", "pause:legacy", "user", "local-user", { reason: "user" }),
  ];
  const fixture = await openFactoryPort("stop-legacy", RUN, seed, "finish");
  try {
    const before = readHandoffLog(fixture, RUN).events.length;
    const { events, projection } = await driveHandoff(fixture, RUN, { runPolicy: "finish" });
    assert.equal(projection.status, "paused");
    assert.equal(events.length, before, "a legacy run appends nothing at a stop");
    assert.equal(snapshotCommits(events).length, 0);
    assert.equal(skipRecords(events).length, 0);
  } finally {
    await fixture.close();
  }
});

test("C3a: the stop table classifies every stop reason", () => {
  assert.ok(STOP_SNAPSHOT_TABLE.length >= 15, "the table lists every stop");
  const byStop = new Map(STOP_SNAPSHOT_TABLE.map((entry) => [entry.stop, entry]));
  assert.equal(byStop.get("repair_cycle_limit")?.notes, "allowed");
  assert.equal(byStop.get("owner_cancelled (run.paused)")?.stopKind, "cancelled");
  assert.equal(byStop.get("owner_cancelled (run.paused)")?.notes, "denied");
  // C3a repair cycle 1 (M-2, M-3): the selection/handoff gates and the
  // pump's own pauses are in the table as notes-denied.
  assert.equal(byStop.get("verifier.selection_required")?.stopKind, "paused");
  assert.equal(byStop.get("verifier.selection_required")?.notes, "denied");
  assert.equal(byStop.get("architect.handoff_required")?.stopKind, "paused");
  assert.equal(byStop.get("architect.handoff_required")?.notes, "denied");
  assert.equal(byStop.get("no_mechanical_progress")?.stopKind, "paused");
  assert.equal(byStop.get("no_mechanical_progress")?.notes, "denied");
  assert.equal(byStop.get("autonomous_pump_error")?.stopKind, "paused");
  assert.equal(byStop.get("autonomous_pump_error")?.notes, "denied");
  assert.equal(byStop.get("context_recording_aborted")?.stopKind, "failed");
  // The classifier behind the table.
  assert.deepEqual(
    classifyStopSnapshot({ status: "paused", reason: "repair_cycle_limit", ownerInitiated: false }),
    { stopKind: "paused", notes: "allowed" },
  );
  assert.deepEqual(
    classifyStopSnapshot({
      status: "paused",
      reason: "repair_issue_paused:issue-1",
      detail: "repair:external_blocker:waiting on the owner",
      ownerInitiated: false,
    }),
    { stopKind: "paused", notes: "allowed" },
  );
  assert.deepEqual(
    classifyStopSnapshot({ status: "paused", reason: "user", ownerInitiated: true }),
    { stopKind: "paused", notes: "allowed" },
  );
  // C3a repair cycle 1 (M-3): reason first -- the pump's own pauses stay
  // denied even with the owner actor, while a genuinely unknown owner
  // reason stays allowed.
  assert.deepEqual(
    classifyStopSnapshot({ status: "paused", reason: "no_mechanical_progress", ownerInitiated: true }),
    { stopKind: "paused", notes: "denied" },
  );
  assert.deepEqual(
    classifyStopSnapshot({ status: "paused", reason: "autonomous_pump_error", ownerInitiated: true }),
    { stopKind: "paused", notes: "denied" },
  );
  assert.deepEqual(
    classifyStopSnapshot({ status: "paused", reason: "verifier.selection_required", ownerInitiated: false }),
    { stopKind: "paused", notes: "denied" },
  );
  assert.deepEqual(
    classifyStopSnapshot({ status: "paused", reason: "architect.handoff_required", ownerInitiated: false }),
    { stopKind: "paused", notes: "denied" },
  );
  assert.deepEqual(
    classifyStopSnapshot({ status: "paused", reason: "something_new", ownerInitiated: true }),
    { stopKind: "paused", notes: "allowed" },
  );
  assert.deepEqual(
    classifyStopSnapshot({ status: "paused", reason: "owner_cancelled", ownerInitiated: true }),
    { stopKind: "cancelled", notes: "denied" },
  );
  assert.deepEqual(
    classifyStopSnapshot({ status: "paused", reason: "budget_exhausted:modelCalls", ownerInitiated: true }),
    { stopKind: "paused", notes: "denied" },
  );
  assert.deepEqual(
    classifyStopSnapshot({ status: "paused", reason: "coverage_reviewer_unavailable", ownerInitiated: false }),
    { stopKind: "paused", notes: "denied" },
  );
  assert.deepEqual(
    classifyStopSnapshot({ status: "paused", reason: "something_new", ownerInitiated: false }),
    { stopKind: "paused", notes: "denied" },
  );
  assert.deepEqual(
    classifyStopSnapshot({ status: "failed", ownerInitiated: false }),
    { stopKind: "failed", notes: "denied" },
  );
});

/**
 * C3a repair cycle 1 (M-5): local fixture helpers for the factory+manager
 * tests below. The integration branch of a C2a-style fixture lives under
 * <state>/integration with exactly one entry.
 */
function c3aIntegrationRepoPath(state: string): string {
  const entries = readdirSync(join(state, "integration"));
  assert.equal(entries.length, 1);
  return join(state, "integration", entries[0]!);
}

async function c3aRevCount(state: string, baselineRevision: string): Promise<string> {
  const count = await runGit({
    cwd: c3aIntegrationRepoPath(state),
    args: ["rev-list", "--count", `${baselineRevision}..HEAD`],
  });
  return count.stdout.trim();
}

async function c3aStateBody(state: string, commit: string): Promise<string> {
  const shown = await runGit({
    cwd: c3aIntegrationRepoPath(state),
    args: ["show", `${commit}:docs/project/STATE.md`],
  });
  return shown.stdout;
}

test("C3a/CD-7/B-1/M-5c: factory runtime plus manager snapshots an owner pause with no step, then handoff completes", async () => {
  const RUN = "run-c3a-factory-manager";
  const root = mkdtempSync(join(tmpdir(), "aiboard-c3a-factory-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "c3a-factory-fixture", version: "1.0.0", type: "module" }, null, 2));
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: RUN });
  const runRoot = join(state, "builds", safeSegment(RUN));
  mkdirSync(runRoot, { recursive: true });
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"), {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  let manager: NativeBuildManager | undefined;
  const architect = new CompletionArchitect(() => manager!.projection(RUN));
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
  });
  let factory: NativeBuildFactory | undefined;
  try {
    factory = new NativeBuildFactory({
      projectRoot: project,
      stateDirectory: state,
      providerConfigs: {
        load: () => [provider("arch:architect", 1), provider("work:worker", 2), provider("rev:reviewer", 3)],
        save: () => undefined,
        close: () => undefined,
      },
      executionHost,
      baselineFor: () => baseline.revision,
      providerModelFactory: (config) => config.runtimeId === "arch:architect" ? architect : new UnusedModel(),
    });
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: (spec) => factory!.create(spec),
      prepareSpec: (spec) => factory!.prepareSpec(spec),
    });
    await manager.create(await factory.prepareSpec({
      version: 2,
      runId: RUN,
      projectId: "c3a-fixture",
      objective: "Plan the value module.",
      architectRuntimeId: "arch:architect",
      workerRuntimeIds: ["work:worker"],
      verifierRuntimeIds: ["rev:reviewer"],
      alwaysRequireIndependentVerifier: false,
      maxConcurrency: 1,
      permissionProfile: "full",
      runPolicy: "plan_only",
      budgetLimits: {},
      createdAt: CLOCK,
      idempotencyKey: "c3a-factory-manager",
    }));
    // The owner pause through the manager snapshots the stop with no step:
    // the pump never ran, so no Architect turn could have happened.
    const paused = await manager.pause(RUN, "user", "pause:c3a-factory");
    assert.equal(paused.status, "paused", "the stop proceeds");
    assert.equal(paused.pauseReason?.reason, "user");
    assert.equal(architect.calls, 0, "the pause snapshot takes no step and no model call");
    let events = manager.events(RUN);
    let commits = snapshotCommits(events);
    assert.equal(commits.length, 1, "the owner pause commits exactly one stop snapshot");
    const pausePayload = commits[0]!.payload as Record<string, unknown>;
    assert.equal(pausePayload.stopKind, "paused");
    assert.equal(await c3aRevCount(state, baseline.revision), "1");
    // Resume, then the real pump drives to handoff; the handoff snapshot
    // continues the chain past the stop commit.
    await manager.resume(RUN, "resume:c3a-factory");
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).projectHandoff?.status, "requested");
    assert.equal(architect.calls, 1, "only the completion turn runs");
    events = manager.events(RUN);
    commits = snapshotCommits(events);
    assert.equal(commits.length, 2, "resume adds only the handoff snapshot");
    const handoff = commits.find((event) => (event.payload as Record<string, unknown>).stopKind === "plan_only")!;
    const handoffPayload = handoff.payload as Record<string, unknown>;
    assert.equal(await c3aRevCount(state, baseline.revision), "2");
    const repoPath = c3aIntegrationRepoPath(state);
    const lineage = (await runGit({ cwd: repoPath, args: ["log", "--format=%H %P", `${baseline.revision}..HEAD`] })).stdout.trim().split("\n");
    assert.equal(lineage.length, 2);
    assert.ok(lineage[0]!.startsWith(handoffPayload.commit as string));
    assert.ok(lineage[0]!.includes(pausePayload.commit as string), "the handoff commit descends from the stop commit");
    assert.equal(
      headerDigest(await c3aStateBody(state, handoffPayload.commit as string)),
      handoffPayload.bodyDigest,
      "the handoff snapshot is correct",
    );
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c3a-factory");
    assert.equal(selected.status, "completed", "handoff completes after the stop snapshot");
    assert.equal(architect.calls, 1, "snapshots make no model call");
  } finally {
    await manager?.close();
    await factory?.close();
    await executionHost.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function highRiskAssessmentInput(): BuildRiskAssessmentInput {
  return {
    architectDeclaration: "low",
    stricterQualification: false,
    kernelFacts: {
      destructiveEffects: false,
      credentialEffects: false,
      externalWriteEffects: false,
      integrationConflict: false,
      changedPaths: ["src/auth/session.ts"],
    },
  };
}

/**
 * C3a repair cycle 1 (M-5b/M-2): a finish run whose next pump pass pauses
 * in-step at verifier selection. An older, resumed owner pause sits in the
 * log, so the stop lookup must prefer the newer selection stop.
 */
function verifierFinishSeed(runId: string, baselineRevision: string): NewSchedulerEvent[] {
  const finishPolicy = (event: NewSchedulerEvent): NewSchedulerEvent =>
    event.type === "run.policy_configured"
      ? { ...event, payload: { ...(event.payload as Record<string, unknown>), runPolicy: "finish" } }
      : event;
  return [
    ...v2PlanOnlySeed(runId).map(finishPolicy),
    e(runId, "run.paused", "pause:old", "user", "local-user", { reason: "user" }),
    e(runId, "run.resumed", "resume:old", "user", "local-user", {}),
    e(runId, "integration.revision_advanced", "integration-revision", "runner", "integration", {
      integrationRevision: baselineRevision,
    }),
    e(runId, "verifier.policy_configured", "verifier-policy", "runner", "build-runtime", {
      mode: "risk_based",
      candidateRuntimeIds: ["google:verifier"],
      alwaysRequireIndependentVerifier: false,
    }),
    ...v2FinishSeed(runId, baselineRevision).filter((event) =>
      event.type !== "project_docs.policy_configured" &&
      event.type !== "run.policy_configured" &&
      event.type !== "plan.created" &&
      event.type !== "integration.revision_advanced"),
  ];
}

test("C3a/B-1/M-2: an in-step verifier pause snapshots the new stop with no extra step", async () => {
  const RUN = "run-c3a-instep-verifier";
  // C2a-style direct setup (not openFactoryPort): the factory replays
  // seeds through its strict profile validation, which refuses the
  // seeded final-verification chain. The port below is still the real
  // integration-backed kernel path on real SQLite.
  const repo = await openGitRepo("stop-instep-verifier", RUN);
  const schedulerDir = join(repo.root, "builds", safeSegment(RUN));
  mkdirSync(schedulerDir, { recursive: true });
  const evidence = new SqliteEvidenceStore(join(repo.root, "evidence.sqlite"));
  const storeOptions = {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  };
  const seeder = new SqliteSchedulerStore(join(schedulerDir, "scheduler.sqlite"), storeOptions);
  for (const input of verifierFinishSeed(RUN, repo.baselineRevision)) seeder.append(input);
  seeder.close();
  const fixture = {
    port: gitDocsPort(repo.integration, {}),
    evidence,
    state: repo.root,
    integration: repo.integration,
    baselineRevision: repo.baselineRevision,
    close: async () => { evidence.close(); await repo.close(); },
  } as unknown as FactoryPortFixture;
  const verifier: IndependentVerifierDriver = {
    candidateRuntimeIds: ["google:verifier"],
    assessRisk: async () => highRiskAssessmentInput(),
    verify: async () => ({ status: "suspended", reason: "budget_exhausted", runtimeId: "google:verifier" }),
  };
  try {
    const store = openHandoffStore(fixture, RUN);
    try {
      const runtime = buildRuntimeForHandoff({
        runId: RUN,
        store,
        projectDocs: fixture.port,
        architect: throwingArchitect(),
        clock: advancingClock(),
        runPolicy: "finish",
        independentVerifier: verifier,
      });
      // Step one assesses the risk; step two pauses in-step at verifier
      // selection -- and that same step commits the stop snapshot.
      assert.equal((await runtime.step()).action, "build_risk_assessed");
      const paused = await runtime.step();
      assert.equal(paused.status, "paused");
      assert.equal(paused.action, "verifier_selection_required");
      const events = store.readRun(RUN);
      const oldPause = events.find((event) => event.type === "run.paused")!;
      const selection = events.find((event) => event.type === "verifier.selection_required")!;
      const commits = snapshotCommits(events);
      assert.equal(commits.length, 1, "the same step commits the stop snapshot with no extra step");
      const payload = commits[0]!.payload as Record<string, unknown>;
      assert.equal(payload.stopKind, "paused");
      assert.equal(
        payload.stopSequence,
        selection.sequence,
        "the lookup finds the new selection stop, not the older pause",
      );
      assert.notEqual(payload.stopSequence, oldPause.sequence);
      const body = await stateBody(fixture, payload.commit as string);
      assert.ok(body.includes("verifier selection required"), "the header names the selection stop");
      assert.equal(await revCount(fixture), "1");
    } finally {
      store.close();
    }
  } finally {
    await fixture.close();
  }
});

test("C3a/M-2: an architect handoff stop snapshots instead of reusing an older stop", async () => {
  const RUN = "run-c3a-architect-handoff";
  const seed = (runId: string): NewSchedulerEvent[] => [
    ...v2PlanOnlySeed(runId),
    e(runId, "run.paused", "pause:old", "user", "local-user", { reason: "user" }),
    e(runId, "run.resumed", "resume:old", "user", "local-user", {}),
    e(runId, "architect.handoff_required", "architect-handoff", "runner", "runtime-router", {
      reason: "arch_failed",
      requiredCapabilities: ["code"],
      candidateRuntimeIds: ["arch:other"],
    }),
  ];
  const fixture = await openFactoryPort("stop-architect-handoff", RUN, seed, "plan_only");
  try {
    const { events, projection } = await driveHandoff(fixture, RUN);
    assert.equal(projection.status, "paused", "the stop proceeds");
    const oldPause = events.find((event) => event.type === "run.paused")!;
    const handoffRequired = events.find((event) => event.type === "architect.handoff_required")!;
    const commits = snapshotCommits(events);
    assert.equal(commits.length, 1);
    const payload = commits[0]!.payload as Record<string, unknown>;
    assert.equal(payload.stopKind, "paused");
    assert.equal(payload.stopSequence, handoffRequired.sequence);
    assert.notEqual(payload.stopSequence, oldPause.sequence);
    const body = await stateBody(fixture, payload.commit as string);
    assert.ok(body.includes("architect handoff required"), "the header names the handoff stop");
    assert.equal(await revCount(fixture), "1");
  } finally {
    await fixture.close();
  }
});

test("C3a/B-1: an owner cancel through NativeBuildManager.pause gets a cancelled snapshot", async () => {
  const RUN = "run-c3a-manager-cancel";
  const fixture = await openFactoryPort("stop-manager-cancel", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  let manager: NativeBuildManager | undefined;
  const store = openHandoffStore(fixture, RUN);
  try {
    const runtime = buildRuntimeForHandoff({
      runId: RUN,
      store,
      projectDocs: fixture.port,
      architect: throwingArchitect(),
      clock: advancingClock(),
      runPolicy: "plan_only",
      evidenceStore: fixture.evidence,
    });
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(fixture.state, "cancel-builds.sqlite")),
      createRuntime: async () => managedHandle(
        runtime,
        async () => ({
          integrationRevision: fixture.baselineRevision,
          integrationBranch: "aiboard/run/integration",
          appliedToProject: false,
        }),
        RUN,
      ),
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    const paused = await manager.pause(RUN, "owner_cancelled", "cancel:c3a-manager");
    assert.equal(paused.status, "paused", "the stop proceeds");
    assert.equal(paused.pauseReason?.reason, "owner_cancelled");
    const events = manager.events(RUN);
    const commits = snapshotCommits(events);
    assert.equal(commits.length, 1, "the owner cancel commits exactly one stop snapshot with no step");
    const payload = commits[0]!.payload as Record<string, unknown>;
    assert.equal(payload.stopKind, "cancelled");
    const body = await stateBody(fixture, payload.commit as string);
    assert.ok(body.includes("stop: cancelled — owner_cancelled"));
    assert.ok(body.includes("No Architect notes for this stop:"));
    assert.equal(await revCount(fixture), "1");
  } finally {
    await manager?.close();
    store.close();
    await fixture.close();
  }
});

test("C3a/B-1/M-3: the pump's no_mechanical_progress pause gets a notes-denied snapshot", async () => {
  const RUN = "run-c3a-pump-idle";
  const fixture = await openFactoryPort("stop-pump-idle", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  let manager: NativeBuildManager | undefined;
  const store = openHandoffStore(fixture, RUN);
  try {
    const runtime = buildRuntimeForHandoff({
      runId: RUN,
      store,
      projectDocs: fixture.port,
      architect: throwingArchitect(),
      clock: advancingClock(),
      runPolicy: "plan_only",
      evidenceStore: fixture.evidence,
    });
    // Dispatch would do real work; simulate its idle return so the pump
    // records its own pause. Everything from the pause on is production.
    runtime.runUntilBlocked = async (): Promise<BuildStepResult> => ({ status: "idle" });
    const pumpResults: BuildStepResult[] = [];
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(fixture.state, "idle-builds.sqlite")),
      onPumpResult: (_runId, result) => pumpResults.push(result),
      createRuntime: async () => managedHandle(
        runtime,
        async () => ({
          integrationRevision: fixture.baselineRevision,
          integrationBranch: "aiboard/run/integration",
          appliedToProject: false,
        }),
        RUN,
      ),
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.deepEqual(pumpResults, [{ status: "paused", action: "no_mechanical_progress" }]);
    const events = manager.events(RUN);
    const pause = events.find((event) => event.type === "run.paused")!;
    assert.equal((pause.payload as Record<string, unknown>).reason, "no_mechanical_progress");
    assert.equal(pause.actor.role, "user", "the pump records through pause()");
    const commits = snapshotCommits(events);
    assert.equal(commits.length, 1, "the pump pause commits exactly one stop snapshot with no extra step");
    const payload = commits[0]!.payload as Record<string, unknown>;
    assert.equal(payload.stopKind, "paused");
    assert.equal(payload.stopSequence, pause.sequence);
    assert.equal(await revCount(fixture), "1");
    assert.deepEqual(
      classifyStopSnapshot({ status: "paused", reason: "no_mechanical_progress", ownerInitiated: true }),
      { stopKind: "paused", notes: "denied" },
      "the runner-originated pause is notes-denied by reason",
    );
  } finally {
    await manager?.close();
    store.close();
    await fixture.close();
  }
});

test("C3a/M-4: a landed commit with a failed record reports record_failed with the commit id", async () => {
  const RUN = "run-c3a-record-failed";
  const fixture = await openFactoryPort("stop-record-failed", RUN, (runId) => pauseSeed(runId, "user"), "plan_only");
  try {
    // The commit lands; only its read-back fails, so the commit exists
    // while its record does not.
    failNextSnapshotReadOnce(fixture.integration, "Injected stop snapshot read-back failure.");
    const { events, projection } = await driveHandoff(fixture, RUN);
    assert.equal(projection.status, "paused", "the stop proceeds");
    assert.equal(snapshotCommits(events).length, 0);
    const skips = skipRecords(events);
    assert.equal(skips.length, 1);
    const reason = (skips[0]!.payload as Record<string, unknown>).reason as string;
    assert.ok(reason.startsWith("record_failed: "), `unexpected skip reason: ${reason}`);
    assert.ok(!reason.startsWith("commit_failed"), "never commit_failed for a commit that exists");
    const commit = reason.slice("record_failed: ".length).split(":")[0]!.trim();
    assert.match(commit, /^[a-f0-9]{40}$/, "the reason carries the landed commit id");
    await runGit({ cwd: fixture.integration.path, args: ["cat-file", "-e", commit] });
    assert.equal(await revCount(fixture), "1", "the landed commit stays on the branch");
    // A later drive records nothing new for the old stop.
    const second = await driveHandoff(fixture, RUN);
    assert.equal(snapshotCommits(second.events).length, 0);
    assert.equal(skipRecords(second.events).length, 1, "no duplicate record for the old stop");
    assert.equal(await revCount(fixture), "1");
  } finally {
    await fixture.close();
  }
});

test("C3a/M-4: a refused skip append never throws out of the stop", async () => {
  const RUN = "run-c3a-skip-refused";
  const fixture = await openFactoryPort("stop-skip-refused", RUN, (runId) => pauseSeed(runId, "user"), "plan_only");
  try {
    failNextSnapshotCommits(fixture.integration, 5, "Injected stop snapshot commit failure.");
    const proto = SqliteSchedulerStore.prototype;
    const origAppend = proto.append;
    let armed = true;
    proto.append = function (this: SqliteSchedulerStore, event: NewSchedulerEvent) {
      if (armed && event.type === "project_docs.stop_snapshot_skipped") {
        armed = false;
        throw new Error("Stop snapshot skip for the stop is already recorded.");
      }
      return origAppend.call(this, event);
    };
    try {
      const { projection } = await driveHandoff(fixture, RUN);
      assert.equal(projection.status, "paused", "the stop proceeds despite the refused skip");
    } finally {
      proto.append = origAppend;
    }
    assert.equal(armed, false, "the refusal path executed");
    const { events } = readHandoffLog(fixture, RUN);
    assert.equal(snapshotCommits(events).length, 0);
    assert.equal(await revCount(fixture), "0", "a failed commit leaves no commit behind");
  } finally {
    await fixture.close();
  }
});
