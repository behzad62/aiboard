import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type {
  AgentModel,
  AgentModelRequest,
  ModelTurn,
} from "../src/agent-contracts.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import {
  rebuildSchedulerProjection,
  stopNotesForStop,
  stopNotesAttemptForStop,
  stopNotesFailureForStop,
  STOP_NOTES_MAX_LENGTH,
  type NewSchedulerEvent,
  type SchedulerActorRole,
  type SchedulerEvent,
} from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteContextManifestStore } from "../src/sqlite-context-manifest-store.js";
import { HANDOFF_SNAPSHOT_NOTES_MAX_LENGTH } from "../src/handoff-snapshot.js";
import {
  buildStopNotesFacts,
  buildStopNotesMessages,
  extractStopNotesText,
  STOP_NOTES_CONTEXT_PURPOSE,
} from "../src/native-architect-runtime.js";
import {
  driveHandoff,
  openFactoryPort,
  pauseHandoff,
  readHandoffLog,
  resumeHandoff,
  seedEvent,
  v2AnsweredSeed,
  v2PlanOnlySeed,
  withRunOptions,
  UnusedModel,
  safeSegment,
  type FactoryPortFixture,
} from "./support/handoff-snapshot-harness.js";
import { runGit } from "./support/git-fixture.js";

/**
 * C3b: Architect stop notes (AR-R09, packet C3 step 3).
 *
 * Every factory test builds its docs port through NativeBuildFactory
 * (`openFactoryPort`) and drives the run with `BuildRuntime.step`
 * (`driveHandoff`) on the real SQLite store (CD-7). Only the provider
 * transport is scripted (`modelsFor` returns the scripted Architect
 * model); every application service -- the scheduler store, the budget
 * ledger, the context manifests, the Architect runtime, the docs port,
 * git -- is the factory's own. The stop table lives in code
 * (`STOP_SNAPSHOT_TABLE`); C3a deliberately renders no notes, C3c owns
 * revision targeting and trailers, C4/C5 own prompt reforms.
 */

const NOTES_TEXT =
  "Next: keep the value module as is. Trap: do not hand-edit docs/project/STATE.md. Try: run the value test.";

