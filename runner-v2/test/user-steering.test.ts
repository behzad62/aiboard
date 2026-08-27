import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rebuildSchedulerProjection, type NewSchedulerEvent } from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

const RUN_ID = "run_user_steering";
const USER = { role: "user" as const, id: "local-user" };
const ARCHITECT = { role: "architect" as const, id: "architect-1" };

test("P3.1 durable guidance is idempotent, versioned, acknowledged once, and preserves objective bytes", () => {
  withStore((store, database) => {
    initialize(store, "Build\nexactly\tthis application.");
    const guidance = append(store, "user.guidance_submitted", USER, "guidance:one", {
      guidanceId: "guidance-1",
      text: "Use the blue account flow.",
      version: 1,
    });
    const duplicate = append(store, "user.guidance_submitted", USER, "guidance:one", {
      guidanceId: "guidance-1",
      text: "Use the blue account flow.",
      version: 1,
    });
    assert.equal(duplicate.eventId, guidance.eventId);
    assert.equal(store.readRun(RUN_ID).filter((event) => event.type === "user.guidance_submitted").length, 1);
    assert.throws(() => append(store, "user.guidance_submitted", USER, "guidance:one", {
      guidanceId: "guidance-1",
      text: "Use the red account flow.",
      version: 1,
    }), /idempotency conflict/i);

    append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:ack", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
      acknowledgement: "The next plan review will incorporate this.",
    });
    assert.throws(() => append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:ack:duplicate", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
      acknowledgement: "Second acknowledgement is forbidden.",
    }), /already acknowledged/i);
    append(store, "user.guidance_submitted", USER, "guidance:two", {
      guidanceId: "guidance-2",
      text: "Also retain the accessible contrast mode.",
      version: 2,
    });
    assert.throws(() => append(store, "user.guidance_submitted", USER, "guidance:out-of-order", {
      guidanceId: "guidance-3",
      text: "This skips a version.",
      version: 4,
    }), /version must advance/i);
    assert.equal(existsSync(`${database}-wal`), true);

    store.close();
    const reopened = new SqliteSchedulerStore(database);
    const projection = rebuildSchedulerProjection(reopened.readRun(RUN_ID));
    assert.equal(projection.initialObjective, "Build\nexactly\tthis application.");
    assert.equal(projection.userGuidance["guidance-1"].version, 1);
    assert.equal(projection.userGuidance["guidance-1"].status, "acknowledged");
    assert.equal(projection.userGuidance["guidance-1"].acknowledgement, "The next plan review will incorporate this.");
    assert.equal(projection.userGuidanceVersion, 2);
    assert.equal(projection.userGuidance["guidance-2"].status, "submitted");
    reopened.close();
  });
});

test("P3.1 Architect questions block in projection and only the user may answer their exact open version", () => {
  withStore((store) => {
    initialize(store, "Build the requested application.");
    append(store, "architect.question_requested", ARCHITECT, "question:one", {
      questionId: "question-1",
      question: "Which payment provider should we use?",
      version: 1,
    });
    const open = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(open.architectQuestions["question-1"].status, "open");
    assert.equal(open.blockingArchitectQuestionId, "question-1");
    assert.equal(open.architectQuestionVersion, 1);

    assert.throws(() => append(store, "architect.question_answered", ARCHITECT, "question:wrong-authority", {
      questionId: "question-1", expectedVersion: 1, answer: "Provider A.",
    }), /only the user/i);
    assert.throws(() => append(store, "architect.question_answered", USER, "question:stale", {
      questionId: "question-1", expectedVersion: 2, answer: "Provider A.",
    }), /version is 1, not 2/i);
    append(store, "architect.question_answered", USER, "question:answer", {
      questionId: "question-1", expectedVersion: 1, answer: "Provider A.",
    });
    assert.throws(() => append(store, "architect.question_answered", USER, "question:duplicate", {
      questionId: "question-1", expectedVersion: 1, answer: "Provider A.",
    }), /not open/i);
    assert.throws(() => append(store, "architect.question_answered", USER, "question:conflict", {
      questionId: "question-1", expectedVersion: 1, answer: "Provider B.",
    }), /not open/i);
    const answered = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(answered.architectQuestions["question-1"].status, "answered");
    assert.equal(answered.architectQuestions["question-1"].answer, "Provider A.");
    assert.equal(answered.blockingArchitectQuestionId, undefined);
    append(store, "architect.question_requested", ARCHITECT, "question:two", {
      questionId: "question-2",
      question: "Which region should be the initial default?",
      version: 2,
    });
  });
});

test("P3.1 rejects malformed and authority-bypass steering events atomically", () => {
  withStore((store) => {
    initialize(store, "Immutable objective.");
    const before = store.readRun(RUN_ID).length;
    assert.throws(() => append(store, "user.guidance_submitted", ARCHITECT, "guidance:bad-authority", {
      guidanceId: "guidance-1", text: "A user note.", version: 1,
    }), /only the user/i);
    assert.throws(() => append(store, "user.guidance_submitted", USER, "guidance:malformed", {
      guidanceId: "guidance-1", text: "A user note.", version: 2, objective: "replacement",
    }), /version must advance|unknown/i);
    assert.throws(() => append(store, "architect.question_requested", USER, "question:bad-authority", {
      questionId: "question-1", question: "Bad", version: 1,
    }), /only the architect/i);
    assert.equal(store.readRun(RUN_ID).length, before);
    const projection = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(projection.initialObjective, "Immutable objective.");
    assert.deepEqual(projection.userGuidance, {});
    assert.deepEqual(projection.architectQuestions, {});
  });
});

function initialize(store: SqliteSchedulerStore, objective: string): void {
  append(store, "run.initialized", { role: "runner", id: "runner" }, "initialized", { objective });
}

function append(
  store: SqliteSchedulerStore,
  type: NewSchedulerEvent["type"],
  actor: NewSchedulerEvent["actor"],
  idempotencyKey: string,
  payload: Record<string, unknown>,
) {
  return store.append({
    runId: RUN_ID,
    type,
    occurredAt: "2026-08-27T00:00:00.000Z",
    actor,
    idempotencyKey,
    payload,
  });
}

function withStore(run: (store: SqliteSchedulerStore, database: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "aiboard-user-steering-"));
  const database = join(root, "scheduler.sqlite");
  let store: SqliteSchedulerStore | undefined;
  try {
    store = new SqliteSchedulerStore(database);
    run(store, database);
  } finally {
    if (store) {
      try { store.close(); } catch { /* test may intentionally close it */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
}
