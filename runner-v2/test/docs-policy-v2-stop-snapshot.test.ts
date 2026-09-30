import assert from "node:assert/strict";
import test from "node:test";

import {
  STOP_SNAPSHOT_TABLE,
  classifyStopSnapshot,
  type NewSchedulerEvent,
  type SchedulerActorRole,
} from "../src/scheduler-store.js";
import { runGit } from "./support/git-fixture.js";
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