/** Scripted provider transport for arch:architect: asserts the one-shot shape, returns fixed text. */
class ScriptedNotesModel implements AgentModel {
  calls = 0;
  requests: AgentModelRequest[] = [];
  constructor(private readonly textForCall: (call: number) => string) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.calls += 1;
    this.requests.push(request);
    assert.equal(request.tools.length, 0, "the stop-notes call offers zero tools");
    assert.equal(request.toolChoice, "none", "the stop-notes call disables tool choice");
    assert.equal(
      request.hostedTools?.length ?? 0,
      0,
      "the stop-notes call offers no hosted tools",
    );
    const text = this.textForCall(this.calls);
    return {
      blocks: [{ type: "text", text }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

function modelsFor(scripted: ScriptedNotesModel): (config: RunnerProviderConfig) => AgentModel {
  return (config) =>
    config.runtimeId === "arch:architect" ? scripted : new UnusedModel();
}

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

function repairLimitSeed(runId: string, baselineRevision: string): NewSchedulerEvent[] {
  return [
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
}

function pauseSeed(runId: string, reason: string, role: SchedulerActorRole = "user"): NewSchedulerEvent[] {
  return [
    ...v2PlanOnlySeed(runId),
    e(runId, "run.paused", `pause:${reason}`, role, role === "user" ? "local-user" : "build-runtime", { reason }),
  ];
}

function snapshotCommits(events: ReturnType<typeof readHandoffLog>["events"]) {
  return events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
}

function notesEvents(events: ReturnType<typeof readHandoffLog>["events"]) {
  return events.filter((event) => event.type === "handoff.notes_recorded");
}

function notesAttemptEvents(events: ReturnType<typeof readHandoffLog>["events"]) {
  return events.filter((event) => event.type === "handoff.notes_attempted");
}

function notesFailedEvents(events: ReturnType<typeof readHandoffLog>["events"]) {
  return events.filter((event) => event.type === "handoff.notes_failed");
}

/** Well-ordered stored events for reducer tests: sequences assigned in append order. */
function asStored(runId: string, inputs: NewSchedulerEvent[]): SchedulerEvent[] {
  return inputs.map((input, index) => ({
    eventId: `${runId}-e${index + 1}`,
    runId,
    sequence: index + 1,
    type: input.type,
    occurredAt: input.occurredAt,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
  }));
}

async function stateBody(fixture: FactoryPortFixture, commit: string): Promise<string> {
  const shown = await runGit({
    cwd: fixture.integration.path,
    args: ["show", `${commit}:docs/project/STATE.md`],
  });
  return shown.stdout;
}

/** Durable EP40 purpose records for one run. */
function notesManifests(fixture: FactoryPortFixture, runId: string) {
  const store = new SqliteContextManifestStore(
    join(fixture.state, "builds", safeSegment(runId), "context-manifests.sqlite"),
    { readOnly: true },
  );
  try {
    return store.listRun(runId).filter((manifest) => manifest.purpose === STOP_NOTES_CONTEXT_PURPOSE);
  } finally {
    store.close();
  }
}

/** Durable budget-ledger model reservations/settlements attributed to the Architect for one run. */
function architectModelCharges(fixture: FactoryPortFixture, runId: string): { reserved: number; settled: number } {
  const database = new DatabaseSync(
    join(fixture.state, "builds", safeSegment(runId), "budget.sqlite"),
    { readOnly: true },
  );
  try {
    const rows = database
      .prepare("SELECT event_type, payload_json FROM budget_events WHERE scope_id = ?")
      .all(runId) as { event_type: string; payload_json: string }[];
    let reserved = 0;
    let settled = 0;
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as {
        attribution?: { role?: string };
        reservationId?: string;
      };
      if (row.event_type === "budget.reserved" && payload.attribution?.role === "architect") reserved += 1;
      if (row.event_type === "budget.settled" && typeof payload.reservationId === "string") settled += 1;
    }
    return { reserved, settled };
  } finally {
    database.close();
  }
}

test("C3b/CD-7: a repair-limit stop writes open work and scripted Architect notes through the actual factory wiring", async () => {
  const RUN = "run-c3b-repair-notes";
  const scripted = new ScriptedNotesModel(() => NOTES_TEXT);
  const fixture = await openFactoryPort("notes-repair", RUN, repairLimitSeed, "plan_only", {
    modelsFor: modelsFor(scripted),
  });
  try {
    const { events, projection } = await driveHandoff(fixture, RUN, { stopNotes: fixture.stopNotes });
    assert.equal(projection.status, "paused", "the stop proceeds");
    assert.equal(projection.pauseReason?.reason, "repair_cycle_limit");
    assert.equal(scripted.calls, 1, "exactly one notes call for the stop");
    const commits = snapshotCommits(events);
    assert.equal(commits.length, 1, "the pause commits exactly one stop snapshot");
    assert.equal((commits[0]!.payload as Record<string, unknown>).stopKind, "paused");
    const body = await stateBody(fixture, (commits[0]!.payload as Record<string, unknown>).commit as string);
    assert.ok(body.includes("stop: paused — repair_cycle_limit"), "the header names the stop");
    assert.ok(body.includes("REQ-1"), "the snapshot carries the open work");
    assert.ok(
      body.includes("> Next: keep the value module as is."),
      "the snapshot renders the Architect notes",
    );
    assert.ok(!body.includes("No Architect notes for this stop:"), "no no-notes line when notes exist");
    const noted = notesEvents(events);
    assert.equal(noted.length, 1, "one additive notes event");
    assert.deepEqual(noted[0]!.actor, { role: "architect", id: "arch:architect" });
    assert.equal(noted[0]!.idempotencyKey, `handoff-notes:${noted[0]!.payload.stopSequence}`);
    assert.equal((noted[0]!.payload as Record<string, unknown>).notes, NOTES_TEXT);
    const manifests = notesManifests(fixture, RUN);
    assert.equal(manifests.length, 1, "the call records purpose handoff_notes (EP40)");
    assert.equal(manifests[0]!.role, "architect");
    const charges = architectModelCharges(fixture, RUN);
    assert.equal(charges.reserved, 1, "one Architect model reservation");
    assert.equal(charges.settled, 1, "the reservation settles");
  } finally {
    await fixture.close();
  }
});

test("C3b: a run-budget exhausted pause writes the no-notes line and makes no model call or purpose charge", async () => {
  const RUN = "run-c3b-budget";
  const scripted = new ScriptedNotesModel(() => NOTES_TEXT);
  const fixture = await openFactoryPort(
    "notes-budget",
    RUN,
    (runId) => pauseSeed(runId, "budget_exhausted:model", "runner"),
    "plan_only",
    { modelsFor: modelsFor(scripted) },
  );
  try {
    const { events, projection } = await driveHandoff(fixture, RUN, { stopNotes: fixture.stopNotes });
    assert.equal(projection.status, "paused", "the stop proceeds");
    assert.equal(scripted.calls, 0, "no model call on exhausted run budget");
    const commits = snapshotCommits(events);
    assert.equal(commits.length, 1, "the snapshot still writes");
    const body = await stateBody(fixture, (commits[0]!.payload as Record<string, unknown>).commit as string);
    assert.ok(
      body.includes("No Architect notes for this stop: the run budget is exhausted; no budget remains for a notes call"),
      `unexpected notes line: ${body.split("\n").filter((line) => line.includes("Architect notes")).join("\n")}`,
    );
    assert.equal(notesEvents(events).length, 0, "no notes event");
    assert.equal(notesManifests(fixture, RUN).length, 0, "no handoff_notes purpose record");
    assert.deepEqual(architectModelCharges(fixture, RUN), { reserved: 0, settled: 0 }, "no purpose charge");
  } finally {
    await fixture.close();
  }
});

test("C3b: a notes provider failure still writes a snapshot and does not change stop behavior", async () => {
  const RUN = "run-c3b-notes-failure";
  const scripted = new ScriptedNotesModel(() => {
    throw new Error("Injected provider failure.");
  });
  const fixture = await openFactoryPort("notes-failure", RUN, repairLimitSeed, "plan_only", {
    modelsFor: modelsFor(scripted),
  });
  try {
    const { events, projection } = await driveHandoff(fixture, RUN, { stopNotes: fixture.stopNotes });
    assert.equal(projection.status, "paused", "the stop proceeds");
    assert.equal(projection.pauseReason?.reason, "repair_cycle_limit", "the pause reason is unchanged");
    assert.equal(scripted.calls, 1, "the call was attempted once");
    const commits = snapshotCommits(events);
    assert.equal(commits.length, 1, "the snapshot still writes");
    const body = await stateBody(fixture, (commits[0]!.payload as Record<string, unknown>).commit as string);
    assert.ok(
      body.includes("No Architect notes for this stop: stop notes call failed (Injected provider failure.)"),
      "the snapshot names the failure",
    );
    assert.equal(notesEvents(events).length, 0, "no notes event on failure");
  } finally {
    await fixture.close();
  }
});

test("C3b: a hanging notes call times out, aborts its signal, and still writes a snapshot", async () => {
  const RUN = "run-c3b-notes-timeout";
  let calls = 0;
  let seenSignal: AbortSignal | undefined;
  const hanging: AgentModel = {
    async complete(request: AgentModelRequest): Promise<ModelTurn> {
      calls += 1;
      seenSignal = request.signal;
      await new Promise<never>(() => {});
      throw new Error("unreachable");
    },
  };
  const fixture = await openFactoryPort("notes-timeout", RUN, repairLimitSeed, "plan_only", {
    modelsFor: (config) => (config.runtimeId === "arch:architect" ? hanging : new UnusedModel()),
  });
  try {
    const { events, projection } = await driveHandoff(fixture, RUN, {
      stopNotes: fixture.stopNotes,
      stopNotesTimeoutMs: 50,
    });
    assert.equal(projection.status, "paused", "the stop proceeds");
    assert.equal(calls, 1, "the call was attempted once");
    assert.equal(seenSignal?.aborted, true, "the time bound aborts the call signal");
    const commits = snapshotCommits(events);
    assert.equal(commits.length, 1, "the snapshot still writes");
    const body = await stateBody(fixture, (commits[0]!.payload as Record<string, unknown>).commit as string);
    assert.ok(
      body.includes("No Architect notes for this stop: the stop notes call timed out"),
      "the snapshot names the timeout",
    );
    assert.equal(notesEvents(events).length, 0, "no notes event on timeout");
  } finally {
    await fixture.close();
  }
});

test("C3b: cancel and unknown reasons deny notes; skip states and legacy docs v1 never call", async () => {
  const scripted = new ScriptedNotesModel(() => NOTES_TEXT);
  const forScripted = { modelsFor: modelsFor(scripted) };
  // Cancel.
  const cancelFixture = await openFactoryPort(
    "notes-cancel",
    "run-c3b-cancel",
    (runId) => pauseSeed(runId, "owner_cancelled"),
    "plan_only",
    forScripted,
  );
  try {
    const { events, projection } = await driveHandoff(cancelFixture, "run-c3b-cancel", {
      stopNotes: cancelFixture.stopNotes,
    });
    assert.equal(projection.status, "paused");
    const commits = snapshotCommits(events);
    assert.equal(commits.length, 1);
    assert.equal((commits[0]!.payload as Record<string, unknown>).stopKind, "cancelled");
    const body = await stateBody(cancelFixture, (commits[0]!.payload as Record<string, unknown>).commit as string);
    assert.ok(body.includes("No Architect notes for this stop: the run was cancelled; notes are pointless"));
    assert.equal(notesEvents(events).length, 0);
  } finally {
    await cancelFixture.close();
  }
  assert.equal(scripted.calls, 0, "cancel makes no model call");
  // Unknown runner reason (fail closed).
  const unknownFixture = await openFactoryPort(
    "notes-unknown",
    "run-c3b-unknown",
    (runId) => pauseSeed(runId, "mystery_halt_xyz", "runner"),
    "plan_only",
    forScripted,
  );
  try {
    const { events } = await driveHandoff(unknownFixture, "run-c3b-unknown", {
      stopNotes: unknownFixture.stopNotes,
    });
    const commits = snapshotCommits(events);
    assert.equal(commits.length, 1, "the snapshot still writes");
    const body = await stateBody(unknownFixture, (commits[0]!.payload as Record<string, unknown>).commit as string);
    assert.ok(body.includes("No Architect notes for this stop: the mystery_halt_xyz stop does not allow model calls"));
    assert.equal(notesEvents(events).length, 0);
  } finally {
    await unknownFixture.close();
  }
  assert.equal(scripted.calls, 0, "unknown reasons make no model call");
  // Skip state: export_only writes nothing and never calls.
  const exportSeed = (runId: string, baselineRevision: string): NewSchedulerEvent[] =>
    withRunOptions(repairLimitSeed(runId, baselineRevision), { handoffFiles: "export_only" });
  const exportFixture = await openFactoryPort("notes-export", "run-c3b-export", exportSeed, "plan_only", {
    ...forScripted,
    handoffFiles: "export_only",
  });
  try {
    const { events } = await driveHandoff(exportFixture, "run-c3b-export", {
      stopNotes: exportFixture.stopNotes,
      handoffFiles: "export_only",
    });
    assert.equal(snapshotCommits(events).length, 0, "a skipped stop commits nothing");
    assert.equal(notesEvents(events).length, 0);
  } finally {
    await exportFixture.close();
  }
  assert.equal(scripted.calls, 0, "skip states make no model call");
  // Legacy docs v1 never calls notes.
  const v1Fixture = await openFactoryPort(
    "notes-v1",
    "run-c3b-v1",
    (runId) => [
      e(runId, "project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 1 }),
      e(runId, "run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "plan_only" }),
      e(runId, "run.paused", "pause:user", "user", "local-user", { reason: "user" }),
    ],
    "plan_only",
    forScripted,
  );
  try {
    const { events, projection } = await driveHandoff(v1Fixture, "run-c3b-v1", {
      stopNotes: v1Fixture.stopNotes,
    });
    assert.equal(projection.status, "paused");
    assert.equal(snapshotCommits(events).length, 0, "legacy v1 commits no stop snapshot");
    assert.equal(notesEvents(events).length, 0, "legacy v1 records no notes");
  } finally {
    await v1Fixture.close();
  }
  assert.equal(scripted.calls, 0, "legacy docs v1 never calls notes");
});

test("C3b: replay of the same stop never calls twice; the next stop can call again", async () => {
  const RUN = "run-c3b-replay";
  const scripted = new ScriptedNotesModel((call) => `Notes for the next tool, call ${call}.`);
  // An owner pause, not a repair-cycle gate: the owner's resume below is
  // authorized without a repair-cycle decision.
  const ownerPauseSeed = (runId: string): NewSchedulerEvent[] => pauseSeed(runId, "user");
  const fixture = await openFactoryPort("notes-replay", RUN, ownerPauseSeed, "plan_only", {
    modelsFor: modelsFor(scripted),
  });
  try {
    const first = await driveHandoff(fixture, RUN, { stopNotes: fixture.stopNotes });
    assert.equal(snapshotCommits(first.events).length, 1);
    assert.equal(notesEvents(first.events).length, 1);
    assert.equal(scripted.calls, 1);
    const firstBody = await stateBody(
      fixture,
      (snapshotCommits(first.events)[0]!.payload as Record<string, unknown>).commit as string,
    );
    assert.ok(firstBody.includes("call 1"));
    // Replaying the log records nothing new and makes no second call.
    const second = await driveHandoff(fixture, RUN, { stopNotes: fixture.stopNotes });
    assert.equal(snapshotCommits(second.events).length, 1, "replay records no duplicate snapshot");
    assert.equal(notesEvents(second.events).length, 1, "replay records no duplicate notes");
    assert.equal(scripted.calls, 1, "replay makes no second model call");
    // A new stop gets new notes.
    await resumeHandoff(fixture, RUN, "resume:c3b-replay");
    await pauseHandoff(fixture, RUN, "user", "pause:c3b-second", { stopNotes: fixture.stopNotes });
    const third = await driveHandoff(fixture, RUN, { stopNotes: fixture.stopNotes });
    assert.equal(snapshotCommits(third.events).length, 2, "the next stop commits anew");
    assert.equal(notesEvents(third.events).length, 2, "the next stop records new notes");
    assert.equal(scripted.calls, 2, "the next stop calls again");
    const bodies = await Promise.all(
      snapshotCommits(third.events).map((event) =>
        stateBody(fixture, (event.payload as Record<string, unknown>).commit as string),
      ),
    );
    assert.ok(bodies[0]!.includes("call 1"), "the first stop keeps its notes");
    assert.ok(bodies[1]!.includes("call 2"), "the second stop carries the new notes");
  } finally {
    await fixture.close();
  }
});

test("C3b: notes text is bounded, tool-free blocks stay out, and the prompt is fixed", () => {
  assert.equal(STOP_NOTES_MAX_LENGTH, HANDOFF_SNAPSHOT_NOTES_MAX_LENGTH, "one shared 2000-character bound");
  const long = "n".repeat(2500);
  const turn: ModelTurn = {
    blocks: [
      { type: "text", text: `  ${long}  ` },
      { type: "tool_call", callId: "c1", name: "run_evidence_command", arguments: {} },
    ],
    stopReason: "end_turn",
  };
  const notes = extractStopNotesText(turn);
  assert.equal(notes?.length, HANDOFF_SNAPSHOT_NOTES_MAX_LENGTH, "notes truncate to 2000 characters");
  assert.ok(!notes!.includes("run_evidence_command"), "tool access never leaks into the notes");
  assert.equal(extractStopNotesText({ blocks: [], stopReason: "end_turn" }), undefined, "empty turns have no notes");
  assert.equal(
    extractStopNotesText({ blocks: [{ type: "text", text: "   " }], stopReason: "end_turn" }),
    undefined,
    "blank text has no notes",
  );
  const facts = buildStopNotesFacts({
    runId: "run-c3b",
    stopKind: "paused",
    reason: `repair_cycle_limit\n# forged heading <!-- x -->${"y".repeat(300)}`,
    detail: "repair:external_blocker:owner must decide",
    taskCount: 3,
    planRevisionId: "revision_value",
  });
  assert.ok(!facts.includes("\n# forged heading"), "untrusted text cannot open its own line");
  assert.ok(!facts.includes("<!--"), "comment markers are neutralized");
  assert.ok(facts.length < 1200, "facts stay bounded");
  const messages = buildStopNotesMessages(facts);
  assert.equal(messages.length, 2, "a fixed two-message prompt");
  assert.equal(messages[0]!.role, "system");
  assert.equal(typeof messages[0]!.content, "string", "the system prompt is plain text");
  assert.ok((messages[0]!.content as string).includes("what to try next"), "the prompt asks for next steps");
  assert.equal(messages[1]!.content, facts, "the model sees only bounded facts");
});

test("C3b: the notes event is additive with Architect provenance and per-stop idempotence", () => {
  const runId = "run-c3b-notes-event";
  const base = asStored(runId, [
    ...v2PlanOnlySeed(runId),
    e(runId, "run.paused", "pause:repair", "runner", "build-runtime", { reason: "repair_cycle_limit" }),
  ]);
  const stopSequence = base.length;
  const noted: SchedulerEvent = {
    eventId: `${runId}-noted`,
    runId,
    sequence: stopSequence + 1,
    type: "handoff.notes_recorded",
    occurredAt: "2026-09-25T00:00:02.000Z",
    actor: { role: "architect", id: "arch:architect" },
    idempotencyKey: `handoff-notes:${stopSequence}`,
    payload: { stopSequence, notes: "Keep the value module." },
  };
  // Old logs replay unchanged: no notes, no markers, no throw.
  const legacy = rebuildSchedulerProjection(base);
  assert.equal(stopNotesForStop(legacy, stopSequence), undefined);
  assert.equal(stopNotesAttemptForStop(legacy, stopSequence), undefined);
  assert.equal(stopNotesFailureForStop(legacy, stopSequence), undefined);
  // Eligible positive: notes link to the existing repair-limit stop.
  const withNotes = rebuildSchedulerProjection([...base, noted]);
  assert.equal(stopNotesForStop(withNotes, stopSequence)?.notes, "Keep the value module.");
  assert.equal(stopNotesForStop(withNotes, stopSequence + 100), undefined, "other stops have no notes");
  // Markers link the same way: an attempt, then its failure outcome.
  const attempted: SchedulerEvent = {
    ...noted,
    eventId: `${runId}-attempted`,
    type: "handoff.notes_attempted",
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: `handoff-notes-attempt:${stopSequence}`,
    payload: { stopSequence, stopKind: "paused" },
  };
  const withAttempt = rebuildSchedulerProjection([...base, attempted]);
  assert.equal(stopNotesAttemptForStop(withAttempt, stopSequence)?.stopSequence, stopSequence);
  const failed: SchedulerEvent = {
    ...noted,
    eventId: `${runId}-failed`,
    sequence: stopSequence + 2,
    type: "handoff.notes_failed",
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: `handoff-notes-failed:${stopSequence}`,
    payload: { stopSequence, reason: "stop notes call failed (boom)" },
  };
  const withFailed = rebuildSchedulerProjection([...base, attempted, failed]);
  assert.equal(stopNotesFailureForStop(withFailed, stopSequence)?.reason, "stop notes call failed (boom)");
  // Provenance: only the Architect records notes (checked before anything else).
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        { ...noted, eventId: `${runId}-bad-actor`, actor: { role: "runner", id: "build-runtime" } },
      ]),
    /Only the Architect may record stop notes/,
  );
  // Provenance: the Architect actor names its runtime.
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        { ...noted, eventId: `${runId}-blank-actor`, actor: { role: "architect", id: "  " } },
      ]),
    /Architect runtime actor/,
  );
  // Links: future, non-stop and arbitrary sequences are refused.
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        {
          ...noted,
          eventId: `${runId}-future`,
          payload: { stopSequence: stopSequence + 100, notes: "Keep it." },
        },
      ]),
    /is not a stop/,
  );
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        { ...noted, eventId: `${runId}-nonstop`, payload: { stopSequence: 1, notes: "Keep it." } },
      ]),
    /is not a stop/,
  );
  // Links: a denied stop (cancel) refuses notes.
  const cancelId = `${runId}-cancel`;
  const cancelBase = asStored(cancelId, [
    ...v2PlanOnlySeed(cancelId),
    e(cancelId, "run.paused", "pause:cancel", "user", "local-user", { reason: "owner_cancelled" }),
  ]);
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...cancelBase,
        {
          ...noted,
          eventId: `${runId}-denied`,
          runId: cancelId,
          sequence: cancelBase.length + 1,
          idempotencyKey: `handoff-notes:${cancelBase.length}`,
          payload: { stopSequence: cancelBase.length, notes: "Keep it." },
        },
      ]),
    /does not allow stop notes/,
  );
  // Links: skipped stops (pre-triage, answered, export_only) refuse notes.
  const preId = `${runId}-pretriage`;
  const preTriageBase = asStored(preId, [
    seedEvent(preId, "project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }),
    seedEvent(preId, "run.paused", "pause:early", "runner", "build-runtime", { reason: "repair_cycle_limit" }),
  ]);
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...preTriageBase,
        {
          ...noted,
          eventId: `${runId}-pretriage`,
          runId: preId,
          sequence: 3,
          idempotencyKey: "handoff-notes:2",
          payload: { stopSequence: 2, notes: "Keep it." },
        },
      ]),
    /pre_triage/,
  );
  const ansId = `${runId}-answered`;
  const answeredBase = asStored(ansId, [
    ...v2AnsweredSeed(ansId),
    seedEvent(ansId, "run.paused", "pause:user", "user", "local-user", { reason: "user" }),
  ]);
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...answeredBase,
        {
          ...noted,
          eventId: `${runId}-answered`,
          runId: ansId,
          sequence: answeredBase.length + 1,
          idempotencyKey: `handoff-notes:${answeredBase.length}`,
          payload: { stopSequence: answeredBase.length, notes: "Keep it." },
        },
      ]),
    /answered_run/,
  );
  const expId = `${runId}-export`;
  const exportBase = asStored(expId, [
    ...withRunOptions(v2PlanOnlySeed(expId), { handoffFiles: "export_only" }),
    seedEvent(expId, "run.paused", "pause:user", "user", "local-user", { reason: "user" }),
  ]);
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...exportBase,
        {
          ...noted,
          eventId: `${runId}-export`,
          runId: expId,
          sequence: exportBase.length + 1,
          idempotencyKey: `handoff-notes:${exportBase.length}`,
          payload: { stopSequence: exportBase.length, notes: "Keep it." },
        },
      ]),
    /export_only/,
  );
  // Markers: only the runner records attempts and failures, with the stop's kind.
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        { ...attempted, eventId: `${runId}-attempt-actor`, actor: { role: "architect", id: "arch:architect" } },
      ]),
    /Only the runner may record a stop notes attempt/,
  );
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        {
          ...attempted,
          eventId: `${runId}-attempt-kind`,
          payload: { stopSequence, stopKind: "failed" },
        },
      ]),
    /does not match stop/,
  );
  // Markers: a failure needs its attempt first, and every terminal outcome is once.
  assert.throws(
    () => rebuildSchedulerProjection([...base, { ...failed, eventId: `${runId}-failed-lone`, sequence: stopSequence + 1 }]),
    /no stop notes attempt to fail/,
  );
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        attempted,
        { ...attempted, eventId: `${runId}-attempt-again`, sequence: stopSequence + 2 },
      ]),
    /already recorded/,
  );
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        noted,
        { ...attempted, eventId: `${runId}-attempt-late`, sequence: stopSequence + 2 },
      ]),
    /already has stop notes recorded/,
  );
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        attempted,
        failed,
        { ...noted, eventId: `${runId}-notes-late`, sequence: stopSequence + 3 },
      ]),
    /already has a failed stop notes attempt/,
  );
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        attempted,
        failed,
        { ...failed, eventId: `${runId}-failed-again`, sequence: stopSequence + 3 },
      ]),
    /already recorded/,
  );
  // Data: empty and overlong notes are refused.
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        { ...noted, eventId: `${runId}-blank`, payload: { stopSequence, notes: "  " } },
      ]),
    /Stop notes text is invalid/,
  );
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        { ...noted, eventId: `${runId}-long`, payload: { stopSequence, notes: "n".repeat(2001) } },
      ]),
    /Stop notes text is invalid/,
  );
  // Data: the failure reason must be present and bounded.
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        attempted,
        { ...failed, eventId: `${runId}-failed-long`, sequence: stopSequence + 2, payload: { stopSequence, reason: "r".repeat(501) } },
      ]),
    /failure reason is invalid/,
  );
  // Idempotence: the same stop never records twice.
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        noted,
        { ...noted, eventId: `${runId}-noted-again`, sequence: stopSequence + 2, idempotencyKey: `handoff-notes:${stopSequence}-again` },
      ]),
    /already recorded/,
  );
  // Docs v1 refuses notes.
  const v1Id = `${runId}-v1`;
  const v1Seed = v2PlanOnlySeed(v1Id).map((event) =>
    event.type === "project_docs.policy_configured" ? { ...event, payload: { version: 1 } } : event,
  );
  const v1base = asStored(v1Id, [
    ...v1Seed,
    e(v1Id, "run.paused", "pause:repair", "runner", "build-runtime", { reason: "repair_cycle_limit" }),
  ]);
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...v1base,
        {
          ...noted,
          eventId: `${runId}-v1-noted`,
          runId: v1Id,
          sequence: v1base.length + 1,
          idempotencyKey: `handoff-notes:${v1base.length}`,
          payload: { stopSequence: v1base.length, notes: "Keep it." },
        },
      ]),
    /policy version 2/,
  );
});

