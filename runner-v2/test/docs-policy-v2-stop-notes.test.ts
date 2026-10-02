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
  STOP_NOTES_MAX_LENGTH,
  type NewSchedulerEvent,
  type SchedulerActorRole,
  type SchedulerEvent,
} from "../src/scheduler-store.js";
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
  const exportFixture = await openFactoryPort("notes-export", "run-c3b-export", repairLimitSeed, "plan_only", {
    ...forScripted,
    handoffFiles: "export_only",
  });
  try {
    const { events } = await driveHandoff(exportFixture, "run-c3b-export", {
      stopNotes: exportFixture.stopNotes,
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
  const fixture = await openFactoryPort("notes-replay", RUN, repairLimitSeed, "plan_only", {
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
  const base: SchedulerEvent[] = [
    {
      eventId: `${runId}-1`,
      runId,
      sequence: 1,
      type: "project_docs.policy_configured",
      occurredAt: "2026-09-25T00:00:00.000Z",
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "docs-policy",
      payload: { version: 2 },
    },
    {
      eventId: `${runId}-2`,
      runId,
      sequence: 2,
      type: "run.paused",
      occurredAt: "2026-09-25T00:00:01.000Z",
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "pause:repair",
      payload: { reason: "repair_cycle_limit" },
    },
  ];
  // Old logs replay unchanged: no notes, no throw.
  const legacy = rebuildSchedulerProjection(base);
  assert.equal(stopNotesForStop(legacy, 2), undefined);
  const noted: SchedulerEvent = {
    eventId: `${runId}-3`,
    runId,
    sequence: 3,
    type: "handoff.notes_recorded",
    occurredAt: "2026-09-25T00:00:02.000Z",
    actor: { role: "architect", id: "arch:architect" },
    idempotencyKey: "handoff-notes:2",
    payload: { stopSequence: 2, notes: "Keep the value module." },
  };
  const withNotes = rebuildSchedulerProjection([...base, noted]);
  assert.equal(stopNotesForStop(withNotes, 2)?.notes, "Keep the value module.");
  assert.equal(stopNotesForStop(withNotes, 99), undefined, "other stops have no notes");
  // Provenance: only the Architect records notes.
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        { ...noted, eventId: `${runId}-4`, actor: { role: "runner", id: "build-runtime" } },
      ]),
    /Only the Architect may record stop notes/,
  );
  // Data: empty and overlong notes are refused.
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        { ...noted, eventId: `${runId}-4`, payload: { stopSequence: 2, notes: "  " } },
      ]),
    /Stop notes text is invalid/,
  );
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        { ...noted, eventId: `${runId}-4`, payload: { stopSequence: 2, notes: "n".repeat(2001) } },
      ]),
    /Stop notes text is invalid/,
  );
  // Idempotence: the same stop never records twice.
  assert.throws(
    () =>
      rebuildSchedulerProjection([
        ...base,
        noted,
        { ...noted, eventId: `${runId}-4`, sequence: 4, idempotencyKey: "handoff-notes:2-again" },
      ]),
    /already recorded/,
  );
  // Docs v1 refuses notes.
  const v1base = base.map((event, index) =>
    index === 0
      ? { ...event, payload: { version: 1 } }
      : event,
  );
  assert.throws(
    () => rebuildSchedulerProjection([...v1base, { ...noted, sequence: 3 }]),
    /policy version 2/,
  );
});

test("C3b: a repair-budget exhausted pause overrides the allowed classification and makes no call", async () => {
  const RUN = "run-c3b-repair-budget";
  const scripted = new ScriptedNotesModel(() => NOTES_TEXT);
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
    assert.equal(scripted.calls, 0, "exhausted repair budget makes no model call");
    const commits = snapshotCommits(events);
    assert.equal(commits.length, 1, "the snapshot still writes");
    const body = await stateBody(fixture, (commits[0]!.payload as Record<string, unknown>).commit as string);
    assert.ok(
      body.includes("No Architect notes for this stop: the repair budget is exhausted; no budget remains for a notes call"),
      "the snapshot names the budget override",
    );
    assert.equal(notesEvents(events).length, 0, "no notes event");
  } finally {
    await fixture.close();
  }
});