test("C3b: a repair-attempt exhausted pause still calls once and renders open repair work with notes", async () => {
  const RUN = "run-c3b-repair-budget";
  const scripted = new ScriptedNotesModel(() => NOTES_TEXT);
  // Local repair-attempt exhaustion: STOP_SNAPSHOT_TABLE and source C3
  // allow notes for this repair-limit stop while the run model budget remains.
  const seed = (runId: string): NewSchedulerEvent[] => [
    ...v2PlanOnlySeed(runId),
    e(runId, "repair.policy_configured", "repair-policy", "runner", "build-runtime", {
      repairPlanLimit: 1,
      explicit: true,
    }),
    e(runId, "repair.issue_recorded", "repair-issue", "runner", "delivery-review", {
      issueId: "issue-1",
      rootCause: "tests",
      limit: 1,
    }),
    e(runId, "repair.issue_paused", "repair-paused", "runner", "build-runtime", {
      issueId: "issue-1",
      cause: "budget_exhausted",
      detail: "Task T1 has no attempts remaining for tests.",
    }),
  ];
  const fixture = await openFactoryPort("notes-repair-budget", RUN, seed, "plan_only", {
    modelsFor: modelsFor(scripted),
  });
  try {
    const { events, projection } = await driveHandoff(fixture, RUN, { stopNotes: fixture.stopNotes });
    assert.equal(projection.status, "paused", "the stop proceeds");
    assert.equal(scripted.calls, 1, "local repair-attempt exhaustion still allows one notes call");
    const commits = snapshotCommits(events);
    assert.equal(commits.length, 1, "the snapshot still writes");
    const body = await stateBody(fixture, (commits[0]!.payload as Record<string, unknown>).commit as string);
    assert.ok(body.includes("repair_issue_paused:issue-1"), "the header names the repair stop");
    assert.ok(body.includes("REQ-1"), "the snapshot carries the open work");
    assert.ok(
      body.includes("> Next: keep the value module as is."),
      "the snapshot renders the Architect notes",
    );
    assert.ok(!body.includes("No Architect notes for this stop:"), "no no-notes line when notes exist");
    assert.equal(notesEvents(events).length, 1, "one additive notes event");
    assert.equal(notesAttemptEvents(events).length, 1, "one durable attempt marker");
    assert.equal(notesFailedEvents(events).length, 0, "no failure outcome");
  } finally {
    await fixture.close();
  }
});

test("C3b: a crash between the notes call and snapshot persistence never calls or charges twice", async () => {
  const RUN = "run-c3b-notes-crash";
  const scripted = new ScriptedNotesModel(() => NOTES_TEXT);
  const fixture = await openFactoryPort("notes-crash", RUN, repairLimitSeed, "plan_only", {
    modelsFor: modelsFor(scripted),
  });
  try {
    // Simulate a crash after the model call: the attempt marker persists,
    // but the notes, snapshot and skip appends never land.
    const storeProto = SqliteSchedulerStore.prototype;
    const origAppend = storeProto.append;
    const crashTypes = new Set([
      "handoff.notes_recorded",
      "project_docs.handoff_snapshot_committed",
      "project_docs.stop_snapshot_skipped",
    ]);
    storeProto.append = function (this: SqliteSchedulerStore, input: NewSchedulerEvent) {
      if (crashTypes.has(input.type)) throw new Error("Simulated crash before snapshot persistence.");
      return origAppend.call(this, input);
    };
    try {
      await driveHandoff(fixture, RUN, { stopNotes: fixture.stopNotes });
    } finally {
      storeProto.append = origAppend;
    }
    assert.equal(scripted.calls, 1, "the crashed run issued exactly one call");
    assert.deepEqual(architectModelCharges(fixture, RUN), { reserved: 1, settled: 1 }, "one charge stands");
    const crashed = readHandoffLog(fixture, RUN);
    assert.equal(notesAttemptEvents(crashed.events).length, 1, "only the attempt marker survived");
    assert.equal(notesEvents(crashed.events).length, 0, "no notes survived the crash");
    assert.equal(snapshotCommits(crashed.events).length, 0, "no snapshot survived the crash");
    // Restart: replay renders the no-notes line and snapshots, with no second call or charge.
    const { events } = await driveHandoff(fixture, RUN, { stopNotes: fixture.stopNotes });
    assert.equal(scripted.calls, 1, "replay issues no second call");
    assert.deepEqual(architectModelCharges(fixture, RUN), { reserved: 1, settled: 1 }, "replay adds no charge");
    assert.equal(snapshotCommits(events).length, 1, "replay still snapshots");
    assert.equal(notesEvents(events).length, 0, "replay records no notes");
    assert.equal(notesAttemptEvents(events).length, 1, "replay records no duplicate marker");
    const body = await stateBody(fixture, (snapshotCommits(events)[0]!.payload as Record<string, unknown>).commit as string);
    assert.ok(
      body.includes("No Architect notes for this stop: the stop notes attempt did not complete; no second call was made"),
      "replay renders the interrupted no-notes line",
    );
    assert.ok(!body.includes(NOTES_TEXT), "the interrupted snapshot carries no notes text");
  } finally {
    await fixture.close();
  }
});

test("C3b: a failed notes request persists its reason, and replay renders it with no second call", async () => {
  const RUN = "run-c3b-notes-failed-replay";
  const scripted = new ScriptedNotesModel(() => {
    throw new Error("Injected provider failure.");
  });
  const fixture = await openFactoryPort("notes-failed-replay", RUN, repairLimitSeed, "plan_only", {
    modelsFor: modelsFor(scripted),
  });
  try {
    // Crash after the failure outcome is recorded but before the snapshot:
    // the attempt marker and the failure reason persist.
    const storeProto = SqliteSchedulerStore.prototype;
    const origAppend = storeProto.append;
    const crashTypes = new Set([
      "project_docs.handoff_snapshot_committed",
      "project_docs.stop_snapshot_skipped",
    ]);
    storeProto.append = function (this: SqliteSchedulerStore, input: NewSchedulerEvent) {
      if (crashTypes.has(input.type)) throw new Error("Simulated crash before snapshot persistence.");
      return origAppend.call(this, input);
    };
    try {
      await driveHandoff(fixture, RUN, { stopNotes: fixture.stopNotes });
    } finally {
      storeProto.append = origAppend;
    }
    assert.equal(scripted.calls, 1, "the failed run issued exactly one call");
    const crashed = readHandoffLog(fixture, RUN);
    assert.equal(notesAttemptEvents(crashed.events).length, 1, "the attempt marker survived");
    const failures = notesFailedEvents(crashed.events);
    assert.equal(failures.length, 1, "the failure outcome survived");
    assert.ok(
      ((failures[0]!.payload as Record<string, unknown>).reason as string).includes("Injected provider failure."),
      "the persisted reason names the failure",
    );
    assert.equal(snapshotCommits(crashed.events).length, 0, "no snapshot survived the crash");
    // Restart: replay renders the persisted reason and snapshots, with no second call.
    const { events } = await driveHandoff(fixture, RUN, { stopNotes: fixture.stopNotes });
    assert.equal(scripted.calls, 1, "replay issues no second call");
    assert.equal(notesFailedEvents(events).length, 1, "replay records no duplicate failure");
    assert.equal(snapshotCommits(events).length, 1, "replay still snapshots");
    assert.equal(notesEvents(events).length, 0, "replay records no notes");
    const body = await stateBody(fixture, (snapshotCommits(events)[0]!.payload as Record<string, unknown>).commit as string);
    assert.ok(
      body.includes("No Architect notes for this stop: stop notes call failed (Injected provider failure.)"),
      "replay renders the persisted failure reason",
    );
  } finally {
    await fixture.close();
  }
});
